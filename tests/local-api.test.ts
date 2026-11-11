import { describe, expect, test } from "bun:test";
import type {
  BatteryReport,
  BatteryWriteResponse,
  LocalApiConfig,
} from "../src/interfaces";
import type { BatteryWritableProperties } from "../src/devices/battery";
import { LocalApiServer } from "../src/local-api";

const report = {
  timestamp: 123,
  messageId: 7,
  sn: "TEST-SN",
  properties: {
    electricLevel: 50,
    acMode: 1,
    inputLimit: 500,
  },
  packData: [],
} as unknown as BatteryReport;

const baseConfig: LocalApiConfig = {
  enabled: true,
  host: "127.0.0.1",
  port: 0,
  allowWrite: false,
};

async function startApi(options: {
  allowWrite?: boolean;
  report?: BatteryReport | null;
  ageMs?: number | null;
  write?: (properties: BatteryWritableProperties) => Promise<BatteryWriteResponse>;
} = {}) {
  const api = new LocalApiServer({
    config: { ...baseConfig, allowWrite: options.allowWrite ?? false },
    serialNumber: "TEST-SN",
    cacheMaxAgeMs: 15_000,
    getReport: () => (options.report === undefined ? report : options.report),
    getCacheAgeMs: () => (options.ageMs === undefined ? 1_000 : options.ageMs),
    write:
      options.write ??
      (async () => ({
        timestamp: 1,
        messageId: 2,
        success: true,
        code: 200,
        sn: "TEST-SN",
      })),
  });
  api.start();
  return { api, base: `http://127.0.0.1:${api.port}` };
}

describe("LocalApiServer", () => {
  test("GET /properties/report renvoie le rapport en cache et les en-têtes", async () => {
    const { api, base } = await startApi();
    try {
      const response = await fetch(`${base}/properties/report`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(report);
      expect(response.headers.get("x-battery-cache-age-ms")).toBe("1000");
      expect(response.headers.get("x-battery-cache-stale")).toBe("false");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
    } finally {
      await api.stop();
    }
  });

  test("signale un cache périmé", async () => {
    const { api, base } = await startApi({ ageMs: 20_000 });
    try {
      const response = await fetch(`${base}/properties/report`);
      expect(response.status).toBe(200);
      expect(response.headers.get("x-battery-cache-stale")).toBe("true");
    } finally {
      await api.stop();
    }
  });

  test("GET sans cache renvoie 503", async () => {
    const { api, base } = await startApi({ report: null });
    try {
      const response = await fetch(`${base}/properties/report`);
      expect(response.status).toBe(503);
    } finally {
      await api.stop();
    }
  });

  test("POST /properties/write est refusé par défaut", async () => {
    const { api, base } = await startApi();
    try {
      const response = await fetch(`${base}/properties/write`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sn: "TEST-SN", properties: { inputLimit: 500 } }),
      });
      expect(response.status).toBe(403);
    } finally {
      await api.stop();
    }
  });

  test("POST /properties/write transmet les propriétés autorisées", async () => {
    const captured: { value: BatteryWritableProperties | null } = { value: null };
    const { api, base } = await startApi({
      allowWrite: true,
      write: async (properties) => {
        captured.value = properties;
        return {
          timestamp: 1,
          messageId: 2,
          success: true,
          code: 200,
          sn: "TEST-SN",
        };
      },
    });
    try {
      const response = await fetch(`${base}/properties/write`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sn: "TEST-SN",
          properties: { acMode: 1, inputLimit: 500, unknown: 1 },
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ success: true, code: 200 });
      expect(captured.value).toEqual({ acMode: 1, inputLimit: 500 });
    } finally {
      await api.stop();
    }
  });

  test("POST refuse un mauvais SN, un JSON invalide et l'absence de propriété", async () => {
    const { api, base } = await startApi({ allowWrite: true });
    try {
      const badSn = await fetch(`${base}/properties/write`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sn: "OTHER", properties: { inputLimit: 500 } }),
      });
      expect(badSn.status).toBe(401);

      const badJson = await fetch(`${base}/properties/write`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
      });
      expect(badJson.status).toBe(400);

      const noProps = await fetch(`${base}/properties/write`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sn: "TEST-SN", properties: { unknown: 1 } }),
      });
      expect(noProps.status).toBe(400);
    } finally {
      await api.stop();
    }
  });

  test("404 et OPTIONS", async () => {
    const { api, base } = await startApi();
    try {
      const notFound = await fetch(`${base}/unknown`);
      expect(notFound.status).toBe(404);

      const options = await fetch(`${base}/properties/report`, { method: "OPTIONS" });
      expect(options.status).toBe(204);
      expect(options.headers.get("access-control-allow-methods")).toContain("GET");
    } finally {
      await api.stop();
    }
  });
});
