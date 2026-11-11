/**
 * Toutes les interfaces et types partagés du projet.
 *
 * Ce fichier ne contient aucune valeur de configuration : il décrit uniquement
 * la forme des objets manipulés par le programme (config, API, contrôleur, logs).
 * Les valeurs concrètes sont dans `config.ts`.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LinkyField = "SINSTS" | "SINSTS1" | "SINSTS2" | "SINSTS3";

export interface BatteryConfig {
  /** Adresse IP de la batterie sur le réseau local. */
  ip: string;
  /** Numéro de série attendu : toute autre valeur est refusée. */
  serialNumber: string;
  /** Capacité nominale, utilisée uniquement pour les logs et l'autonomie estimée. */
  capacityWh: number;
  /** SOC minimum autorisé par le programme (la batterie est aussi réglée à cette valeur). */
  minSocPercent: number;
  /** SOC maximum autorisé par le programme (la batterie est aussi réglée à cette valeur). */
  maxSocPercent: number;
  /** Puissance de charge maximale utilisée par le contrôleur. */
  maxChargePowerW: number;
  /** Puissance de décharge maximale utilisée par le contrôleur (volontairement 300 W). */
  maxDischargePowerW: number;
  /** Limite matérielle de charge annoncée par le SolarFlow 800 Plus. */
  hardwareMaxChargePowerW: number;
  /** Limite matérielle de décharge annoncée par le SolarFlow 800 Plus. */
  hardwareMaxDischargePowerW: number;
  /** Intervalle de lecture de /properties/report. */
  pollIntervalMs: number;
  /** Timeout d'une requête HTTP vers la batterie. */
  requestTimeoutMs: number;
  /** Délai minimum entre deux commandes d'écriture (anti-rafale). */
  minCommandIntervalMs: number;
  /** Délai avant de réessayer une commande qui a échoué. */
  commandRetryMs: number;
  /** Temps laissé à la batterie pour appliquer une commande avant lecture de contrôle. */
  statusReadDelayMs: number;
}

export interface LinkyConfig {
  /** API HTTP du compteur Linky (retourne un tableau de mesures). */
  url: string;
  /** Champ Linky utilisé pour la régulation : la phase 2 porte la batterie et les panneaux. */
  controlField: LinkyField;
  /** Champ Linky stocké dans la table de visualisation `conso` (phase 2, SINSTS2). */
  logField: LinkyField;
  /** Le Linky est annoncé comme mis à jour chaque seconde. */
  pollIntervalMs: number;
  requestTimeoutMs: number;
  /** Au-delà de cet âge, la mesure Linky est considérée invalide. */
  maxDataAgeMs: number;
}

export interface SolarConfig {
  /** API de production Enphase/Envoy (wNow dans production[0]). */
  url: string;
  /** L'API Envoy se met à jour environ toutes les 5 minutes ; 30 s de lecture suffisent. */
  pollIntervalMs: number;
  requestTimeoutMs: number;
  /**
   * Au-delà de cet âge, la production solaire est considérée invalide.
   * On désactive alors la charge (mais pas la décharge, qui ne dépend pas du PV).
   */
  maxDataAgeMs: number;
}

export interface ChargeControlConfig {
  /** Production PV minimale pour autoriser une charge. */
  minSolarW: number;
  /** SINSTS2 (phase 2) doit être inférieur ou égal à cette valeur pour démarrer. */
  startBelowGridW: number;
  /** Durée pendant laquelle SINSTS2 doit rester bas avant de démarrer la charge. */
  startDelayMs: number;
  /** Puissance de la première consigne de charge. */
  startPowerW: number;
  /** Plafond de la consigne initiale calculée à partir du surplus estimé. */
  maxInitialPowerW: number;
  /**
   * La batterie met ~15 à 18 s à démarrer et à monter en puissance.
   * On attend ce délai avant d'évaluer l'effet de la première consigne.
   */
  startupSettleMs: number;
  /** Intervalle entre deux ajustements de charge. */
  adjustIntervalMs: number;
  /** Pas de montée en puissance. */
  rampUpStepW: number;
  /** On n'augmente la charge que si SINSTS2 est inférieur ou égal à cette valeur. */
  rampUpBelowGridW: number;
  /** Si SINSTS2 dépasse cette valeur, on réduit la charge (import réseau). */
  backoffAboveGridW: number;
  /** Valeur de SINSTS2 visée pendant la charge (petite marge). */
  targetGridW: number;
  /** Réduction minimale lors d'un retour arrière. */
  backoffMinStepW: number;
  /** Après une réduction, on laisse la batterie se stabiliser avant de remonter. */
  settleAfterBackoffMs: number;
  /** En dessous de cette puissance, la charge est considérée arrêtée. */
  minPowerW: number;
  /** Durée pendant laquelle la charge reste à zéro avant de repasser en veille. */
  stopDelayMs: number;
  /** Sécurité : import réseau excessif pendant abortDelayMs => arrêt de la charge. */
  abortAboveGridW: number;
  abortDelayMs: number;
  /** Si le PV reste sous minSolarW pendant ce délai, on arrête la charge. */
  solarStopDelayMs: number;
  /** Après un arrêt de charge, délai avant d'autoriser une décharge. */
  cooldownAfterMs: number;
  /** Recharge manuelle forcée : bypass de la régulation pendant les plages. */
  schedule: ChargeScheduleConfig;
}

export type DischargeScheduleMode = "block" | "allow";

/** Plage horaire locale au format HH:MM. La fin est exclue. */
export interface TimeWindow {
  /** Heure de début au format HH:MM. */
  start: string;
  /** Heure de fin au format HH:MM (exclue). */
  end: string;
}

/** Ancien nom conservé pour la lisibilité côté décharge. */
export type DischargeScheduleWindow = TimeWindow;

export interface DischargeScheduleConfig {
  /** Active la restriction horaire de décharge. */
  enabled: boolean;
  /**
   * "block" : les plages bloquent la décharge (décharge autorisée en dehors).
   * "allow" : la décharge est autorisée uniquement dans les plages.
   */
  mode: DischargeScheduleMode;
  /** Liste des plages. Une liste vide ne restreint rien. */
  windows: TimeWindow[];
}

export interface ChargeScheduleConfig {
  /** Active la recharge manuelle forcée. */
  enabled: boolean;
  /** Puissance de charge forcée en W. */
  power: number;
  /** Plages pendant lesquelles la charge forcée est active. */
  windows: TimeWindow[];
}

export interface DischargeControlConfig {
  /** SINSTS2 doit dépasser cette valeur pour démarrer la décharge. */
  startAboveGridW: number;
  /** Durée pendant laquelle SINSTS2 doit rester haut avant de démarrer. */
  startDelayMs: number;
  /** Puissance de la première consigne de décharge. */
  startPowerW: number;
  /** Plafond de la consigne initiale calculée à partir de la charge estimée. */
  maxInitialPowerW: number;
  /** La batterie met ~15 à 18 s à démarrer une décharge depuis la veille. */
  startupSettleMs: number;
  /** Intervalle entre deux ajustements de décharge. */
  adjustIntervalMs: number;
  /** Si SINSTS2 reste au-dessus de cette valeur, on augmente la décharge. */
  rampUpAboveGridW: number;
  /** Pas de montée en puissance. */
  rampUpStepW: number;
  /** Si SINSTS2 est inférieur ou égal à cette valeur, on envisage une baisse. */
  rampDownBelowGridW: number;
  /** Pas de baisse en puissance. */
  rampDownStepW: number;
  /** Il faut que SINSTS2 reste à zéro pendant ce délai avant de baisser. */
  zeroHoldMs: number;
  /** En dessous de cette puissance, la décharge est considérée arrêtée. */
  minPowerW: number;
  /** Durée à zéro avant de repasser en veille. */
  stopDelayMs: number;
  /** Après un arrêt de décharge, délai avant d'autoriser une charge (anti-oscillation). */
  cooldownAfterMs: number;
  /** Plages horaires qui limitent la décharge. La charge n'est pas affectée. */
  schedule: DischargeScheduleConfig;
}

export interface ControlConfig {
  /** Période de la boucle de régulation (les capteurs sont lus plus souvent). */
  tickIntervalMs: number;
  /** Constante de temps du lissage de SINSTS2 (bruit Linky). */
  gridEmaTauMs: number;
  /** Constante de temps du lissage de la charge estimée de la phase 2. */
  loadEmaTauMs: number;
  /** Au-delà de cet âge, l'estimation de charge n'est plus utilisée comme pré-consigne. */
  loadEstimateMaxAgeMs: number;
  /** Si Linky ou batterie n'ont pas répondu depuis ce délai, mise en standby. */
  dataTimeoutMs: number;
  /** Après un retour des données, attente avant de reprendre le contrôle. */
  recoveryDelayMs: number;
  /** Une commande n'est envoyée que si la consigne change d'au moins cette valeur. */
  minCommandDeltaW: number;
  /** Arrondi des consignes de puissance. */
  commandRoundingW: number;
  /** Borne de sécurité pour l'estimation de charge. */
  maxEstimatedLoadW: number;
  charge: ChargeControlConfig;
  discharge: DischargeControlConfig;
}

export interface HistoryDatabaseConfig {
  enabled: boolean;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  /** Les tables de visualisation sont alimentées toutes les 10 s. */
  intervalMs: number;
  /** Purge des lignes plus vieilles que cette durée. */
  retentionHours: number;
  /** Fréquence de purge (inutile de la faire toutes les 10 s). */
  cleanupIntervalMs: number;
  connectTimeoutMs: number;
}

export interface SolarHistoryDatabaseConfig {
  /** Base `panneaux` : utilisée uniquement en lecture par les scripts d'historique. */
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  connectTimeoutMs: number;
}

export interface DatabaseConfig {
  history: HistoryDatabaseConfig;
  solarHistory: SolarHistoryDatabaseConfig;
}

export interface LocalHistoryConfig {
  /** Fichier JSONL local, une ligne par seconde. Désactivé par défaut (usure SD). */
  enabled: boolean;
  directory: string;
  intervalMs: number;
  retentionDays: number;
}

export interface LoggingConfig {
  level: LogLevel;
  /** Ligne de synthèse périodique dans la console. */
  statusIntervalMs: number;
}

export interface LocalApiConfig {
  /** Active l'API HTTP locale en cache. */
  enabled: boolean;
  /** Interface d'écoute : 127.0.0.1 pour le Pi, 0.0.0.0 pour le LAN. */
  host: string;
  port: number;
  /** Autorise POST /properties/write. Désactivé par défaut. */
  allowWrite: boolean;
}

export interface AppConfig {
  battery: BatteryConfig;
  linky: LinkyConfig;
  solar: SolarConfig;
  control: ControlConfig;
  database: DatabaseConfig;
  localHistory: LocalHistoryConfig;
  localApi: LocalApiConfig;
  logging: LoggingConfig;
  /** Mode lecture seule : aucune commande n'est envoyée à la batterie. */
  dryRun: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// API batterie / Linky / solaire
// ─────────────────────────────────────────────────────────────────────────────

export interface BatteryProperties {
  electricLevel: number;
  outputHomePower: number;
  gridInputPower: number;
  packInputPower: number;
  outputPackPower: number;
  acMode: number;
  inputLimit: number;
  outputLimit: number;
  smartMode: number;
  minSoc: number;
  socSet: number;
  socLimit: number;
  chargeMaxLimit: number;
  inverseMaxPower: number;
  packState: number;
  faultLevel: number;
  is_error: number;
  gridState: number;
  acStatus: number;
  writeRsp: number;
  ts: number;
  dataReady: number;
}

export interface BatteryPackData {
  sn: string;
  state: number;
  power: number;
  socLevel: number;
  maxTemp?: number;
  totalVol?: number;
  batcur?: number;
}

export interface BatteryReport {
  timestamp: number;
  messageId: number;
  sn: string;
  version?: number;
  product?: string;
  properties: BatteryProperties;
  packData?: BatteryPackData[];
}

export interface BatteryWriteResponse {
  timestamp: number;
  messageId: number;
  success: boolean;
  code: number;
  sn: string;
}

/** Vue simplifiée de la batterie utilisée par le contrôleur et les logs. */
export interface BatterySnapshot {
  fetchedAt: number;
  socPercent: number;
  outputW: number;
  inputW: number;
  packState: number;
  packPowerW: number;
  acMode: number;
  inputLimitW: number;
  outputLimitW: number;
  smartMode: number;
  minSocRaw: number;
  socSetRaw: number;
  fault: boolean;
  faultLevel: number;
  isError: number;
  /** Vrai si faultLevel=1 + socLimit>0 près du SOC minimum : protection basse non bloquante. */
  lowSocProtection: boolean;
  gridState: number;
  dataReady: boolean;
  socLimit: number;
  ts: number;
  hardwareMaxChargeW: number;
  hardwareMaxDischargeW: number;
}

export interface LinkyEntry {
  Date: string;
  Nom: string;
  Description?: string;
  Valeur: string;
  Unite?: string;
}

export interface LinkyResponse {
  data: LinkyEntry[];
  meta?: {
    length?: number;
    lastSeen?: string;
    ageSeconds?: number;
    stale?: boolean;
    staleAfterSeconds?: number;
  };
}

/** Vue simplifiée du Linky. `controlW` est la valeur utilisée par la régulation. */
export interface LinkySnapshot {
  fetchedAt: number;
  measuredAt: number;
  ageMs: number;
  stale: boolean;
  values: Record<string, number>;
  /** Valeur du champ `controlField` (SINSTS2) utilisée par la régulation. */
  controlW: number;
  /** Valeur du champ `logField` (SINSTS2) écrite dans la table `conso`. */
  logW: number;
  /** Total SINSTS des trois phases, conservé pour information/debug. */
  totalW: number;
}

export interface SolarProductionEntry {
  type: string;
  activeCount?: number;
  readingTime?: number;
  wNow: number;
  whLifetime?: number;
}

export interface SolarResponse {
  production: SolarProductionEntry[];
  consumption?: SolarProductionEntry[];
  storage?: unknown[];
}

/** Vue simplifiée de la production solaire. */
export interface SolarSnapshot {
  fetchedAt: number;
  measuredAt: number;
  ageMs: number;
  stale: boolean;
  productionW: number;
}

/** Données prêtes à être écrites dans la base de visualisation. */
export interface HistoryValues {
  consoW: number | null;
  powerW: number | null;
  solarW: number | null;
  /** Niveau de charge de la batterie (%) pour la table `soc`. */
  socPercent: number | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Contrôleur
// ─────────────────────────────────────────────────────────────────────────────

export type ControlMode = "idle" | "charging" | "discharging" | "fault";
export type CommandMode = "standby" | "charge" | "discharge";

export interface ControlInput {
  now: number;
  gridW: number | null;
  gridValid: boolean;
  solarW: number | null;
  solarValid: boolean;
  socPercent: number | null;
  batteryValid: boolean;
  actualOutputW: number;
  actualInputW: number;
  fault: boolean;
  /** Raison structurée du défaut batterie, par exemple "gridState=0" ou "is_error=1". */
  faultReason: string | null;
}

export interface ControlDecision {
  mode: ControlMode;
  commandMode: CommandMode;
  targetPowerW: number;
  reason: string;
  gridEmaW: number | null;
  estimatedLoadW: number | null;
  surplusW: number | null;
  availableLoadW: number | null;
  /** Indique si la décharge est autorisée à l'instant courant par la plage horaire. */
  dischargeAllowed: boolean;
  /** Indique si une recharge manuelle forcée est active. */
  chargeForced: boolean;
}
