import { fetchJson } from "../http";
import type { SolarConfig, SolarResponse, SolarSnapshot } from "../interfaces";

/**
 * Client de l'API de production Enphase/Envoy.
 *
 * On utilise production[0].wNow (total des panneaux). L'API est mise à jour
 * environ toutes les 5 minutes : elle sert de garde-fou pour la charge,
 * pas de retour rapide. Le retour rapide est SINSTS2 (Linky).
 */
export class SolarClient {
  constructor(private readonly config: SolarConfig) {}

  async getSnapshot(): Promise<SolarSnapshot> {
    const response = await fetchJson<SolarResponse>(this.config.url, {
      timeoutMs: this.config.requestTimeoutMs,
    });

    if (!response || !Array.isArray(response.production) || response.production.length === 0) {
      throw new Error("Réponse panneaux invalide: 'production' absent ou vide");
    }

    const production =
      response.production.find((entry) => entry?.type === "inverters") ?? response.production[0];
    if (!production) {
      throw new Error("Réponse panneaux invalide: aucune production exploitable");
    }

    const rawPower = typeof production.wNow === "number" ? production.wNow : Number(production.wNow);
    const productionW = Number.isFinite(rawPower) ? Math.max(0, rawPower) : 0;
    const readingTime = typeof production.readingTime === "number" ? production.readingTime : Number(production.readingTime);
    const measuredAt =
      Number.isFinite(readingTime) && readingTime > 0 ? readingTime * 1_000 : Date.now();
    const ageMs = Math.max(0, Date.now() - measuredAt);
    const stale = ageMs > this.config.maxDataAgeMs;

    return {
      fetchedAt: Date.now(),
      measuredAt,
      ageMs,
      stale,
      productionW,
    };
  }
}
