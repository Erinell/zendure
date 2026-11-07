import type {
  CommandMode,
  ControlConfig,
  ControlDecision,
  ControlInput,
  ControlMode,
} from "./interfaces";

export interface ControllerOptions {
  config: ControlConfig;
  minSocPercent: number;
  maxSocPercent: number;
  maxChargeW: number;
  maxDischargeW: number;
}

/**
 * Régulateur à états, sans I/O, testable avec un temps simulé.
 *
 * Principes :
 *  - charge uniquement si SINSTS2 ≈ 0 et production PV suffisante ;
 *  - décharge uniquement si SINSTS2 > seuil, plafonnée à 300 W ;
 *  - hystérésis, délais de démarrage et cooldowns pour éviter les oscillations ;
 *  - la batterie met 15-18 s à appliquer une consigne : on attend avant d'ajuster ;
 *  - en cas de données invalides : standby.
 *
 * Le régulateur ne connaît ni HTTP ni MySQL : il reçoit un instantané et rend une décision.
 */
export class BatteryController {
  private mode: ControlMode = "fault";
  private targetW = 0;
  private reason = "Initialisation";

  private gridEmaW: number | null = null;
  private loadEmaW: number | null = null;
  private loadEmaAt = 0;

  private lastUpdateAt = 0;
  private validSince: number | null = null;
  private gridLowSince: number | null = null;
  private gridHighSince: number | null = null;
  private solarLowSince: number | null = null;
  private abortSince: number | null = null;
  private zeroSince: number | null = null;
  private stopSince: number | null = null;
  private nextAdjustAt = 0;

  private lastChargeEndAt = Number.NEGATIVE_INFINITY;
  private lastDischargeEndAt = Number.NEGATIVE_INFINITY;

  private lastSurplusW: number | null = null;
  private lastAvailableLoadW: number | null = null;

  constructor(private readonly options: ControllerOptions) {}

  update(input: ControlInput): ControlDecision {
    const now = input.now;
    const dt = this.lastUpdateAt === 0 ? 0 : Math.max(0, now - this.lastUpdateAt);
    this.lastUpdateAt = now;

    const gridOk = input.gridValid && input.gridW !== null;
    const batteryOk = input.batteryValid && input.socPercent !== null && !input.fault;

    if (!gridOk || !batteryOk) {
      const reason = !gridOk
        ? "Linky indisponible ou mesure périmée"
        : input.fault
          ? "Défaut batterie ou batterie hors réseau"
          : "Batterie indisponible";
      this.enterFault(now, reason);
      return this.decision();
    }

    if (this.mode === "fault") {
      this.validSince ??= now;
      if (now - this.validSince < this.options.config.recoveryDelayMs) {
        this.reason = "Attente de données stables avant reprise";
        return this.decision();
      }
      this.transitionTo("idle", now, "Données valides, reprise");
    }

    this.updateGridEma(input.gridW!, dt);
    this.updateLoadEstimate(input, now);
    this.lastSurplusW = this.computeSurplus(input, now);
    this.lastAvailableLoadW = this.computeAvailableLoad(input, now);

    const soc = input.socPercent!;

    // Sécurité SOC : on ne dépasse jamais les bornes, même si le matériel les applique déjà.
    if (this.mode === "discharging" && soc <= this.options.minSocPercent) {
      this.transitionTo("idle", now, "SOC minimum atteint");
      this.lastDischargeEndAt = now;
    } else if (this.mode === "charging" && soc >= this.options.maxSocPercent) {
      this.transitionTo("idle", now, "SOC maximum atteint");
      this.lastChargeEndAt = now;
    }

    switch (this.mode) {
      case "idle":
        this.updateIdle(input, now, soc);
        break;
      case "charging":
        this.updateCharging(input, now, soc);
        break;
      case "discharging":
        this.updateDischarging(input, now, soc);
        break;
      case "fault":
        break;
    }

    return this.decision();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Estimation / lissage
  // ─────────────────────────────────────────────────────────────────────────

  private updateGridEma(gridW: number, dt: number): void {
    if (this.gridEmaW === null) {
      this.gridEmaW = gridW;
      return;
    }
    const alpha = dt > 0 ? 1 - Math.exp(-dt / this.options.config.gridEmaTauMs) : 1;
    this.gridEmaW += alpha * (gridW - this.gridEmaW);
    this.gridEmaW = Math.max(0, this.gridEmaW);
  }

  /**
   * Estime la consommation de la phase 2 à partir du bilan de puissance :
   *   charge = SINSTS2 + production PV - charge batterie + décharge batterie
   * L'estimation n'est mise à jour que lorsque SINSTS2 > 10 W (sinon le surplus
   * rendrait le bilan non observable). Elle sert de pré-consigne, pas de vérité.
   */
  private updateLoadEstimate(input: ControlInput, now: number): void {
    if (!input.solarValid || input.solarW === null || input.gridW === null || input.gridW <= 10) {
      return;
    }
    const load = input.gridW + input.solarW - input.actualInputW + input.actualOutputW;
    if (load < 0 || load > this.options.config.maxEstimatedLoadW) return;

    if (this.loadEmaW === null) {
      this.loadEmaW = load;
    } else {
      const dt = this.lastUpdateAt === 0 ? 0 : Math.max(0, now - this.loadEmaAt);
      const alpha = dt > 0 ? 1 - Math.exp(-dt / this.options.config.loadEmaTauMs) : 1;
      this.loadEmaW += alpha * (load - this.loadEmaW);
    }
    this.loadEmaAt = now;
  }

  private loadEstimateIsFresh(now: number): boolean {
    return (
      this.loadEmaW !== null &&
      now - this.loadEmaAt <= this.options.config.loadEstimateMaxAgeMs
    );
  }

  private computeSurplus(input: ControlInput, now: number): number | null {
    if (!input.solarValid || input.solarW === null || !this.loadEstimateIsFresh(now)) {
      return null;
    }
    return Math.max(0, input.solarW - this.loadEmaW!);
  }

  private computeAvailableLoad(input: ControlInput, now: number): number | null {
    if (!input.solarValid || input.solarW === null || !this.loadEstimateIsFresh(now)) {
      return null;
    }
    return Math.max(0, this.loadEmaW! - input.solarW);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Machine à états
  // ─────────────────────────────────────────────────────────────────────────

  private updateIdle(input: ControlInput, now: number, soc: number): void {
    const grid = this.gridEmaW!;
    const { charge, discharge } = this.options.config;

    const low = grid <= charge.startBelowGridW;
    if (low) this.gridLowSince ??= now;
    else this.gridLowSince = null;

    const high = grid >= discharge.startAboveGridW;
    if (high) this.gridHighSince ??= now;
    else this.gridHighSince = null;

    const solarOk =
      input.solarValid && input.solarW !== null && input.solarW >= charge.minSolarW;

    const canCharge =
      soc < this.options.maxSocPercent &&
      solarOk &&
      this.gridLowSince !== null &&
      now - this.gridLowSince >= charge.startDelayMs &&
      now >= this.lastDischargeEndAt + charge.cooldownAfterMs;

    if (canCharge) {
      this.startCharging(input, now);
      return;
    }

    const canDischarge =
      soc > this.options.minSocPercent &&
      this.gridHighSince !== null &&
      now - this.gridHighSince >= discharge.startDelayMs &&
      now >= this.lastChargeEndAt + discharge.cooldownAfterMs;

    if (canDischarge) {
      this.startDischarging(input, now);
      return;
    }

    this.targetW = 0;
    this.reason = `Veille (S2=${Math.round(grid)} W, SOC=${soc}%)`;
  }

  private startCharging(input: ControlInput, now: number): void {
    const { charge } = this.options.config;
    const surplus = this.computeSurplus(input, now);
    const initial =
      surplus === null
        ? charge.startPowerW
        : Math.min(charge.maxInitialPowerW, Math.max(charge.startPowerW, surplus));

    this.transitionTo("charging", now, "Début de charge (surplus PV)");
    this.targetW = this.roundPower(Math.min(initial, this.options.maxChargeW));
    this.nextAdjustAt = now + charge.startupSettleMs;
    this.reason =
      surplus === null
        ? `Charge initiale ${this.targetW} W (surplus inconnu)`
        : `Charge initiale ${this.targetW} W (surplus estimé ${Math.round(surplus)} W)`;
  }

  private startDischarging(input: ControlInput, now: number): void {
    const { discharge } = this.options.config;
    const available = this.computeAvailableLoad(input, now);
    const initial =
      available === null
        ? discharge.startPowerW
        : Math.min(discharge.maxInitialPowerW, Math.max(discharge.startPowerW, available));

    this.transitionTo("discharging", now, "Début de décharge (consommation)");
    this.targetW = this.roundPower(Math.min(initial, this.options.maxDischargeW));
    this.nextAdjustAt = now + discharge.startupSettleMs;
    this.reason =
      available === null
        ? `Décharge initiale ${this.targetW} W (charge estimée inconnue)`
        : `Décharge initiale ${this.targetW} W (charge phase 2 estimée ${Math.round(available)} W)`;
  }

  private updateCharging(input: ControlInput, now: number, soc: number): void {
    const { charge } = this.options.config;

    if (soc >= this.options.maxSocPercent) {
      this.transitionTo("idle", now, "SOC maximum atteint");
      this.lastChargeEndAt = now;
      return;
    }

    // Garde-fou PV : l'API solaire peut être en retard de quelques minutes.
    const solarOk =
      input.solarValid && input.solarW !== null && input.solarW >= charge.minSolarW;
    if (!solarOk) {
      this.solarLowSince ??= now;
      if (now - this.solarLowSince >= charge.solarStopDelayMs) {
        this.transitionTo("idle", now, "Production PV insuffisante");
        this.lastChargeEndAt = now;
        return;
      }
    } else {
      this.solarLowSince = null;
    }

    const grid = this.gridEmaW!;

    // Sécurité : import réseau trop important malgré le retour arrière normal.
    if (grid > charge.abortAboveGridW) {
      this.abortSince ??= now;
      if (now - this.abortSince >= charge.abortDelayMs) {
        this.transitionTo("idle", now, "Import réseau trop élevé");
        this.lastChargeEndAt = now;
        return;
      }
    } else {
      this.abortSince = null;
    }

    // Si la charge est déjà à zéro, on attend le délai d'arrêt avant de repasser en veille.
    if (this.targetW <= charge.minPowerW && this.stopSince !== null) {
      if (now - this.stopSince >= charge.stopDelayMs) {
        this.transitionTo("idle", now, "Charge arrêtée (plus de surplus)");
        this.lastChargeEndAt = now;
      }
      return;
    }

    if (now < this.nextAdjustAt) return;

    if (grid > charge.backoffAboveGridW) {
      const surplus = this.computeSurplus(input, now);
      let next =
        this.targetW - Math.max(charge.backoffMinStepW, grid - charge.targetGridW + 20);
      if (surplus !== null) {
        next = Math.min(next, surplus);
      }
      this.targetW = this.roundPower(Math.max(0, next));
      this.nextAdjustAt = now + charge.settleAfterBackoffMs;
      this.reason = `Baisse charge -> ${this.targetW} W (S2=${Math.round(grid)} W, import)`;
    } else if (grid <= charge.rampUpBelowGridW) {
      const next = Math.min(
        this.options.maxChargeW,
        this.targetW + charge.rampUpStepW,
      );
      this.targetW = this.roundPower(next);
      this.nextAdjustAt = now + charge.adjustIntervalMs;
      this.stopSince = null;
      this.reason = `Hausse charge -> ${this.targetW} W (S2=${Math.round(grid)} W)`;
    } else {
      this.nextAdjustAt = now + charge.adjustIntervalMs;
      this.reason = `Charge maintenue à ${this.targetW} W (S2=${Math.round(grid)} W)`;
    }

    if (this.targetW <= charge.minPowerW) {
      this.targetW = 0;
      this.stopSince ??= now;
      if (now - this.stopSince >= charge.stopDelayMs) {
        this.transitionTo("idle", now, "Charge arrêtée (plus de surplus)");
        this.lastChargeEndAt = now;
      }
    } else {
      this.stopSince = null;
    }
  }

  private updateDischarging(input: ControlInput, now: number, soc: number): void {
    const { discharge } = this.options.config;

    if (soc <= this.options.minSocPercent) {
      this.transitionTo("idle", now, "SOC minimum atteint");
      this.lastDischargeEndAt = now;
      return;
    }

    const grid = this.gridEmaW!;

    // Si la décharge est à zéro, on attend le délai d'arrêt, sauf si la consommation revient.
    if (this.targetW <= discharge.minPowerW && this.stopSince !== null) {
      if (grid > discharge.startAboveGridW) {
        this.stopSince = null;
      } else if (now - this.stopSince >= discharge.stopDelayMs) {
        this.transitionTo("idle", now, "Décharge arrêtée (consommation couverte)");
        this.lastDischargeEndAt = now;
        return;
      } else {
        return;
      }
    }

    if (now < this.nextAdjustAt) return;

    if (grid > discharge.rampUpAboveGridW) {
      const available = this.computeAvailableLoad(input, now);
      let next = this.targetW + discharge.rampUpStepW;
      if (available !== null) {
        // On ne dépasse pas la charge estimée de la phase 2.
        next = Math.min(next, Math.max(this.targetW, available));
      }
      next = Math.min(next, this.options.maxDischargeW);
      const increased = next > this.targetW;
      this.targetW = this.roundPower(next);
      this.nextAdjustAt = now + discharge.adjustIntervalMs;
      this.zeroSince = null;
      this.stopSince = null;
      this.reason = increased
        ? `Hausse décharge -> ${this.targetW} W (S2=${Math.round(grid)} W)`
        : `Décharge maintenue à ${this.targetW} W (S2=${Math.round(grid)} W)`;
    } else if (grid <= discharge.rampDownBelowGridW) {
      this.zeroSince ??= now;
      if (now - this.zeroSince >= discharge.zeroHoldMs) {
        this.targetW = this.roundPower(
          Math.max(0, this.targetW - discharge.rampDownStepW),
        );
        this.zeroSince = now;
        this.nextAdjustAt = now + discharge.adjustIntervalMs;
        this.reason = `Baisse décharge -> ${this.targetW} W (S2=0 W)`;
        if (this.targetW <= discharge.minPowerW) {
          this.targetW = 0;
          this.stopSince ??= now;
        }
      } else {
        this.nextAdjustAt = now + discharge.adjustIntervalMs;
        this.reason = `Décharge maintenue à ${this.targetW} W (S2=0, attente)`;
      }
    } else {
      this.zeroSince = null;
      this.stopSince = null;
      this.nextAdjustAt = now + discharge.adjustIntervalMs;
      this.reason = `Décharge maintenue à ${this.targetW} W (S2=${Math.round(grid)} W)`;
    }

    if (this.targetW <= discharge.minPowerW) {
      this.targetW = 0;
      this.stopSince ??= now;
      if (now - this.stopSince >= discharge.stopDelayMs) {
        this.transitionTo("idle", now, "Décharge arrêtée (consommation couverte)");
        this.lastDischargeEndAt = now;
      }
    } else {
      this.stopSince = null;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Utilitaires
  // ─────────────────────────────────────────────────────────────────────────

  private enterFault(now: number, reason: string): void {
    if (this.mode !== "fault") {
      this.transitionTo("fault", now, reason);
      this.validSince = null;
      this.gridEmaW = null;
      this.loadEmaW = null;
      this.loadEmaAt = 0;
      this.lastSurplusW = null;
      this.lastAvailableLoadW = null;
    } else {
      this.reason = reason;
    }
    this.targetW = 0;
  }

  private transitionTo(mode: ControlMode, now: number, reason: string): void {
    if (this.mode === "charging" && mode !== "charging") {
      this.lastChargeEndAt = now;
    }
    if (this.mode === "discharging" && mode !== "discharging") {
      this.lastDischargeEndAt = now;
    }
    this.mode = mode;
    this.targetW = 0;
    this.reason = reason;
    this.nextAdjustAt = 0;
    this.gridLowSince = null;
    this.gridHighSince = null;
    this.solarLowSince = null;
    this.abortSince = null;
    this.zeroSince = null;
    this.stopSince = null;
  }

  private roundPower(powerW: number): number {
    const rounding = this.options.config.commandRoundingW;
    const rounded = Math.round(powerW / rounding) * rounding;
    return Math.max(0, rounded);
  }

  private decision(): ControlDecision {
    let commandMode: CommandMode = "standby";
    let targetPowerW = 0;

    if (this.mode === "charging" && this.targetW > 0) {
      commandMode = "charge";
      targetPowerW = this.targetW;
    } else if (this.mode === "discharging" && this.targetW > 0) {
      commandMode = "discharge";
      targetPowerW = this.targetW;
    }

    return {
      mode: this.mode,
      commandMode,
      targetPowerW,
      reason: this.reason,
      gridEmaW: this.gridEmaW,
      estimatedLoadW: this.loadEmaW,
      surplusW: this.lastSurplusW,
      availableLoadW: this.lastAvailableLoadW,
    };
  }
}
