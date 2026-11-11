import { describe, expect, test } from "bun:test";
import type { ChargeScheduleConfig, DischargeScheduleConfig } from "../src/interfaces";
import {
  describeChargeSchedule,
  describeDischargeSchedule,
  isChargeForced,
  isDischargeAllowed,
  isTimeInWindow,
  parseTimeToMinutes,
  validateChargeSchedule,
  validateDischargeSchedule,
} from "../src/schedule";

const at = (hour: number, minute = 0): number =>
  new Date(2026, 0, 1, hour, minute, 0).getTime();

const blockNight: DischargeScheduleConfig = {
  enabled: true,
  mode: "block",
  windows: [{ start: "22:00", end: "06:00" }],
};

const allowDay: DischargeScheduleConfig = {
  enabled: true,
  mode: "allow",
  windows: [{ start: "06:00", end: "22:00" }],
};

describe("parseTimeToMinutes", () => {
  test("convertit HH:MM et 24:00", () => {
    expect(parseTimeToMinutes("00:00")).toBe(0);
    expect(parseTimeToMinutes("6:30")).toBe(390);
    expect(parseTimeToMinutes("23:59")).toBe(1439);
    expect(parseTimeToMinutes("24:00")).toBe(1440);
  });

  test("refuse les heures invalides", () => {
    expect(() => parseTimeToMinutes("25:00")).toThrow();
    expect(() => parseTimeToMinutes("12:60")).toThrow();
    expect(() => parseTimeToMinutes("abc")).toThrow();
  });
});

describe("isTimeInWindow", () => {
  test("plage normale avec fin exclue", () => {
    const window = { start: "12:00", end: "14:00" };
    expect(isTimeInWindow(at(11, 59), window)).toBe(false);
    expect(isTimeInWindow(at(12, 0), window)).toBe(true);
    expect(isTimeInWindow(at(13, 59), window)).toBe(true);
    expect(isTimeInWindow(at(14, 0), window)).toBe(false);
  });

  test("plage qui traverse minuit", () => {
    const window = { start: "22:00", end: "06:00" };
    expect(isTimeInWindow(at(21, 59), window)).toBe(false);
    expect(isTimeInWindow(at(22, 0), window)).toBe(true);
    expect(isTimeInWindow(at(23, 59), window)).toBe(true);
    expect(isTimeInWindow(at(0, 0), window)).toBe(true);
    expect(isTimeInWindow(at(5, 59), window)).toBe(true);
    expect(isTimeInWindow(at(6, 0), window)).toBe(false);
  });

  test("start === end = plage de 24 h", () => {
    const window = { start: "00:00", end: "00:00" };
    expect(isTimeInWindow(at(0, 0), window)).toBe(true);
    expect(isTimeInWindow(at(12, 0), window)).toBe(true);
    expect(isTimeInWindow(at(23, 59), window)).toBe(true);
  });

  test("fin à 24:00", () => {
    const window = { start: "22:00", end: "24:00" };
    expect(isTimeInWindow(at(22, 0), window)).toBe(true);
    expect(isTimeInWindow(at(23, 59), window)).toBe(true);
    expect(isTimeInWindow(at(0, 0), window)).toBe(false);
  });
});

describe("isDischargeAllowed", () => {
  test("mode block : décharge bloquée dans la plage", () => {
    expect(isDischargeAllowed(at(21, 59), blockNight)).toBe(true);
    expect(isDischargeAllowed(at(22, 0), blockNight)).toBe(false);
    expect(isDischargeAllowed(at(23, 30), blockNight)).toBe(false);
    expect(isDischargeAllowed(at(5, 59), blockNight)).toBe(false);
    expect(isDischargeAllowed(at(6, 0), blockNight)).toBe(true);
    expect(isDischargeAllowed(at(12, 0), blockNight)).toBe(true);
  });

  test("mode allow : décharge autorisée uniquement dans la plage", () => {
    expect(isDischargeAllowed(at(5, 59), allowDay)).toBe(false);
    expect(isDischargeAllowed(at(6, 0), allowDay)).toBe(true);
    expect(isDischargeAllowed(at(21, 59), allowDay)).toBe(true);
    expect(isDischargeAllowed(at(22, 0), allowDay)).toBe(false);
  });

  test("désactivé ou liste vide = aucune restriction", () => {
    expect(
      isDischargeAllowed(at(23, 0), {
        enabled: false,
        mode: "block",
        windows: [{ start: "22:00", end: "06:00" }],
      }),
    ).toBe(true);
    expect(
      isDischargeAllowed(at(23, 0), { enabled: true, mode: "block", windows: [] }),
    ).toBe(true);
    expect(
      isDischargeAllowed(at(23, 0), { enabled: true, mode: "allow", windows: [] }),
    ).toBe(true);
  });

  test("plusieurs plages", () => {
    const schedule: DischargeScheduleConfig = {
      enabled: true,
      mode: "block",
      windows: [
        { start: "12:00", end: "14:00" },
        { start: "22:00", end: "06:00" },
      ],
    };
    expect(isDischargeAllowed(at(13, 0), schedule)).toBe(false);
    expect(isDischargeAllowed(at(23, 0), schedule)).toBe(false);
    expect(isDischargeAllowed(at(15, 0), schedule)).toBe(true);
  });
});

describe("validateDischargeSchedule", () => {
  test("accepte les plages valides", () => {
    expect(() => validateDischargeSchedule(blockNight)).not.toThrow();
    expect(() =>
      validateDischargeSchedule({ enabled: true, mode: "allow", windows: [] }),
    ).not.toThrow();
  });

  test("refuse une heure invalide", () => {
    expect(() =>
      validateDischargeSchedule({
        enabled: true,
        mode: "block",
        windows: [{ start: "25:00", end: "06:00" }],
      }),
    ).toThrow();
  });

  test("refuse 24:00 comme début", () => {
    expect(() =>
      validateDischargeSchedule({
        enabled: true,
        mode: "block",
        windows: [{ start: "24:00", end: "06:00" }],
      }),
    ).toThrow();
  });

  test("décrit le mode", () => {
    expect(describeDischargeSchedule(blockNight)).toContain("blocage");
    expect(describeDischargeSchedule(allowDay)).toContain("autorisation");
    expect(
      describeDischargeSchedule({ enabled: false, mode: "block", windows: [] }),
    ).toContain("désactivée");
  });
});

describe("recharge forcée", () => {
  const forced: ChargeScheduleConfig = {
    enabled: true,
    power: 500,
    windows: [{ start: "22:00", end: "23:00" }],
  };

  test("active la charge forcée dans la plage", () => {
    expect(isChargeForced(at(22, 0), forced)).toBe(true);
    expect(isChargeForced(at(22, 30), forced)).toBe(true);
    expect(isChargeForced(at(23, 0), forced)).toBe(false);
    expect(isChargeForced(at(12, 0), forced)).toBe(false);
  });

  test("désactivée, vide ou puissance nulle = pas de charge forcée", () => {
    expect(isChargeForced(at(22, 30), { ...forced, enabled: false })).toBe(false);
    expect(isChargeForced(at(22, 30), { ...forced, windows: [] })).toBe(false);
    expect(isChargeForced(at(22, 30), { ...forced, power: 0 })).toBe(false);
  });

  test("valide la puissance et les plages", () => {
    expect(() => validateChargeSchedule(forced)).not.toThrow();
    expect(() => validateChargeSchedule({ ...forced, power: -1 })).toThrow();
    expect(() =>
      validateChargeSchedule({
        ...forced,
        windows: [{ start: "25:00", end: "26:00" }],
      }),
    ).toThrow();
  });

  test("décrit la recharge forcée", () => {
    expect(describeChargeSchedule(forced)).toContain("500 W");
    expect(describeChargeSchedule({ ...forced, enabled: false })).toContain(
      "désactivée",
    );
  });
});
