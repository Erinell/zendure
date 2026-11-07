import { CONFIG } from "../config";
import { BatteryController } from "./controller";
import { HistoryDatabase, formatLocalDateTime } from "./database";
import { BatteryClient, BatterySerialMismatchError } from "./devices/battery";
import { LinkyClient } from "./devices/linky";
import { SolarClient } from "./devices/solar";
import { LocalHistory } from "./local-history";
import { errorMessage, log, setLogLevel } from "./logger";
import type {
  BatterySnapshot,
  CommandMode,
  ControlDecision,
  HistoryValues,
  LinkySnapshot,
  SolarSnapshot,
} from "./interfaces";

interface SensorState<T> {
  value: T | null;
  fetchedAt: number;
  lastError: string | null;
  consecutiveErrors: number;
}

function emptySensor<T>(): SensorState<T> {
  return { value: null, fetchedAt: 0, lastError: null, consecutiveErrors: 0 };
}

function validateConfig(): void {
  const { battery, control, linky, solar, database } = CONFIG;

  if (battery.minSocPercent < 0 || battery.minSocPercent > 50) {
    throw new Error("battery.minSocPercent doit être compris entre 0 et 50");
  }
  if (battery.maxSocPercent < 70 || battery.maxSocPercent > 100) {
    throw new Error("battery.maxSocPercent doit être compris entre 70 et 100");
  }
  if (battery.minSocPercent >= battery.maxSocPercent) {
    throw new Error("battery.minSocPercent doit être inférieur à battery.maxSocPercent");
  }
  if (battery.maxChargePowerW <= 0 || battery.maxChargePowerW > battery.hardwareMaxChargePowerW) {
    throw new Error("battery.maxChargePowerW invalide ou supérieur à la limite matérielle");
  }
  if (
    battery.maxDischargePowerW <= 0 ||
    battery.maxDischargePowerW > battery.hardwareMaxDischargePowerW
  ) {
    throw new Error("battery.maxDischargePowerW invalide ou supérieur à la limite matérielle");
  }
  if (battery.maxDischargePowerW > 800) {
    throw new Error("battery.maxDischargePowerW dépasse la limite du SolarFlow 800 Plus");
  }
  if (control.tickIntervalMs <= 0 || linky.pollIntervalMs <= 0 || solar.pollIntervalMs <= 0) {
    throw new Error("Les intervalles de lecture doivent être positifs");
  }
  if (database.history.retentionHours <= 0) {
    throw new Error("database.history.retentionHours doit être positif");
  }
}

async function main(): Promise<void> {
  const dryRun = CONFIG.dryRun || process.argv.includes("--dry-run");
  const verbose = process.argv.includes("--verbose");
  const stopAfterArg = process.argv.find((arg) => arg.startsWith("--stop-after-seconds="));
  const stopAfterSeconds = stopAfterArg
    ? Number.parseFloat(stopAfterArg.split("=")[1] ?? "")
    : 0;
  setLogLevel(verbose ? "debug" : CONFIG.logging.level);

  validateConfig();

  log.info("════════════════════════════════════════════════════════════");
  log.info(" Contrôleur batterie Zendure SolarFlow 800 Plus");
  log.info("════════════════════════════════════════════════════════════");
  log.info(
    `Batterie SolarFlow 800 Plus | ` +
      `SOC ${CONFIG.battery.minSocPercent}-${CONFIG.battery.maxSocPercent}% | ` +
      `charge max ${CONFIG.battery.maxChargePowerW} W | décharge max ${CONFIG.battery.maxDischargePowerW} W`,
  );
  const usableWh =
    ((CONFIG.battery.maxSocPercent - CONFIG.battery.minSocPercent) / 100) *
    CONFIG.battery.capacityWh;
  log.info(
    `Énergie utile ${Math.round(usableWh)} Wh, autonomie théorique ~` +
      `${(usableWh / CONFIG.battery.maxDischargePowerW).toFixed(1)} h à ` +
      `${CONFIG.battery.maxDischargePowerW} W`,
  );
  log.info(`Linky configuré (URL masquée; régulation ${CONFIG.linky.controlField})`);
  log.info("Solaire configuré (URL masquée).");
  if (dryRun) {
    log.warn("MODE DRY-RUN : lecture seule, aucune commande ne sera envoyée à la batterie.");
  }

  const battery = new BatteryClient(CONFIG.battery);
  const linky = new LinkyClient(CONFIG.linky);
  const solar = new SolarClient(CONFIG.solar);
  const historyDb = new HistoryDatabase(CONFIG.database.history);
  const localHistory = new LocalHistory(CONFIG.localHistory);
  const controller = new BatteryController({
    config: CONFIG.control,
    minSocPercent: CONFIG.battery.minSocPercent,
    maxSocPercent: CONFIG.battery.maxSocPercent,
    maxChargeW: CONFIG.battery.maxChargePowerW,
    maxDischargeW: CONFIG.battery.maxDischargePowerW,
  });

  let running = true;
  let shuttingDown = false;
  let controlLoopPromise: Promise<void> | null = null;
  let lastDecision: ControlDecision | null = null;

  let linkyState: SensorState<LinkySnapshot> = emptySensor();
  let batteryState: SensorState<BatterySnapshot> = emptySensor();
  let solarState: SensorState<SolarSnapshot> = emptySensor();

  async function sendStandbyPersistent(): Promise<void> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await battery.standby(true);
        log.info(`Standby persistant envoyé (tentative ${attempt}).`);
        await Bun.sleep(CONFIG.battery.statusReadDelayMs);
        const result = await battery.getReport();
        const p = result.snapshot;
        log.info(
          `Batterie après standby: acMode=${p.acMode}, inputLimit=${p.inputLimitW} W, ` +
            `outputLimit=${p.outputLimitW} W, sortie=${p.outputW} W, entrée=${p.inputW} W, SOC=${p.socPercent}%`,
        );
        if (p.inputLimitW === 0 && p.outputLimitW === 0) {
          return;
        }
        log.warn("La batterie n'a pas confirmé les limites à zéro, nouvelle tentative...");
      } catch (error) {
        log.error(`Échec du standby (tentative ${attempt}/3): ${errorMessage(error)}`);
      }
    }
    log.error("Impossible de confirmer le standby de la batterie.");
  }

  async function shutdown(signal: string, exitCode = 0): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    running = false;
    log.info(`Arrêt demandé (${signal}).`);

    // On laisse la boucle de contrôle terminer sa commande éventuelle avant le standby.
    if (controlLoopPromise) {
      try {
        await Promise.race([controlLoopPromise, Bun.sleep(5_000)]);
      } catch {
        // La boucle est déjà terminée.
      }
    }

    if (!dryRun) {
      await sendStandbyPersistent();
    } else {
      log.info("DRY-RUN : aucune commande de standby envoyée.");
    }

    await historyDb.close();
    log.info("Arrêt terminé.");
    process.exit(exitCode);
  }

  process.on("SIGINT", () => {
    void shutdown("SIGINT", 0);
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM", 0);
  });
  process.on("uncaughtException", (error) => {
    log.error(`Exception non gérée: ${errorMessage(error)}`);
    void shutdown("uncaughtException", 1);
  });
  process.on("unhandledRejection", (reason) => {
    log.error(`Rejet non géré: ${errorMessage(reason)}`);
    void shutdown("unhandledRejection", 1);
  });

  try {
    try {
      await localHistory.init();
    } catch (error) {
      // L'historique local est un diagnostic : son échec ne doit pas arrêter le contrôle.
      log.warn(`Historique local désactivé: ${errorMessage(error)}`);
    }
    await historyDb.check();

    // ── Démarrage sécurisé de la batterie ──────────────────────────────────
    let initial;
    try {
      initial = await battery.getReport();
    } catch (error) {
      if (error instanceof BatterySerialMismatchError) {
        log.error(error.message);
        log.error("Arrêt immédiat : aucune commande ne sera envoyée à un appareil inconnu.");
        process.exit(1);
      }
      log.error(`Batterie inaccessible au démarrage: ${errorMessage(error)}`);
      await shutdown("batterie inaccessible", 1);
      return;
    }

    const p = initial.snapshot;
    log.info(
      `Batterie détectée: ${p.socPercent}% | acMode=${p.acMode} | ` +
        `limites ${p.inputLimitW}/${p.outputLimitW} W | ` +
        `matériel charge max ${p.hardwareMaxChargeW} W, sortie max ${p.hardwareMaxDischargeW} W | ` +
        `gridState=${p.gridState} | dataReady=${p.dataReady} | fault=${p.fault}`,
    );
    if (p.fault) {
      log.warn("La batterie signale un défaut ou n'est pas connectée au réseau : le contrôle restera en standby.");
    }

    if (!dryRun) {
      // Première commande : standby persistant, pour effacer un éventuel état laissé
      // par une exécution précédente interrompue.
      await sendStandbyPersistent();
      const limitsWritten = await battery.ensureSocLimits(initial.snapshot);
      if (limitsWritten) {
        log.info(
          `Limites SOC écrites: min=${CONFIG.battery.minSocPercent}%, max=${CONFIG.battery.maxSocPercent}%.`,
        );
      }
    }

    // ── Boucles de lecture ─────────────────────────────────────────────────
    const linkyLoop = (async () => {
      while (running) {
        const startedAt = Date.now();
        try {
          const value = await linky.getSnapshot();
          linkyState = { value, fetchedAt: Date.now(), lastError: null, consecutiveErrors: 0 };
          log.debug(
            `Linky: S2=${value.controlW} W, SINSTS=${value.totalW} W, âge=${Math.round(value.ageMs / 1000)} s`,
          );
        } catch (error) {
          linkyState = {
            ...linkyState,
            lastError: errorMessage(error),
            consecutiveErrors: linkyState.consecutiveErrors + 1,
          };
          if (
            linkyState.consecutiveErrors === 1 ||
            linkyState.consecutiveErrors % 10 === 0
          ) {
            log.warn(`Lecture Linky impossible (${linkyState.consecutiveErrors}): ${linkyState.lastError}`);
          }
        }
        await Bun.sleep(Math.max(0, CONFIG.linky.pollIntervalMs - (Date.now() - startedAt)));
      }
    })().catch((error) => {
      log.error(`Boucle Linky arrêtée: ${errorMessage(error)}`);
    });

    const batteryLoop = (async () => {
      while (running) {
        const startedAt = Date.now();
        try {
          const result = await battery.getReport();
          batteryState = {
            value: result.snapshot,
            fetchedAt: Date.now(),
            lastError: null,
            consecutiveErrors: 0,
          };
          log.debug(
            `Batterie: SOC=${result.snapshot.socPercent}%, out=${result.snapshot.outputW} W, ` +
              `in=${result.snapshot.inputW} W, acMode=${result.snapshot.acMode}`,
          );
        } catch (error) {
          batteryState = {
            ...batteryState,
            lastError: errorMessage(error),
            consecutiveErrors: batteryState.consecutiveErrors + 1,
          };
          if (
            batteryState.consecutiveErrors === 1 ||
            batteryState.consecutiveErrors % 10 === 0
          ) {
            log.warn(
              `Lecture batterie impossible (${batteryState.consecutiveErrors}): ${batteryState.lastError}`,
            );
          }
        }
        await Bun.sleep(Math.max(0, CONFIG.battery.pollIntervalMs - (Date.now() - startedAt)));
      }
    })().catch((error) => {
      log.error(`Boucle batterie arrêtée: ${errorMessage(error)}`);
    });

    const solarLoop = (async () => {
      while (running) {
        const startedAt = Date.now();
        try {
          const value = await solar.getSnapshot();
          solarState = { value, fetchedAt: Date.now(), lastError: null, consecutiveErrors: 0 };
          log.debug(
            `Solaire: ${value.productionW} W, âge=${Math.round(value.ageMs / 1000)} s, stale=${value.stale}`,
          );
        } catch (error) {
          solarState = {
            ...solarState,
            lastError: errorMessage(error),
            consecutiveErrors: solarState.consecutiveErrors + 1,
          };
          if (
            solarState.consecutiveErrors === 1 ||
            solarState.consecutiveErrors % 10 === 0
          ) {
            log.warn(
              `Lecture solaire impossible (${solarState.consecutiveErrors}): ${solarState.lastError}`,
            );
          }
        }
        await Bun.sleep(Math.max(0, CONFIG.solar.pollIntervalMs - (Date.now() - startedAt)));
      }
    })().catch((error) => {
      log.error(`Boucle solaire arrêtée: ${errorMessage(error)}`);
    });

    // ── Boucle de contrôle ─────────────────────────────────────────────────
    controlLoopPromise = (async () => {
      let lastCommand: { mode: CommandMode; powerW: number } = { mode: "standby", powerW: 0 };
      let lastCommandAt = 0;
      let lastCommandOk = true;
      let lastDecisionSignature = "";
      let lastStatusAt = 0;

      while (running) {
        const tickStartedAt = Date.now();
        const linkyValue = linkyState.value;
        const batteryValue = batteryState.value;
        const solarValue = solarState.value;

        const linkyAgeMs = linkyState.fetchedAt ? tickStartedAt - linkyState.fetchedAt : Infinity;
        const batteryAgeMs = batteryState.fetchedAt ? tickStartedAt - batteryState.fetchedAt : Infinity;
        const solarAgeMs = solarState.fetchedAt ? tickStartedAt - solarState.fetchedAt : Infinity;

        const gridValid =
          linkyValue !== null &&
          !linkyValue.stale &&
          linkyAgeMs <= CONFIG.control.dataTimeoutMs;
        const batteryValid =
          batteryValue !== null && batteryAgeMs <= CONFIG.control.dataTimeoutMs;
        const solarValid =
          solarValue !== null &&
          !solarValue.stale &&
          solarAgeMs <= CONFIG.solar.maxDataAgeMs;

        const decision = controller.update({
          now: tickStartedAt,
          gridW: linkyValue?.controlW ?? null,
          gridValid,
          solarW: solarValue?.productionW ?? null,
          solarValid,
          socPercent: batteryValue?.socPercent ?? null,
          batteryValid,
          actualOutputW: batteryValue?.outputW ?? 0,
          actualInputW: batteryValue?.inputW ?? 0,
          fault: batteryValue?.fault ?? false,
        });
        lastDecision = decision;

        if (decision.commandMode !== lastCommand.mode || decision.targetPowerW !== lastCommand.powerW) {
          const signature = `${decision.mode}|${decision.commandMode}|${decision.targetPowerW}`;
          if (signature !== lastDecisionSignature) {
            lastDecisionSignature = signature;
            log.info(
              `[CTRL] ${decision.mode.toUpperCase()}` +
                `${decision.targetPowerW > 0 ? ` ${decision.targetPowerW} W` : ""} — ${decision.reason}`,
            );
          }
        }

        const shouldSend =
          decision.commandMode !== lastCommand.mode ||
          Math.abs(decision.targetPowerW - lastCommand.powerW) >= CONFIG.control.minCommandDeltaW;
        const retryDelay = lastCommandOk
          ? CONFIG.battery.minCommandIntervalMs
          : CONFIG.battery.commandRetryMs;

        if (shouldSend && !dryRun && tickStartedAt - lastCommandAt >= retryDelay) {
          try {
            if (decision.commandMode === "charge") {
              await battery.setCharge(decision.targetPowerW);
            } else if (decision.commandMode === "discharge") {
              await battery.setDischarge(decision.targetPowerW);
            } else {
              await battery.standby(false);
            }
            lastCommand = { mode: decision.commandMode, powerW: decision.targetPowerW };
            lastCommandAt = Date.now();
            lastCommandOk = true;
            log.info(
              `[CMD] → ${decision.commandMode} ${decision.targetPowerW} W — ${decision.reason}`,
            );
          } catch (error) {
            lastCommandAt = Date.now();
            lastCommandOk = false;
            log.error(
              `Commande batterie impossible (${decision.commandMode} ${decision.targetPowerW} W): ` +
                errorMessage(error),
            );
          }
        } else if (shouldSend && dryRun) {
          lastCommand = { mode: decision.commandMode, powerW: decision.targetPowerW };
          lastCommandAt = Date.now();
          log.info(
            `[DRY-RUN] aurait envoyé ${decision.commandMode} ${decision.targetPowerW} W — ${decision.reason}`,
          );
        }

        if (tickStartedAt - lastStatusAt >= CONFIG.logging.statusIntervalMs) {
          lastStatusAt = tickStartedAt;
          const batteryText = batteryValue
            ? `out=${batteryValue.outputW} W in=${batteryValue.inputW} W`
            : "batterie ?";
          const gridText = linkyValue
            ? `S2=${linkyValue.controlW} W (âge ${Math.round(linkyAgeMs / 1000)} s)`
            : "Linky ?";
          const pvText = solarValue
            ? `PV=${solarValue.productionW} W (âge ${Math.round(solarValue.ageMs / 1000)} s)`
            : "PV ?";
          const socText = batteryValue ? `SOC=${batteryValue.socPercent}%` : "SOC ?";
          const loadText =
            decision.estimatedLoadW !== null ? `charge2≈${Math.round(decision.estimatedLoadW)} W` : "charge2 ?";
          log.info(
            `[ÉTAT] ${gridText} | ${pvText} | ${socText} | ${batteryText} | ${loadText} | ` +
              `mode=${decision.mode} cible=${decision.targetPowerW} W — ${decision.reason}`,
          );
        }

        await Bun.sleep(Math.max(0, CONFIG.control.tickIntervalMs - (Date.now() - tickStartedAt)));
      }
    })();

    // ── Boucle de visualisation MySQL (10 s) ───────────────────────────────
    void (async () => {
      while (running) {
        const startedAt = Date.now();
        const linkyValue = linkyState.value;
        const batteryValue = batteryState.value;
        const solarValue = solarState.value;
        const values: HistoryValues = {
          consoW:
            linkyValue && Date.now() - linkyState.fetchedAt <= 30_000
              ? linkyValue.logW
              : null,
          powerW:
            batteryValue && Date.now() - batteryState.fetchedAt <= 30_000
              ? BatteryClient.actualPowerW(batteryValue)
              : null,
          solarW:
            solarValue && Date.now() - solarState.fetchedAt <= CONFIG.solar.maxDataAgeMs
              ? solarValue.productionW
              : null,
        };
        await historyDb.log(values);
        await Bun.sleep(Math.max(0, CONFIG.database.history.intervalMs - (Date.now() - startedAt)));
      }
    })().catch((error) => {
      log.error(`Boucle de visualisation arrêtée: ${errorMessage(error)}`);
    });

    // ── Historique local JSONL (1 s, optionnel) ─────────────────────────────
    if (CONFIG.localHistory.enabled) {
      void (async () => {
        while (running) {
          const now = Date.now();
          const date = new Date(now);
          const linkyValue = linkyState.value;
          const batteryValue = batteryState.value;
          const solarValue = solarState.value;
          // Le cast évite que TypeScript ne voie `lastDecision` figé à null :
          // il est modifié par la boucle de contrôle asynchrone.
          const decision = lastDecision as ControlDecision | null;
          await localHistory.record({
            ts: date.toISOString(),
            local: formatLocalDateTime(date),
            s2: linkyValue?.controlW ?? null,
            s1: linkyValue?.values.SINSTS1 ?? null,
            s3: linkyValue?.values.SINSTS3 ?? null,
            sinsts: linkyValue?.totalW ?? null,
            linkyAgeMs: linkyState.fetchedAt ? now - linkyState.fetchedAt : null,
            pvW: solarValue?.productionW ?? null,
            pvAgeMs: solarValue?.ageMs ?? null,
            soc: batteryValue?.socPercent ?? null,
            battOutW: batteryValue?.outputW ?? null,
            battInW: batteryValue?.inputW ?? null,
            packState: batteryValue?.packState ?? null,
            packPowerW: batteryValue?.packPowerW ?? null,
            mode: decision?.mode ?? null,
            command: decision?.commandMode ?? null,
            targetW: decision?.targetPowerW ?? null,
            gridEmaW: decision?.gridEmaW ?? null,
            loadEstimateW: decision?.estimatedLoadW ?? null,
            surplusW: decision?.surplusW ?? null,
            reason: decision?.reason ?? null,
          });
          await Bun.sleep(Math.max(0, CONFIG.localHistory.intervalMs - (Date.now() - now)));
        }
      })().catch((error) => {
        log.error(`Boucle d'historique local arrêtée: ${errorMessage(error)}`);
      });
    }

    // Les boucles de lecture tournent jusqu'à l'arrêt du processus.
    void linkyLoop;
    void batteryLoop;
    void solarLoop;

    // Option de diagnostic : arrêt automatique propre, utilisé par le smoke test.
    if (Number.isFinite(stopAfterSeconds) && stopAfterSeconds > 0) {
      log.info(`Arrêt automatique dans ${stopAfterSeconds} s (option de test).`);
      setTimeout(() => {
        void shutdown("durée de test atteinte", 0);
      }, stopAfterSeconds * 1_000);
    }

    await controlLoopPromise;

    if (!shuttingDown) {
      log.warn("La boucle de contrôle s'est arrêtée de manière inattendue.");
      await shutdown("fin de la boucle de contrôle", 1);
    }
  } catch (error) {
    log.error(`Erreur fatale: ${errorMessage(error)}`);
    await shutdown("erreur fatale", 1);
  }
}

try {
  await main();
} catch (error) {
  log.error(`Erreur fatale au démarrage: ${errorMessage(error)}`);
  process.exit(1);
}
