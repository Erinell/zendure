import { appendFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { LocalHistoryConfig } from "./interfaces";
import { errorMessage, log } from "./logger";

/**
 * Historique local JSONL, une ligne par échantillon (1 s par défaut).
 *
 * Désactivé par défaut dans config.ts pour éviter l'usure inutile de la carte SD.
 * Utile pour analyser finement les timings et le comportement du contrôleur.
 */
export class LocalHistory {
  private lastErrorLogAt = 0;
  private initialized = false;

  constructor(private readonly config: LocalHistoryConfig) {}

  private fileName(date = new Date()): string {
    const pad = (value: number) => String(value).padStart(2, "0");
    return `history-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.jsonl`;
  }

  async init(): Promise<void> {
    if (!this.config.enabled) return;
    await mkdir(this.config.directory, { recursive: true });
    await this.prune();
    this.initialized = true;
  }

  async record(sample: Record<string, unknown>): Promise<void> {
    if (!this.config.enabled || !this.initialized) return;
    try {
      await appendFile(
        join(this.config.directory, this.fileName()),
        `${JSON.stringify(sample)}\n`,
        "utf8",
      );
    } catch (error) {
      const now = Date.now();
      if (now - this.lastErrorLogAt > 60_000) {
        this.lastErrorLogAt = now;
        log.warn(`Historique local impossible: ${errorMessage(error)}`);
      }
    }
  }

  private async prune(): Promise<void> {
    try {
      const cutoff = Date.now() - this.config.retentionDays * 86_400_000;
      const files = await readdir(this.config.directory);
      for (const file of files) {
        if (!file.startsWith("history-") || !file.endsWith(".jsonl")) continue;
        const path = join(this.config.directory, file);
        const info = await stat(path);
        if (info.mtimeMs < cutoff) {
          await unlink(path);
          log.info(`Ancien historique supprimé: ${path}`);
        }
      }
    } catch (error) {
      log.warn(`Purge de l'historique local impossible: ${errorMessage(error)}`);
    }
  }
}
