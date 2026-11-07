import { describe, expect, test } from "bun:test";
import { classifyBatteryFault, type BatteryFaultInput } from "../src/devices/battery";

const base: BatteryFaultInput = {
  socPercent: 20,
  faultLevel: 1,
  isError: 0,
  dataReady: true,
  gridState: 1,
  socLimit: 2,
  minSocPercent: 20,
};

describe("classifyBatteryFault", () => {
  test("faultLevel=1 + socLimit=2 au SOC minimum = protection basse non bloquante", () => {
    const result = classifyBatteryFault(base);
    expect(result.fault).toBe(false);
    expect(result.lowSocProtection).toBe(true);
  });

  test("la protection reste non bloquante dans la marge de récupération (25 %)", () => {
    const result = classifyBatteryFault({ ...base, socPercent: 25 });
    expect(result.fault).toBe(false);
    expect(result.lowSocProtection).toBe(true);
  });

  test("au-delà de la marge, faultLevel=1 redevient bloquant", () => {
    const result = classifyBatteryFault({ ...base, socPercent: 26 });
    expect(result.fault).toBe(true);
    expect(result.lowSocProtection).toBe(false);
  });

  test("faultLevel=2 est bloquant", () => {
    const result = classifyBatteryFault({ ...base, faultLevel: 2 });
    expect(result.fault).toBe(true);
  });

  test("is_error est bloquant", () => {
    const result = classifyBatteryFault({ ...base, isError: 1 });
    expect(result.fault).toBe(true);
  });

  test("dataReady=0 est bloquant", () => {
    const result = classifyBatteryFault({ ...base, dataReady: false });
    expect(result.fault).toBe(true);
  });

  test("gridState=0 est bloquant", () => {
    const result = classifyBatteryFault({ ...base, gridState: 0 });
    expect(result.fault).toBe(true);
  });

  test("faultLevel=1 sans socLimit est bloquant", () => {
    const result = classifyBatteryFault({ ...base, socLimit: 0 });
    expect(result.fault).toBe(true);
    expect(result.lowSocProtection).toBe(false);
  });

  test("aucun défaut", () => {
    const result = classifyBatteryFault({
      ...base,
      faultLevel: 0,
      socLimit: 0,
      socPercent: 50,
    });
    expect(result.fault).toBe(false);
    expect(result.lowSocProtection).toBe(false);
  });
});
