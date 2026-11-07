import { describe, expect, test } from "bun:test";
import { CONFIG } from "../config";
import { BatteryController } from "../src/controller";
import type { ControlConfig, ControlDecision, ControlInput } from "../src/interfaces";

/**
 * Configuration accélérée pour les tests : les délais réels (15-30 s) sont
 * réduits à quelques secondes simulées. La logique testée est identique.
 */
const testControlConfig: ControlConfig = {
  ...CONFIG.control,
  tickIntervalMs: 1_000,
  gridEmaTauMs: 500,
  loadEmaTauMs: 1_000,
  loadEstimateMaxAgeMs: 10_000,
  recoveryDelayMs: 1_000,
  charge: {
    ...CONFIG.control.charge,
    startDelayMs: 2_000,
    startupSettleMs: 2_000,
    adjustIntervalMs: 5_000,
    settleAfterBackoffMs: 5_000,
    stopDelayMs: 3_000,
    abortDelayMs: 5_000,
    solarStopDelayMs: 3_000,
    cooldownAfterMs: 5_000,
  },
  discharge: {
    ...CONFIG.control.discharge,
    startDelayMs: 2_000,
    startupSettleMs: 2_000,
    adjustIntervalMs: 3_000,
    zeroHoldMs: 2_000,
    stopDelayMs: 3_000,
    cooldownAfterMs: 5_000,
  },
};

class Harness {
  readonly controller: BatteryController;
  now = 1_000_000;
  last!: ControlDecision;

  constructor() {
    this.controller = new BatteryController({
      config: testControlConfig,
      minSocPercent: 20,
      maxSocPercent: 100,
      maxChargeW: 1000,
      maxDischargeW: 300,
    });
  }

  feed(seconds: number, overrides: Partial<ControlInput> = {}): ControlDecision {
    for (let i = 0; i < seconds; i++) {
      const input: ControlInput = {
        now: this.now,
        gridW: 0,
        gridValid: true,
        solarW: 0,
        solarValid: true,
        socPercent: 50,
        batteryValid: true,
        actualOutputW: 0,
        actualInputW: 0,
        fault: false,
        faultReason: null,
        ...overrides,
      };
      this.last = this.controller.update(input);
      this.now += 1_000;
    }
    return this.last;
  }
}

describe("BatteryController", () => {
  test("aucune charge la nuit, même si SINSTS2 est à 0", () => {
    const h = new Harness();
    const decision = h.feed(30, { gridW: 0, solarW: 0, socPercent: 50 });
    expect(decision.mode).not.toBe("charging");
    expect(decision.commandMode).toBe("standby");
  });

  test("démarre la charge quand le soleil produit et que SINSTS2 est à 0", () => {
    const h = new Harness();
    h.feed(3, { gridW: 0, solarW: 0 });
    const decision = h.feed(10, { gridW: 0, solarW: 800, socPercent: 50 });
    expect(decision.mode).toBe("charging");
    expect(decision.commandMode).toBe("charge");
    expect(decision.targetPowerW).toBeGreaterThanOrEqual(100);
  });

  test("réduit la charge dès qu'un import réseau apparaît", () => {
    const h = new Harness();
    h.feed(10, { gridW: 0, solarW: 800, socPercent: 50 });
    const before = h.last.targetPowerW;
    expect(before).toBeGreaterThan(0);

    const decision = h.feed(8, { gridW: 200, solarW: 800, socPercent: 50 });
    expect(decision.targetPowerW).toBeLessThanOrEqual(before);
    expect(decision.mode).not.toBe("discharging");
  });

  test("décharge avec un plafond de 300 W", () => {
    const h = new Harness();
    const decision = h.feed(30, { gridW: 500, solarW: 0, socPercent: 50 });
    expect(decision.mode).toBe("discharging");
    expect(decision.commandMode).toBe("discharge");
    expect(decision.targetPowerW).toBeGreaterThan(0);
    expect(decision.targetPowerW).toBeLessThanOrEqual(300);

    const after = h.feed(120, { gridW: 500, solarW: 0, socPercent: 50 });
    expect(after.targetPowerW).toBeLessThanOrEqual(300);
  });

  test("utilise la charge estimée pour la consigne initiale de décharge", () => {
    const h = new Harness();
    const decision = h.feed(10, { gridW: 400, solarW: 0, socPercent: 50 });
    expect(decision.mode).toBe("discharging");
    expect(decision.targetPowerW).toBe(300);
  });

  test("ne descend pas sous le SOC minimum et l'explique", () => {
    const h = new Harness();
    h.feed(10, { gridW: 500, solarW: 0, socPercent: 50 });
    const decision = h.feed(2, { gridW: 500, solarW: 0, socPercent: 20 });
    expect(decision.mode).toBe("idle");
    expect(decision.commandMode).toBe("standby");
    expect(decision.reason).toContain("SOC minimum");
  });

  test("ne charge pas au-dessus du SOC maximum", () => {
    const h = new Harness();
    const decision = h.feed(20, { gridW: 0, solarW: 800, socPercent: 100 });
    expect(decision.mode).toBe("idle");
    expect(decision.commandMode).toBe("standby");
  });

  test("coupe la charge si le PV passe sous le seuil", () => {
    const h = new Harness();
    h.feed(10, { gridW: 0, solarW: 800, socPercent: 50 });
    expect(h.last.mode).toBe("charging");
    const decision = h.feed(10, { gridW: 0, solarW: 0, socPercent: 50 });
    expect(decision.mode).toBe("idle");
    expect(decision.commandMode).toBe("standby");
  });

  test("passe en standby si le Linky est invalide", () => {
    const h = new Harness();
    h.feed(5, { gridW: 0, solarW: 800 });
    const decision = h.feed(2, { gridValid: false });
    expect(decision.mode).toBe("fault");
    expect(decision.commandMode).toBe("standby");
    expect(decision.targetPowerW).toBe(0);
  });

  test("passe en standby si la batterie est invalide", () => {
    const h = new Harness();
    const decision = h.feed(3, { batteryValid: false });
    expect(decision.mode).toBe("fault");
    expect(decision.commandMode).toBe("standby");
    expect(decision.reason).toContain("indisponible");
  });

  test("affiche la raison précise d'un défaut batterie", () => {
    const h = new Harness();
    const decision = h.feed(3, {
      fault: true,
      faultReason: "Batterie: gridState=0, SOC minimum (20%)",
    });
    expect(decision.mode).toBe("fault");
    expect(decision.commandMode).toBe("standby");
    expect(decision.reason).toContain("gridState=0");
    expect(decision.reason).toContain("SOC minimum");
  });

  test("évite le basculement décharge -> charge avant le cooldown", () => {
    const h = new Harness();
    h.feed(10, { gridW: 500, solarW: 0, socPercent: 50 });
    h.feed(2, { gridW: 500, solarW: 0, socPercent: 20 }); // arrêt sur SOC mini
    const early = h.feed(3, { gridW: 0, solarW: 800, socPercent: 20 });
    expect(early.mode).not.toBe("charging");
    const later = h.feed(10, { gridW: 0, solarW: 800, socPercent: 20 });
    expect(later.mode).toBe("charging");
  });

  test("ne rebascule pas en charge quand la décharge met SINSTS2 à zéro", () => {
    const h = new Harness();
    h.feed(10, { gridW: 500, solarW: 0, socPercent: 50 });
    const decision = h.feed(10, { gridW: 0, solarW: 800, socPercent: 50 });
    expect(decision.mode).not.toBe("charging");
  });

  test("plafonne la charge à 1000 W", () => {
    const h = new Harness();
    const decision = h.feed(300, { gridW: 0, solarW: 5000, socPercent: 50 });
    expect(decision.targetPowerW).toBeLessThanOrEqual(1000);
  });

  test("ne charge pas si le PV est sous le seuil de production", () => {
    const h = new Harness();
    const decision = h.feed(30, { gridW: 0, solarW: 50, socPercent: 50 });
    expect(decision.mode).not.toBe("charging");
  });
});
