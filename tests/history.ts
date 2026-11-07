import { SQL } from "bun";
import { CONFIG } from "../config";
import { formatLocalDateTime } from "../src/database";
import { log, setLogLevel } from "../src/logger";

setLogLevel("info");

/** Ne jamais afficher les identifiants ou l'hôte MySQL dans une erreur. */
function safeError(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    return `erreur MySQL (code ${String((error as { code: unknown }).code)}); vérifier MYSQL_* dans .env`;
  }
  return "erreur inattendue (détails masqués)";
}

interface StatsRow {
  n: number;
  dmin: Date | string | null;
  dmax: Date | string | null;
  vavg: number | null;
  vmin: number | null;
  vmax: number | null;
}

function asDate(value: Date | string | null): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function percent(value: number, total: number): string {
  if (total <= 0) return "0 %";
  return `${((value / total) * 100).toFixed(1)} %`;
}

async function main(): Promise<void> {
  log.info("=== Analyse des historiques (lecture seule) ===");

  const batteryConfig = CONFIG.database.history;
  const batterySql = new SQL(
    `mysql://${batteryConfig.user}:${batteryConfig.password}` +
      `@${batteryConfig.host}:${batteryConfig.port}/${batteryConfig.database}`,
    { connectionTimeout: batteryConfig.connectTimeoutMs },
  );

  try {
    log.info("--- Base batteries : dernières 24 h ---");
    // Les dates sont stockées en heure locale : on utilise la même convention.
    const cutoff24h = formatLocalDateTime(new Date(Date.now() - 24 * 3_600_000));
    for (const table of ["conso", "power", "solar", "soc"]) {
      const stats = await batterySql`
        SELECT COUNT(*) AS n,
               MIN(Date) AS dmin,
               MAX(Date) AS dmax,
               AVG(Valeur) AS vavg,
               MIN(Valeur) AS vmin,
               MAX(Valeur) AS vmax
        FROM ${batterySql(table)}
        WHERE Date >= ${cutoff24h}`;
      const row = stats[0] as StatsRow;
      log.info(`Table ${table}`, {
        lignes: Number(row.n),
        début: row.dmin,
        fin: row.dmax,
        moyenneW: row.vavg === null ? null : Math.round(Number(row.vavg)),
        minW: row.vmin === null ? null : Number(row.vmin),
        maxW: row.vmax === null ? null : Number(row.vmax),
      });
    }

    // Énergie sur 24 h à partir des échantillons de 10 s (intégration par pas de temps réel).
    const powerRows = (await batterySql`
      SELECT Date, Valeur FROM power
      WHERE Date >= ${cutoff24h}
      ORDER BY Date`) as Array<{ Date: Date; Valeur: number }>;
    const solarRows = (await batterySql`
      SELECT Date, Valeur FROM solar
      WHERE Date >= ${cutoff24h}
      ORDER BY Date`) as Array<{ Date: Date; Valeur: number }>;

    function integrate(rows: Array<{ Date: Date; Valeur: number }>): {
      wh: number;
      chargeWh: number;
      dischargeWh: number;
      durationHours: number;
    } {
      let wh = 0;
      let chargeWh = 0;
      let dischargeWh = 0;
      for (let i = 1; i < rows.length; i++) {
        const previous = asDate(rows[i - 1]!.Date);
        const current = asDate(rows[i]!.Date);
        if (!previous || !current) continue;
        const hours = (current.getTime() - previous.getTime()) / 3_600_000;
        if (hours <= 0 || hours > 0.1) continue; // ignore les trous > 6 min
        const energy = Number(rows[i - 1]!.Valeur) * hours;
        wh += energy;
        if (energy < 0) chargeWh += -energy;
        else dischargeWh += energy;
      }
      const first = rows.length > 0 ? asDate(rows[0]!.Date) : null;
      const last = rows.length > 0 ? asDate(rows[rows.length - 1]!.Date) : null;
      return {
        wh,
        chargeWh,
        dischargeWh,
        durationHours:
          first && last ? (last.getTime() - first.getTime()) / 3_600_000 : 0,
      };
    }

    const powerEnergy = integrate(powerRows);
    const solarEnergy = integrate(solarRows);
    log.info("Bilan batterie sur la fenêtre", {
      chargeKWh: (powerEnergy.chargeWh / 1000).toFixed(2),
      dechargeKWh: (powerEnergy.dischargeWh / 1000).toFixed(2),
      netKWh: (powerEnergy.wh / 1000).toFixed(2),
      dureeH: powerEnergy.durationHours.toFixed(1),
    });
    log.info("Bilan solaire sur la fenêtre", {
      productionKWh: (solarEnergy.wh / 1000).toFixed(2),
      dureeH: solarEnergy.durationHours.toFixed(1),
    });

    const lastPower = await batterySql`SELECT Date, Valeur FROM power ORDER BY Date DESC LIMIT 8`;
    const lastSolar = await batterySql`SELECT Date, Valeur FROM solar ORDER BY Date DESC LIMIT 8`;
    const lastConso = await batterySql`SELECT Date, Valeur FROM conso ORDER BY Date DESC LIMIT 8`;
    const lastSoc = await batterySql`SELECT Date, Valeur FROM soc ORDER BY Date DESC LIMIT 8`;
    log.info("Dernières valeurs batterie (négatif = charge, positif = décharge)", lastPower);
    log.info("Dernières valeurs solaires", lastSolar);
    log.info("Dernières valeurs Linky (SINSTS2, phase 2)", lastConso);
    log.info("Dernières valeurs SOC batterie (%)", lastSoc);
  } finally {
    await batterySql.close();
  }

  // Base historique panneaux : lecture seule, jamais d'écriture.
  const solarConfig = CONFIG.database.solarHistory;
  const solarSql = new SQL(
    `mysql://${solarConfig.user}:${solarConfig.password}` +
      `@${solarConfig.host}:${solarConfig.port}/${solarConfig.database}`,
    { connectionTimeout: solarConfig.connectTimeoutMs },
  );

  try {
    log.info("--- Base panneaux : production des 7 derniers jours (PINST, pas de 5 min) ---");
    const cutoff7d = formatLocalDateTime(new Date(Date.now() - 7 * 86_400_000));
    const rows = (await solarSql`
      SELECT Date, Valeur FROM PINST
      WHERE Date >= ${cutoff7d}
      ORDER BY Date`) as Array<{ Date: Date; Valeur: unknown }>;

    const days = new Map<
      string,
      { samples: number; peakW: number; sumW: number; first: Date | null; last: Date | null }
    >();

    for (const row of rows) {
      const date = asDate(row.Date);
      if (!date) continue;
      const values =
        typeof row.Valeur === "string"
          ? (JSON.parse(row.Valeur) as Record<string, number>)
          : (row.Valeur as Record<string, number>);
      const totalW = Object.values(values).reduce((sum, value) => sum + Number(value), 0);
      const day = date.toISOString().slice(0, 10);
      const entry = days.get(day) ?? {
        samples: 0,
        peakW: 0,
        sumW: 0,
        first: null,
        last: null,
      };
      entry.samples += 1;
      entry.peakW = Math.max(entry.peakW, totalW);
      entry.sumW += totalW;
      if (!entry.first || date < entry.first) entry.first = date;
      if (!entry.last || date > entry.last) entry.last = date;
      days.set(day, entry);
    }

    console.log(
      "Date".padEnd(12) +
        "Échantillons".padStart(13) +
        "Pic".padStart(9) +
        "Énergie".padStart(11) +
        "Première".padStart(11) +
        "Dernière".padStart(11),
    );
    for (const [day, entry] of [...days.entries()].sort()) {
      const energyKWh = (entry.sumW * (5 / 60)) / 1000;
      console.log(
        day.padEnd(12) +
          String(entry.samples).padStart(13) +
          `${entry.peakW} W`.padStart(9) +
          `${energyKWh.toFixed(2)} kWh`.padStart(11) +
          (entry.first ? entry.first.toISOString().slice(11, 16) : "-").padStart(11) +
          (entry.last ? entry.last.toISOString().slice(11, 16) : "-").padStart(11),
      );
    }

    const last = (await solarSql`
      SELECT Date, Valeur FROM PINST ORDER BY Date DESC LIMIT 1`) as Array<{
      Date: Date;
      Valeur: unknown;
    }>;
    if (last[0]) {
      const values =
        typeof last[0].Valeur === "string"
          ? (JSON.parse(last[0].Valeur) as Record<string, number>)
          : (last[0].Valeur as Record<string, number>);
      const total = Object.values(values).reduce((sum, value) => sum + Number(value), 0);
      log.info("Dernière mesure PINST", {
        date: last[0].Date,
        totalW: total,
        panneaux: Object.keys(values).length,
        partMax: percent(Math.max(...Object.values(values).map(Number)), total),
      });
    }
  } finally {
    await solarSql.close();
  }

  log.info("Analyse terminée (aucune écriture effectuée).");
  process.exit(0);
}

try {
  await main();
} catch (error) {
  log.error(`Analyse impossible: ${safeError(error)}`);
  process.exit(1);
}
