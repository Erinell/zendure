import type {
  BatteryReport,
  BatteryWriteResponse,
  LocalApiConfig,
} from "./interfaces";
import type { BatteryWritableProperties } from "./devices/battery";
import { errorMessage, log } from "./logger";

export interface LocalApiOptions {
  config: LocalApiConfig;
  serialNumber: string;
  /** Au-delà de cet âge, le rapport est signalé comme périmé (mais reste servi). */
  cacheMaxAgeMs: number;
  getReport: () => BatteryReport | null;
  getCacheAgeMs: () => number | null;
  write: (properties: BatteryWritableProperties) => Promise<BatteryWriteResponse>;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const ALLOWED_WRITE_KEYS: Array<keyof BatteryWritableProperties> = [
  "acMode",
  "inputLimit",
  "outputLimit",
  "smartMode",
  "minSoc",
  "socSet",
];

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...CORS_HEADERS,
      ...headers,
    },
  });
}

/**
 * API locale en cache.
 *
 * Elle reprend les mêmes chemins et la même structure JSON que l'API zenSDK
 * de la batterie, mais :
 *  - GET /properties/report ne contacte jamais la batterie : il sert le dernier
 *    rapport reçu par le programme ;
 *  - POST /properties/write est optionnel (config.allowWrite) et passe par le
 *    même client batterie sérialisé que le contrôleur.
 *
 * Plusieurs clients (Grafana, navigateur, curl…) peuvent donc interroger cette
 * API sans multiplier les connexions vers la batterie.
 */
export class LocalApiServer {
  private server: ReturnType<typeof Bun.serve> | null = null;

  constructor(private readonly options: LocalApiOptions) {}

  start(): void {
    if (!this.options.config.enabled || this.server) return;

    this.server = Bun.serve({
      hostname: this.options.config.host,
      port: this.options.config.port,
      fetch: (request) => this.handle(request),
    });

    const mode = this.options.config.allowWrite ? "lecture/écriture" : "lecture seule";
    log.info(
      `API locale en cache: http://${this.options.config.host}:${this.server.port}` +
        `/properties/report (${mode}).`,
    );
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await server.stop(true);
  }

  get port(): number {
    return this.server?.port ?? 0;
  }

  private async handle(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const pathname = new URL(request.url).pathname;

    if (pathname === "/properties/report") {
      if (request.method !== "GET") {
        return jsonResponse({ error: "Method not allowed", code: 405 }, 405);
      }
      return this.reportResponse();
    }

    if (pathname === "/properties/write") {
      if (request.method !== "POST") {
        return jsonResponse({ error: "Method not allowed", code: 405 }, 405);
      }
      return this.writeResponse(request);
    }

    return jsonResponse({ error: "Not found", code: 404 }, 404);
  }

  private reportResponse(): Response {
    const report = this.options.getReport();
    if (!report) {
      return jsonResponse(
        { error: "Aucun rapport batterie en cache", code: 503 },
        503,
      );
    }

    const ageMs = this.options.getCacheAgeMs();
    const stale = ageMs === null || ageMs > this.options.cacheMaxAgeMs;

    return jsonResponse(report, 200, {
      "X-Battery-Cache-Age-Ms": String(ageMs ?? -1),
      "X-Battery-Cache-Stale": String(stale),
    });
  }

  private async writeResponse(request: Request): Promise<Response> {
    if (!this.options.config.allowWrite) {
      return jsonResponse(
        { error: "Écriture via l'API locale désactivée", code: 403 },
        403,
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "JSON invalide", code: 400 }, 400);
    }

    if (!body || typeof body !== "object") {
      return jsonResponse({ error: "Corps JSON invalide", code: 400 }, 400);
    }

    const payload = body as { sn?: unknown; properties?: unknown };
    if (payload.sn !== this.options.serialNumber) {
      return jsonResponse({ error: "Numéro de série invalide", code: 401 }, 401);
    }
    if (!payload.properties || typeof payload.properties !== "object") {
      return jsonResponse({ error: "Propriété 'properties' absente", code: 400 }, 400);
    }

    const source = payload.properties as Record<string, unknown>;
    const properties: Record<string, number> = {};
    for (const key of ALLOWED_WRITE_KEYS) {
      const value = source[key];
      if (typeof value === "number" && Number.isFinite(value)) {
        properties[key] = value;
      }
    }

    if (Object.keys(properties).length === 0) {
      return jsonResponse({ error: "Aucune propriété inscriptible", code: 400 }, 400);
    }

    try {
      const response = await this.options.write(properties as BatteryWritableProperties);
      return jsonResponse(response, 200);
    } catch (error) {
      return jsonResponse(
        { error: errorMessage(error), code: 502 },
        502,
      );
    }
  }
}
