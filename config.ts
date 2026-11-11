/**
 * Configuration du contrôleur Zendure SolarFlow 800 Plus.
 * Puissances en watts (W), durées en millisecondes (ms), SOC en pourcentage (0-100).
 */

import type { AppConfig } from "./src/interfaces";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(
      `Variable d'environnement manquante: ${name}. ` +
        `Copier .env.example vers .env puis renseigner les valeurs.`,
    );
  }
  return value;
}

const batteryIp = requireEnv("BATTERY_IP");
const batterySerial = requireEnv("BATTERY_SERIAL");
const linkyUrl = requireEnv("LINKY_URL");
const solarUrl = requireEnv("SOLAR_URL");
const mysqlHost = requireEnv("MYSQL_HOST");
const mysqlUser = requireEnv("MYSQL_USER");
const mysqlPassword = requireEnv("MYSQL_PASSWORD");

export const CONFIG: AppConfig = {
  battery: { // batterie Zendure SolarFlow 800 Plus
    ip: batteryIp, // adresse IP de la batterie (BATTERY_IP dans .env)
    serialNumber: batterySerial, // numéro de série attendu (BATTERY_SERIAL dans .env)
    capacityWh: 1920, // capacité nominale (Wh)
    minSocPercent: 20, // SOC minimum autorisé (%)
    maxSocPercent: 100, // SOC maximum autorisé (%)
    maxChargePowerW: 1000, // puissance de charge maximale (W)
    maxDischargePowerW: 300, // puissance de décharge maximale (W), volontairement limitée
    hardwareMaxChargePowerW: 1000, // limite matérielle de charge (W)
    hardwareMaxDischargePowerW: 800, // limite matérielle de décharge (W)
    pollIntervalMs: 2_000, // lecture de la batterie (ms)
    requestTimeoutMs: 3_000, // timeout HTTP batterie (ms)
    minCommandIntervalMs: 2_000, // délai minimum entre deux commandes (ms)
    commandRetryMs: 5_000, // délai avant de réessayer une commande échouée (ms)
    statusReadDelayMs: 1_000, // attente avant relecture après une commande (ms)
  },

  linky: { // compteur Linky (API locale)
    url: linkyUrl, // API du Linky (LINKY_URL dans .env)
    controlField: "SINSTS2", // champ de régulation : phase 2 (batterie + panneaux)
    logField: "SINSTS2", // champ stocké dans la table conso (phase 2, comme la régulation)
    pollIntervalMs: 1_000, // lecture du Linky (ms)
    requestTimeoutMs: 2_000, // timeout HTTP Linky (ms)
    maxDataAgeMs: 10_000, // âge maximal d'une mesure valide (ms)
  },

  solar: { // production solaire (Envoy)
    url: solarUrl, // API de production (SOLAR_URL dans .env)
    pollIntervalMs: 30_000, // lecture solaire (ms), l'Envoy se met à jour toutes les ~5 min
    requestTimeoutMs: 5_000, // timeout HTTP solaire (ms)
    maxDataAgeMs: 15 * 60_000, // âge maximal de la mesure solaire (ms)
  },

  control: { // régulation
    tickIntervalMs: 2_000, // période de la boucle de régulation (ms)
    gridEmaTauMs: 6_000, // lissage de SINSTS2 (ms)
    loadEmaTauMs: 90_000, // lissage de la charge estimée phase 2 (ms)
    loadEstimateMaxAgeMs: 15 * 60_000, // âge maximal de l'estimation de charge (ms)
    dataTimeoutMs: 15_000, // délai avant standby si Linky/batterie muets (ms)
    recoveryDelayMs: 10_000, // attente après retour des données (ms)
    minCommandDeltaW: 20, // changement minimal pour envoyer une commande (W)
    commandRoundingW: 10, // arrondi des consignes (W)
    maxEstimatedLoadW: 5_000, // borne de sécurité de l'estimation de charge (W)

    charge: { // charge uniquement sur surplus PV (SINSTS2 ≈ 0)
      minSolarW: 80, // production PV minimale pour charger (W)
      startBelowGridW: 20, // SINSTS2 maximal pour démarrer la charge (W)
      startDelayMs: 20_000, // durée de SINSTS2 bas avant démarrage (ms)
      startPowerW: 100, // première consigne de charge (W)
      maxInitialPowerW: 300, // plafond de la consigne initiale issue du surplus (W)
      startupSettleMs: 25_000, // attente après démarrage, mesurée à 15-18 s (ms)
      adjustIntervalMs: 30_000, // intervalle entre ajustements de charge (ms)
      rampUpStepW: 100, // pas de montée en charge (W)
      rampUpBelowGridW: 20, // SINSTS2 maximal pour augmenter la charge (W)
      backoffAboveGridW: 50, // SINSTS2 au-delà duquel on réduit la charge (W)
      targetGridW: 20, // SINSTS2 visé pendant la charge (W)
      backoffMinStepW: 100, // réduction minimale lors d'un retour arrière (W)
      settleAfterBackoffMs: 60_000, // attente après une réduction avant de remonter (ms)
      minPowerW: 30, // puissance minimale de charge (W)
      stopDelayMs: 45_000, // durée à zéro avant de repasser en veille (ms)
      abortAboveGridW: 300, // import réseau excessif déclenchant l'arrêt (W)
      abortDelayMs: 30_000, // durée de l'import excessif avant arrêt (ms)
      solarStopDelayMs: 30_000, // durée de PV insuffisant avant arrêt (ms)
      cooldownAfterMs: 60_000, // délai avant d'autoriser une décharge après charge (ms)

      schedule: { // recharge manuelle forcée : bypass de la régulation pendant les plages
        enabled: false, // activer la recharge forcée
        power: 500, // puissance de charge forcée (W), limitée par maxChargePowerW
        windows: [
          // Ajouter/enlever des plages ici. Exemple : recharge forcée de 22:00 à 23:00.
          // { start: "22:00", end: "23:00" },
        ],
      },
    },

    discharge: { // décharge lissée, plafonnée à 300 W
      startAboveGridW: 100, // SINSTS2 minimal pour démarrer la décharge (W)
      startDelayMs: 15_000, // durée de SINSTS2 haut avant démarrage (ms)
      startPowerW: 100, // première consigne de décharge (W)
      maxInitialPowerW: 300, // plafond de la consigne initiale issue de la charge estimée (W)
      startupSettleMs: 25_000, // attente après démarrage, mesurée à 15-18 s (ms)
      adjustIntervalMs: 15_000, // intervalle entre ajustements de décharge (ms)
      rampUpAboveGridW: 80, // SINSTS2 au-delà duquel on augmente la décharge (W)
      rampUpStepW: 50, // pas de montée en décharge (W)
      rampDownBelowGridW: 5, // SINSTS2 en dessous duquel on envisage une baisse (W)
      rampDownStepW: 50, // pas de baisse en décharge (W)
      zeroHoldMs: 20_000, // durée à SINSTS2=0 avant de baisser (ms)
      minPowerW: 30, // puissance minimale de décharge (W)
      stopDelayMs: 60_000, // durée à zéro avant de repasser en veille (ms)
      cooldownAfterMs: 120_000, // délai avant d'autoriser une charge après décharge (ms)

      schedule: { // plages horaires de décharge (la charge n'est jamais affectée)
        enabled: true, // activer la restriction horaire
        mode: "block", // "block" = ces plages bloquent la décharge ; "allow" = décharge autorisée uniquement dans ces plages
        windows: [
          // { start: "22:00", end: "06:00" },
          // { start: "12:00", end: "14:00" },
        ],
      },
    },
  },

  database: { // bases MySQL
    history: { // base de visualisation `batteries`
      enabled: true, // activer l'écriture des 3 tables
      host: mysqlHost, // hôte MySQL (MYSQL_HOST dans .env)
      port: 3306, // port MySQL
      database: "batteries", // base de visualisation
      user: mysqlUser, // utilisateur MySQL (MYSQL_USER dans .env)
      password: mysqlPassword, // mot de passe MySQL (MYSQL_PASSWORD dans .env)
      intervalMs: 10_000, // écriture d'un échantillon (ms)
      retentionHours: 24, // suppression des lignes plus vieilles (h)
      cleanupIntervalMs: 10 * 60_000, // fréquence de purge (ms)
      connectTimeoutMs: 5_000, // timeout de connexion MySQL (ms)
    },
    solarHistory: { // base `panneaux`, utilisée uniquement en lecture
      host: mysqlHost, // hôte MySQL (MYSQL_HOST dans .env)
      port: 3306, // port MySQL
      database: "panneaux", // base historique PV
      user: mysqlUser, // utilisateur MySQL (MYSQL_USER dans .env)
      password: mysqlPassword, // mot de passe MySQL (MYSQL_PASSWORD dans .env)
      connectTimeoutMs: 5_000, // timeout de connexion MySQL (ms)
    },
  },

  localHistory: { // fichier JSONL local, une ligne par seconde
    enabled: false, // désactivé par défaut (usure carte SD)
    directory: "data", // répertoire des fichiers
    intervalMs: 1_000, // intervalle d'écriture (ms)
    retentionDays: 7, // conservation des fichiers (jours)
  },

  localApi: { // API locale en cache, même structure que l'API batterie
    enabled: true, // activer l'API locale
    host: "127.0.0.1", // 127.0.0.1 = Pi uniquement ; 0.0.0.0 = accessible sur le LAN
    port: 4000, // port HTTP local
    allowWrite: false, // autoriser POST /properties/write (désactivé par défaut)
  },

  logging: {
    level: "info", // debug | info | warn | error
    statusIntervalMs: 10_000, // ligne de synthèse dans la console (ms)
  },

  dryRun: false, // true = lecture seule, aucune commande batterie
};
