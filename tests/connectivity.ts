import { SQL } from "bun";
import { CONFIG } from "../config";
import { HistoryDatabase } from "../src/database";
import { BatteryClient } from "../src/devices/battery";
import { LinkyClient } from "../src/devices/linky";
import { SolarClient } from "../src/devices/solar";
import { errorMessage, log, setLogLevel } from "../src/logger";

setLogLevel("info");

let allOk = true;

function check(ok: boolean, label: string, detail?: unknown): void {
  if (!ok) allOk = false;
  log.info(`${ok ? "OK  " : "ÉCHEC"} ${label}`, detail);
}

async function main(): Promise<void> {
  log.info("=== Test de connectivité (lecture seule, aucune commande) ===");

  const battery = new BatteryClient(CONFIG.battery);
  try {
    const { snapshot: p, report } = await battery.getReport();
    check(report.sn === CONFIG.battery.serialNumber, "Numéro de série batterie (BATTERY_SERIAL)");
    check(!p.fault, "Batterie sans défaut", {
      fault: p.fault,
      gridState: p.gridState,
      dataReady: p.dataReady,
    });
    log.info("Batterie", {
      produit: report.product,
      soc: `${p.socPercent}%`,
      acMode: p.acMode,
      inputLimit: `${p.inputLimitW} W`,
      outputLimit: `${p.outputLimitW} W`,
      sortie: `${p.outputW} W`,
      entrée: `${p.inputW} W`,
      chargeMax: `${p.hardwareMaxChargeW} W`,
      dechargeMax: `${p.hardwareMaxDischargeW} W`,
      minSoc: `${p.minSocRaw / 10}%`,
      socSet: `${p.socSetRaw / 10}%`,
      packState: p.packState,
      packPower: `${p.packPowerW} W`,
    });
  } catch (error) {
    check(false, "Batterie", errorMessage(error));
  }

  const linky = new LinkyClient(CONFIG.linky);
  try {
    const l = await linky.getSnapshot();
    check(!l.stale, "Mesure Linky fraîche", {
      ageMs: l.ageMs,
      controlField: CONFIG.linky.controlField,
      controlW: l.controlW,
    });
    log.info("Linky", {
      SINSTS_total: `${l.totalW} W`,
      SINSTS1: `${l.values.SINSTS1 ?? "?"} W`,
      SINSTS2: `${l.values.SINSTS2 ?? "?"} W`,
      SINSTS3: `${l.values.SINSTS3 ?? "?"} W`,
      logField: CONFIG.linky.logField,
      valeurStockeeConso: `${l.logW} W`,
      date: new Date(l.measuredAt).toISOString(),
      ageSeconds: Math.round(l.ageMs / 1000),
    });
  } catch (error) {
    check(false, "Linky", errorMessage(error));
  }

  const solar = new SolarClient(CONFIG.solar);
  try {
    const s = await solar.getSnapshot();
    check(!s.stale, "Mesure solaire fraîche", {
      ageMs: s.ageMs,
      productionW: s.productionW,
    });
    log.info("Solaire", {
      wNow: `${s.productionW} W`,
      ageSeconds: Math.round(s.ageMs / 1000),
      stale: s.stale,
    });
  } catch (error) {
    check(false, "Solaire", errorMessage(error));
  }

  // Base de visualisation (lecture)
  const historyDb = new HistoryDatabase(CONFIG.database.history);
  try {
    check(await historyDb.check(), "Base batteries accessible");
    const sql = new SQL(
      `mysql://${CONFIG.database.history.user}:${CONFIG.database.history.password}` +
        `@${CONFIG.database.history.host}:${CONFIG.database.history.port}/${CONFIG.database.history.database}`,
      { connectionTimeout: CONFIG.database.history.connectTimeoutMs },
    );
    for (const table of ["conso", "power", "solar", "soc"]) {
      const rows = await sql`SELECT COUNT(*) AS n, MAX(Date) AS lastDate FROM ${sql(table)}`;
      log.info(`Table ${table}`, rows[0]);
    }
    await sql.close();
  } catch {
    check(false, "Base batteries", "vérifier MYSQL_* dans .env (détails masqués)");
  } finally {
    await historyDb.close();
  }

  // Base historique panneaux (lecture seule, aucune modification)
  const solarDbConfig = CONFIG.database.solarHistory;
  const solarSql = new SQL(
    `mysql://${solarDbConfig.user}:${solarDbConfig.password}` +
      `@${solarDbConfig.host}:${solarDbConfig.port}/${solarDbConfig.database}`,
    { connectionTimeout: solarDbConfig.connectTimeoutMs },
  );
  try {
    const rows = await solarSql`SELECT COUNT(*) AS n, MAX(Date) AS lastDate FROM PINST`;
    log.info("Base panneaux (lecture seule)", rows[0]);
    const last = await solarSql`SELECT Date, Valeur FROM PINST ORDER BY Date DESC LIMIT 1`;
    const row = last[0] as { Date?: Date | string; Valeur?: unknown } | undefined;
    if (row?.Valeur) {
      const values =
        typeof row.Valeur === "string"
          ? (JSON.parse(row.Valeur) as Record<string, number>)
          : (row.Valeur as Record<string, number>);
      const sum = Object.values(values).reduce((total, value) => total + Number(value), 0);
      log.info("Dernière ligne PINST", {
        date: row.Date,
        panneaux: Object.keys(values).length,
        totalW: sum,
      });
    }
    check(true, "Base panneaux accessible");
  } catch {
    check(false, "Base panneaux", "vérifier MYSQL_* dans .env (détails masqués)");
  } finally {
    await solarSql.close();
  }

  log.info(allOk ? "=== Tous les contrôles sont OK ===" : "=== Au moins un contrôle a échoué ===");
  process.exit(allOk ? 0 : 1);
}

await main();
