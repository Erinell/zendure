import { SQL } from "bun";
import type { HistoryDatabaseConfig, HistoryValues } from "./interfaces";
import { log } from "./logger";

/** Formate une date en heure locale, au format accepté par les colonnes DATETIME(6). */
export function formatLocalDateTime(date: Date): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.` +
    `${pad(date.getMilliseconds(), 3)}`
  );
}

/**
 * Écrit les valeurs de visualisation dans la base `batteries`.
 *
 * Tables :
 *  - conso (Date, Valeur) : puissance Linky de la phase 2 (SINSTS2), en W ;
 *  - power (Date, Valeur) : batterie, négatif = charge, positif = décharge ;
 *  - solar (Date, Valeur) : production PV totale (wNow), en W ;
 *  - soc (Date, Valeur) : niveau de charge de la batterie, en %.
 *
 * Une ligne par table toutes les 10 s, purge au-delà de 24 h.
 * En cas d'erreur, le contrôle continue : la visualisation n'est pas critique.
 */
export class HistoryDatabase {
  private sql: SQL | null = null;
  private lastErrorLogAt = 0;
  private lastCleanupAt = 0;
  private busy = false;

  constructor(private readonly config: HistoryDatabaseConfig) {}

  private connection(): SQL {
    if (this.sql) return this.sql;
    const url =
      `mysql://${encodeURIComponent(this.config.user)}:` +
      `${encodeURIComponent(this.config.password)}@` +
      `${this.config.host}:${this.config.port}/${this.config.database}`;
    this.sql = new SQL(url, { connectionTimeout: this.config.connectTimeoutMs });
    return this.sql;
  }

  /** Vérifie que la base et les tables de visualisation sont accessibles. Ne bloque pas le démarrage. */
  async check(): Promise<boolean> {
    if (!this.config.enabled) return true;
    try {
      const sql = this.connection();
      await sql`SELECT 1 AS ok FROM conso LIMIT 1`;
      await sql`SELECT 1 AS ok FROM power LIMIT 1`;
      await sql`SELECT 1 AS ok FROM solar LIMIT 1`;
      await sql`SELECT 1 AS ok FROM soc LIMIT 1`;
      log.info(`Base ${this.config.database} accessible (conso, power, solar, soc).`);
      return true;
    } catch (error) {
      this.reportError("Vérification base de visualisation impossible", error);
      await this.reset();
      return false;
    }
  }

  /** Insère un échantillon. Ignore les valeurs indisponibles. */
  async log(values: HistoryValues): Promise<void> {
    if (!this.config.enabled) return;
    if (this.busy) return; // ne pas empiler les écritures si la base est lente
    this.busy = true;

    try {
      const sql = this.connection();
      const date = formatLocalDateTime(new Date());

      if (values.consoW !== null) {
        await sql`INSERT INTO conso (Date, Valeur) VALUES (${date}, ${Math.round(values.consoW)})`;
      }
      if (values.powerW !== null) {
        await sql`INSERT INTO power (Date, Valeur) VALUES (${date}, ${Math.round(values.powerW)})`;
      }
      if (values.solarW !== null) {
        await sql`INSERT INTO solar (Date, Valeur) VALUES (${date}, ${Math.round(values.solarW)})`;
      }
      if (values.socPercent !== null) {
        await sql`INSERT INTO soc (Date, Valeur) VALUES (${date}, ${Math.round(values.socPercent)})`;
      }

      if (Date.now() - this.lastCleanupAt >= this.config.cleanupIntervalMs) {
        await this.cleanup(sql);
        this.lastCleanupAt = Date.now();
      }
    } catch (error) {
      this.reportError("Écriture base de visualisation impossible", error);
      await this.reset();
    } finally {
      this.busy = false;
    }
  }

  private async cleanup(sql: SQL): Promise<void> {
    const cutoff = formatLocalDateTime(
      new Date(Date.now() - this.config.retentionHours * 3_600_000),
    );
    await sql`DELETE FROM conso WHERE Date < ${cutoff}`;
    await sql`DELETE FROM power WHERE Date < ${cutoff}`;
    await sql`DELETE FROM solar WHERE Date < ${cutoff}`;
    await sql`DELETE FROM soc WHERE Date < ${cutoff}`;
    log.debug(`Purge des données de plus de ${this.config.retentionHours} h effectuée.`);
  }

  private reportError(message: string, error: unknown): void {
    const now = Date.now();
    if (now - this.lastErrorLogAt < 60_000) return;
    this.lastErrorLogAt = now;
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code: unknown }).code)
        : "inconnu";
    log.warn(`${message} (code ${code}); vérifier MYSQL_* dans .env.`);
  }

  private async reset(): Promise<void> {
    const current = this.sql;
    this.sql = null;
    if (!current) return;
    try {
      await current.close();
    } catch {
      // La connexion est déjà inutilisable : rien à faire.
    }
  }

  async close(): Promise<void> {
    const current = this.sql;
    this.sql = null;
    if (!current) return;
    try {
      await current.close();
    } catch {
      log.warn("Fermeture base de visualisation: erreur (détails masqués).");
    }
  }
}
