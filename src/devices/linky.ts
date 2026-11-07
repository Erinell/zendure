import { fetchJson } from "../http";
import type {
  LinkyConfig,
  LinkyEntry,
  LinkyResponse,
  LinkySnapshot,
} from "../interfaces";

function parseLinkyValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Client de l'API du compteur Linky.
 *
 * Le champ de régulation est SINSTS2 (phase 2, celle de la batterie et des panneaux).
 * SINSTS2 = 0 signifie que la phase 2 n'importe pas : soit elle est équilibrée,
 * soit les panneaux produisent plus que la consommation de cette phase.
 */
export class LinkyClient {
  constructor(private readonly config: LinkyConfig) {}

  async getSnapshot(): Promise<LinkySnapshot> {
    const response = await fetchJson<LinkyResponse>(this.config.url, {
      timeoutMs: this.config.requestTimeoutMs,
    });

    if (!response || !Array.isArray(response.data)) {
      throw new Error("Réponse Linky invalide: tableau 'data' absent");
    }

    const values: Record<string, number> = {};
    for (const entry of response.data as LinkyEntry[]) {
      if (entry && typeof entry.Nom === "string") {
        values[entry.Nom] = parseLinkyValue(entry.Valeur);
      }
    }

    const controlW = values[this.config.controlField];
    if (controlW === undefined) {
      throw new Error(`Champ Linky "${this.config.controlField}" absent de la réponse`);
    }

    const totalW =
      values.SINSTS ??
      (values.SINSTS1 ?? 0) + (values.SINSTS2 ?? 0) + (values.SINSTS3 ?? 0);
    const logW = values[this.config.logField] ?? totalW;
    const firstDate = response.data.find((entry) => typeof entry?.Date === "string")?.Date;
    const measuredAt = firstDate ? Date.parse(firstDate) : Date.now();
    const fallbackAgeMs = Number.isFinite(measuredAt) ? Math.max(0, Date.now() - measuredAt) : 0;
    const metaAgeMs =
      typeof response.meta?.ageSeconds === "number" ? Math.max(0, response.meta.ageSeconds * 1_000) : fallbackAgeMs;
    const ageMs = Math.max(0, metaAgeMs);
    const stale = response.meta?.stale === true || ageMs > this.config.maxDataAgeMs;

    return {
      fetchedAt: Date.now(),
      measuredAt: Number.isFinite(measuredAt) ? measuredAt : Date.now(),
      ageMs,
      stale,
      values,
      controlW,
      logW,
      totalW,
    };
  }
}
