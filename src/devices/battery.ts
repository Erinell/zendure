import { fetchJson } from "../http";
import type {
  BatteryConfig,
  BatteryReport,
  BatterySnapshot,
  BatteryWriteResponse,
} from "../interfaces";

/** Erreur volontairement bloquante : l'IP ne correspond pas au numéro de série attendu. */
export class BatterySerialMismatchError extends Error {
  constructor(_expected?: string, _received?: string) {
    super("Numéro de série inattendu: vérifier BATTERY_SERIAL dans .env");
    this.name = "BatterySerialMismatchError";
  }
}

export interface BatteryReadResult {
  report: BatteryReport;
  snapshot: BatterySnapshot;
}

/** Sous-ensemble des propriétés que le programme est autorisé à écrire. */
export interface BatteryWritableProperties {
  acMode?: number;
  inputLimit?: number;
  outputLimit?: number;
  smartMode?: number;
  minSoc?: number;
  socSet?: number;
}

function finiteNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Propriété batterie invalide: ${name}=${String(value)}`);
  }
  return value;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Client de l'API locale zenSDK de la batterie.
 *
 * - GET  /properties/report : état complet
 * - POST /properties/write  : commande (le corps doit contenir le numéro de série)
 *
 * Les écritures sont sérialisées : une commande d'arrêt envoyée au shutdown ne peut
 * pas être doublée par une commande de charge encore en vol.
 */
export class BatteryClient {
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly config: BatteryConfig) {}

  private get baseUrl(): string {
    return `http://${this.config.ip}`;
  }

  async getReport(): Promise<BatteryReadResult> {
    const report = await fetchJson<BatteryReport>(`${this.baseUrl}/properties/report`, {
      timeoutMs: this.config.requestTimeoutMs,
    });

    if (!report || typeof report !== "object" || !report.properties) {
      throw new Error("Réponse batterie invalide: propriétés absentes");
    }
    if (report.sn !== this.config.serialNumber) {
      throw new BatterySerialMismatchError(this.config.serialNumber, String(report.sn));
    }

    const p = report.properties;
    const soc = finiteNumber(p.electricLevel, "electricLevel");
    const dataReady = numberOr(p.dataReady, 0) === 1;
    const fault =
      numberOr(p.faultLevel, 0) > 0 ||
      numberOr(p.is_error, 0) > 0 ||
      !dataReady ||
      numberOr(p.gridState, 0) !== 1;

    const pack = Array.isArray(report.packData) && report.packData.length > 0 ? report.packData[0] : undefined;

    const snapshot: BatterySnapshot = {
      fetchedAt: Date.now(),
      socPercent: soc,
      outputW: numberOr(p.outputHomePower, 0),
      inputW: numberOr(p.gridInputPower, 0),
      packState: numberOr(pack?.state, numberOr(p.packState, 0)),
      packPowerW: numberOr(pack?.power, 0),
      acMode: numberOr(p.acMode, 0),
      inputLimitW: numberOr(p.inputLimit, 0),
      outputLimitW: numberOr(p.outputLimit, 0),
      smartMode: numberOr(p.smartMode, 0),
      minSocRaw: numberOr(p.minSoc, 0),
      socSetRaw: numberOr(p.socSet, 0),
      fault,
      gridState: numberOr(p.gridState, 0),
      dataReady,
      ts: numberOr(p.ts, 0),
      hardwareMaxChargeW: numberOr(p.chargeMaxLimit, this.config.hardwareMaxChargePowerW),
      hardwareMaxDischargeW: numberOr(p.inverseMaxPower, this.config.hardwareMaxDischargePowerW),
    };

    return { report, snapshot };
  }

  /**
   * Envoie une commande. Serialise les écritures pour garantir l'ordre.
   */
  async write(properties: BatteryWritableProperties): Promise<BatteryWriteResponse> {
    const run = this.writeChain.then(() => this.writeNow(properties));
    // On garde la chaîne vivante même si une commande échoue.
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async writeNow(properties: BatteryWritableProperties): Promise<BatteryWriteResponse> {
    const response = await fetchJson<BatteryWriteResponse>(`${this.baseUrl}/properties/write`, {
      method: "POST",
      timeoutMs: this.config.requestTimeoutMs,
      body: {
        sn: this.config.serialNumber,
        properties,
      },
    });

    if (!response || response.success !== true) {
      const code = response && typeof response.code === "number" ? response.code : "?";
      throw new Error(`Commande batterie refusée (code ${code})`);
    }
    return response;
  }

  /** Charge avec une limite AC en watts. `smartMode=1` : pas d'écriture flash. */
  async setCharge(powerW: number): Promise<BatteryWriteResponse> {
    const power = Math.max(0, Math.min(this.config.maxChargePowerW, Math.round(powerW)));
    return this.write({
      smartMode: 1,
      acMode: 1,
      inputLimit: power,
      outputLimit: 0,
    });
  }

  /** Décharge avec une limite de sortie en watts. `smartMode=1` : pas d'écriture flash. */
  async setDischarge(powerW: number): Promise<BatteryWriteResponse> {
    const power = Math.max(0, Math.min(this.config.maxDischargePowerW, Math.round(powerW)));
    return this.write({
      smartMode: 1,
      acMode: 2,
      inputLimit: 0,
      outputLimit: power,
    });
  }

  /**
   * Coupe charge et décharge.
   * `persistent=true` écrit aussi les valeurs en flash (smartMode=0) : utilisé à l'arrêt
   * pour que la batterie redémarre en sécurité même si le Raspberry Pi est coupé.
   */
  async standby(persistent: boolean): Promise<BatteryWriteResponse> {
    return this.write({
      smartMode: persistent ? 0 : 1,
      acMode: 2,
      inputLimit: 0,
      outputLimit: 0,
    });
  }

  /**
   * Applique les limites SOC 20 % / 100 %.
   * Les valeurs brutes de l'API sont en dixièmes de pourcent (200 = 20,0 %).
   * On n'écrit que si nécessaire, et en flash pour que la sécurité survive à un reboot.
   */
  async ensureSocLimits(snapshot: BatterySnapshot): Promise<boolean> {
    const expectedMin = Math.round(this.config.minSocPercent * 10);
    const expectedMax = Math.round(this.config.maxSocPercent * 10);
    if (snapshot.minSocRaw === expectedMin && snapshot.socSetRaw === expectedMax) {
      return false;
    }
    await this.write({
      smartMode: 0,
      minSoc: expectedMin,
      socSet: expectedMax,
    });
    return true;
  }

  /** Puissance AC signée : positive en décharge, négative en charge. */
  static actualPowerW(snapshot: BatterySnapshot): number {
    return snapshot.outputW - snapshot.inputW;
  }
}
