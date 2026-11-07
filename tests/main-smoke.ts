import { CONFIG } from "../config";
import { BatteryClient } from "../src/devices/battery";
import { errorMessage, log, setLogLevel } from "../src/logger";

setLogLevel("info");

/**
 * Smoke test de bout en bout :
 *  - lance le vrai programme avec un arrêt automatique après 45 s ;
 *  - vérifie que l'arrêt appelle bien le standby persistant ;
 *  - relit la batterie après l'arrêt et vérifie que charge/décharge sont à zéro.
 *
 * Durée : ~50 s. La batterie peut décharger quelques watts-heure pendant le test,
 * ce qui est négligeable (SOC 45 % au moment de l'écriture).
 */
const durationSeconds = 45;
const outputLimit = 120_000;

log.info(`=== Smoke test : lancement du programme réel pendant ${durationSeconds} s ===`);

const child = Bun.spawn(
  [process.execPath, "run", "src/main.ts", `--stop-after-seconds=${durationSeconds}`],
  {
    cwd: process.cwd(),
    env: { ...process.env, FORCE_COLOR: "0" },
    stdout: "pipe",
    stderr: "pipe",
  },
);

const stdoutPromise = new Response(child.stdout).text();
const stderrPromise = new Response(child.stderr).text();

const timeout = Bun.sleep(outputLimit).then(() => "timeout" as const);
const result = await Promise.race([child.exited, timeout]);

if (result === "timeout") {
  child.kill();
  log.error(`Le programme n'a pas terminé dans les ${outputLimit / 1000} s.`);
  process.exit(1);
}

const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
const lines = `${stdout}\n${stderr}`.trim().split(/\r?\n/);
console.log("\n--- Dernières lignes du programme ---");
console.log(lines.slice(-40).join("\n"));
console.log("--- Fin des logs ---\n");

let ok = result === 0;
if (!ok) log.error(`Code de sortie du programme: ${result}`);

if (!stdout.includes("Arrêt automatique dans")) {
  ok = false;
  log.error("La demande d'arrêt automatique n'apparaît pas dans les logs.");
}
if (!stdout.includes("Standby persistant envoyé")) {
  ok = false;
  log.error("Le standby persistant n'apparaît pas dans les logs.");
}

// Laisse à la batterie le temps de retomber à zéro après le standby.
await Bun.sleep(4_000);

const battery = new BatteryClient(CONFIG.battery);
try {
  const { snapshot: p } = await battery.getReport();
  log.info("État batterie après arrêt", {
    soc: `${p.socPercent}%`,
    acMode: p.acMode,
    inputLimit: `${p.inputLimitW} W`,
    outputLimit: `${p.outputLimitW} W`,
    sortie: `${p.outputW} W`,
    entrée: `${p.inputW} W`,
    smartMode: p.smartMode,
  });

  if (p.inputLimitW !== 0 || p.outputLimitW !== 0) {
    ok = false;
    log.error("Les limites de charge/décharge ne sont pas à zéro après l'arrêt.");
  }
  if (p.outputW > 10 || p.inputW > 10) {
    ok = false;
    log.error("La batterie consomme ou injecte encore plus de 10 W après l'arrêt.");
  }
} catch (error) {
  ok = false;
  log.error(`Lecture batterie après arrêt impossible: ${errorMessage(error)}`);
}

log.info(ok ? "=== Smoke test OK : arrêt propre confirmé ===" : "=== Smoke test ÉCHEC ===");
process.exit(ok ? 0 : 1);
