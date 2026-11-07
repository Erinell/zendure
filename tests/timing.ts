import { appendFile, mkdir } from "node:fs/promises";
import { CONFIG } from "../config";
import { HistoryDatabase, formatLocalDateTime } from "../src/database";
import { BatteryClient } from "../src/devices/battery";
import { LinkyClient } from "../src/devices/linky";
import { SolarClient } from "../src/devices/solar";
import { errorMessage, log, setLogLevel } from "../src/logger";

setLogLevel("info");

interface Sample {
  ts: string;
  local: string;
  ms: number;
  phase: string;
  phaseStartedAt: number;
  grid2: number;
  grid1: number;
  grid3: number;
  gridTotal: number;
  pv: number;
  pvAgeSec: number;
  soc: number;
  acMode: number;
  cmdIn: number;
  cmdOut: number;
  actualOut: number;
  actualIn: number;
  signed: number;
  packState: number;
  packPower: number;
  acStatus: number;
  writeRsp: number;
}

interface PhaseEvent {
  phase: string;
  mode: "charge" | "discharge" | "standby";
  powerW: number;
  commandAt: number;
  latencyMs: number;
}

interface PhaseResult {
  phase: string;
  mode: PhaseEvent["mode"];
  targetW: number;
  httpLatencyMs: number;
  onsetMs: number | null;
  fullMs: number | null;
  steadyW: number;
  maxW: number;
  gridBeforeW: number;
  gridAfterW: number;
  pvW: number;
  socBefore: number;
  socAfter: number;
}

const battery = new BatteryClient(CONFIG.battery);
const linky = new LinkyClient(CONFIG.linky);
const solar = new SolarClient(CONFIG.solar);
const historyDb = new HistoryDatabase(CONFIG.database.history);

const nowSlug = new Date().toISOString().replace(/[:.]/g, "-");
const jsonlPath = `data/timing-${nowSlug}.jsonl`;
const summaryPath = `data/timing-summary-${nowSlug}.json`;

await mkdir("data", { recursive: true });

let phase = "initialisation";
let phaseStartedAt = Date.now();
let lastSolarSnapshot: Awaited<ReturnType<SolarClient["getSnapshot"]>> | null = null;
let lastSolarAt = 0;
let lastDbLogAt = 0;
const samples: Sample[] = [];
const events: PhaseEvent[] = [];

async function takeSample(): Promise<Sample> {
  const [batteryReport, linkySnapshot] = await Promise.all([
    battery.getReport(),
    linky.getSnapshot(),
  ]);
  if (Date.now() - lastSolarAt >= 5_000) {
    try {
      lastSolarSnapshot = await solar.getSnapshot();
      lastSolarAt = Date.now();
    } catch (error) {
      log.warn(`Lecture solaire impossible: ${errorMessage(error)}`);
    }
  }

  const p = batteryReport.snapshot;
  const s: Sample = {
    ts: new Date().toISOString(),
    local: formatLocalDateTime(new Date()),
    ms: Date.now(),
    phase,
    phaseStartedAt,
    grid2: linkySnapshot.controlW,
    grid1: linkySnapshot.values.SINSTS1 ?? 0,
    grid3: linkySnapshot.values.SINSTS3 ?? 0,
    gridTotal: linkySnapshot.totalW,
    pv: lastSolarSnapshot?.productionW ?? 0,
    pvAgeSec: lastSolarSnapshot ? Math.round(lastSolarSnapshot.ageMs / 1000) : -1,
    soc: p.socPercent,
    acMode: p.acMode,
    cmdIn: p.inputLimitW,
    cmdOut: p.outputLimitW,
    actualOut: p.outputW,
    actualIn: p.inputW,
    signed: BatteryClient.actualPowerW(p),
    packState: p.packState,
    packPower: p.packPowerW,
    acStatus: batteryReport.report.properties.acStatus ?? 0,
    writeRsp: batteryReport.report.properties.writeRsp,
  };

  samples.push(s);
  await appendFile(jsonlPath, `${JSON.stringify(s)}\n`, "utf8");

  console.log(
    `${s.local.slice(11, 19)} ${s.phase.padEnd(18)} S2=${String(s.grid2).padStart(4)} ` +
      `PV=${String(s.pv).padStart(4)} SOC=${String(s.soc).padStart(3)}% ` +
      `cmd=${s.acMode === 1 ? "C" : "D"}${String(s.cmdIn || s.cmdOut).padStart(4)} ` +
      `out=${String(s.actualOut).padStart(4)} in=${String(s.actualIn).padStart(4)} ` +
      `signé=${String(s.signed).padStart(5)} pack=${String(s.packPower).padStart(5)}`,
  );

  if (Date.now() - lastDbLogAt >= CONFIG.database.history.intervalMs) {
    lastDbLogAt = Date.now();
    await historyDb.log({
      consoW: linkySnapshot.logW,
      powerW: s.signed,
      solarW: s.pv,
      socPercent: s.soc,
    });
  }

  return s;
}

async function sendCommand(
  name: string,
  mode: PhaseEvent["mode"],
  powerW: number,
): Promise<void> {
  const started = performance.now();
  if (mode === "charge") await battery.setCharge(powerW);
  else if (mode === "discharge") await battery.setDischarge(powerW);
  else await battery.standby(false);

  const latencyMs = Math.round(performance.now() - started);
  const event: PhaseEvent = {
    phase: name,
    mode,
    powerW,
    commandAt: Date.now(),
    latencyMs,
  };
  events.push(event);
  log.info(
    `Commande ${name}: ${mode} ${powerW} W, HTTP ${latencyMs} ms (l'effet réel arrive après ~15-18 s)`,
  );
}

async function runPhase(
  name: string,
  seconds: number,
  command?: () => Promise<void>,
): Promise<void> {
  phase = name;
  phaseStartedAt = Date.now();
  console.log(`\n--- ${name} ---`);
  if (command) await command();

  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    const started = Date.now();
    try {
      await takeSample();
    } catch (error) {
      log.warn(`Échantillon impossible: ${errorMessage(error)}`);
    }
    await Bun.sleep(Math.max(0, 1_000 - (Date.now() - started)));
  }
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function analyze(): PhaseResult[] {
  const results: PhaseResult[] = [];

  for (const event of events) {
    if (event.mode === "standby") continue;

    const phaseSamples = samples.filter((s) => s.phase === event.phase);
    const afterCommand = phaseSamples.filter((s) => s.ms >= event.commandAt);
    if (afterCommand.length === 0) continue;

    const sign = event.mode === "charge" ? -1 : 1;
    const magnitude = (sample: Sample) => Math.max(0, sign * sample.signed);
    const onsetThreshold = Math.max(20, event.powerW * 0.1);
    const fullThreshold = event.powerW * 0.9;

    const onsetSample = afterCommand.find((s) => magnitude(s) >= onsetThreshold);
    const fullSample = afterCommand.find((s) => magnitude(s) >= fullThreshold);
    // La consigne est envoyée au début de la phase : on cherche les mesures
    // "avant" dans toutes les phases, pas seulement dans la phase courante.
    const beforeCommand = samples.filter(
      (s) => s.ms < event.commandAt && s.ms >= event.commandAt - 3_000,
    );
    const activeSamples = afterCommand.filter(
      (s) => magnitude(s) >= Math.max(20, event.powerW * 0.2),
    );
    const steadySamples =
      activeSamples.length >= 3 ? activeSamples.slice(-5) : afterCommand.slice(-5);

    results.push({
      phase: event.phase,
      mode: event.mode,
      targetW: event.powerW,
      httpLatencyMs: event.latencyMs,
      onsetMs: onsetSample ? onsetSample.ms - event.commandAt : null,
      fullMs: fullSample ? fullSample.ms - event.commandAt : null,
      steadyW: Math.round(average(steadySamples.map(magnitude))),
      maxW: Math.round(Math.max(...afterCommand.map(magnitude))),
      gridBeforeW: Math.round(average(beforeCommand.map((s) => s.grid2))),
      gridAfterW: Math.round(average(steadySamples.map((s) => s.grid2))),
      pvW: Math.round(average(steadySamples.map((s) => s.pv))),
      socBefore: beforeCommand.at(-1)?.soc ?? phaseSamples[0]?.soc ?? 0,
      socAfter: afterCommand.at(-1)?.soc ?? 0,
    });
  }

  return results;
}

function printSummary(results: PhaseResult[]): void {
  console.log("\n════════════════════════════════════════════════════════════════════════");
  console.log(" Synthèse des timings mesurés");
  console.log("════════════════════════════════════════════════════════════════════════");
  console.log(
    "Phase".padEnd(20) +
      "Consigne".padStart(9) +
      "Départ".padStart(9) +
      "90 %".padStart(9) +
      "Moy. fin".padStart(10) +
      "S2 av/apr".padStart(13) +
      "SOC".padStart(10),
  );
  for (const r of results) {
    const onset = r.onsetMs === null ? "-" : `${(r.onsetMs / 1000).toFixed(1)} s`;
    const full = r.fullMs === null ? "-" : `${(r.fullMs / 1000).toFixed(1)} s`;
    console.log(
      r.phase.padEnd(20) +
        `${r.targetW} W`.padStart(9) +
        onset.padStart(9) +
        full.padStart(9) +
        `${r.steadyW} W`.padStart(10) +
        `${r.gridBeforeW}/${r.gridAfterW}`.padStart(13) +
        `${r.socBefore}→${r.socAfter}%`.padStart(10),
    );
  }
  console.log("\nLes temps de démarrage incluent la latence interne de la batterie (~15-18 s).");
  console.log("Le démarrage dépend de l'état interne : ~16 s depuis la veille, parfois autant pour un changement de sens.");
  console.log(`Détail seconde par seconde: ${jsonlPath}`);
  console.log(`Synthèse JSON: ${summaryPath}`);
}

let exitCode = 0;

try {
  log.info("=== Test de timing batterie (durée ~3 min, énergie très faible) ===");
  const initial = await battery.getReport();
  const soc = initial.snapshot.socPercent;
  log.info(
    `SOC initial: ${soc}% | charge max ${initial.snapshot.hardwareMaxChargeW} W | ` +
      `sortie max ${initial.snapshot.hardwareMaxDischargeW} W`,
  );
  if (soc < 25 || soc > 95) {
    throw new Error(`SOC ${soc}% hors de la plage de sécurité 25-95% pour ce test`);
  }
  const canCharge = soc <= 90;
  const canDischarge = soc >= 30;

  await runPhase("repos", 8);

  if (canCharge) {
    await runPhase("charge 100W", 25, () => sendCommand("charge 100W", "charge", 100));
    await runPhase("charge 300W", 20, () => sendCommand("charge 300W", "charge", 300));
    await runPhase("charge 600W", 20, () => sendCommand("charge 600W", "charge", 600));
    await runPhase("standby", 8, () => sendCommand("standby", "standby", 0));
  } else {
    log.warn("SOC trop haut: phases de charge ignorées.");
  }

  if (canDischarge) {
    await runPhase("décharge 100W", 25, () => sendCommand("décharge 100W", "discharge", 100));
    await runPhase("décharge 300W", 20, () => sendCommand("décharge 300W", "discharge", 300));
    await runPhase("standby", 8, () => sendCommand("standby", "standby", 0));
  } else {
    log.warn("SOC trop bas: phases de décharge ignorées.");
  }

  if (canCharge && canDischarge) {
    await runPhase("charge 300W #2", 20, () => sendCommand("charge 300W #2", "charge", 300));
    await runPhase("transition D300", 15, () => sendCommand("transition D300", "discharge", 300));
    await runPhase("transition C300", 15, () => sendCommand("transition C300", "charge", 300));
  }

  await runPhase("standby final", 10, () => sendCommand("standby final", "standby", 0));
} catch (error) {
  exitCode = 1;
  log.error(`Test interrompu: ${errorMessage(error)}`);
} finally {
  console.log("\n--- ARRÊT : standby persistant ---");
  try {
    await battery.standby(true);
    await Bun.sleep(CONFIG.battery.statusReadDelayMs);
    const final = await battery.getReport();
    log.info("État final batterie", {
      soc: `${final.snapshot.socPercent}%`,
      acMode: final.snapshot.acMode,
      inputLimit: `${final.snapshot.inputLimitW} W`,
      outputLimit: `${final.snapshot.outputLimitW} W`,
      sortie: `${final.snapshot.outputW} W`,
      entrée: `${final.snapshot.inputW} W`,
      smartMode: final.snapshot.smartMode,
    });
    if (final.snapshot.inputLimitW !== 0 || final.snapshot.outputLimitW !== 0) {
      log.error("Le standby final n'a pas été confirmé !");
      exitCode = 1;
    }
  } catch (error) {
    log.error(`Échec du standby final: ${errorMessage(error)}`);
    exitCode = 1;
  }

  const results = analyze();
  printSummary(results);
  await Bun.write(
    summaryPath,
    JSON.stringify({ generatedAt: new Date().toISOString(), events, results, samples: samples.length }, null, 2),
  );
  await historyDb.close();
  log.info(`Terminé. ${samples.length} échantillons, ${events.length} commandes.`);
  process.exit(exitCode);
}
