# Contrôleur Zendure SolarFlow 800 Plus

Programme TypeScript/Bun qui pilote une batterie **Zendure SolarFlow 800 Plus** à partir :

- de la puissance instantanée **SINSTS2** du Linky (phase 2, celle de la batterie et des panneaux) ;
- de la production solaire totale **`production[0].wNow`** de l'Envoy ;
- de l'état local de la batterie via l'API **zenSDK** (`/properties/report`, `/properties/write`).

Objectifs :

- **charger uniquement depuis le surplus solaire en fonctionnement normal** ; une recharge manuelle forcée peut exceptionnellement charger depuis le réseau sur des plages définies ;
- **décharger au maximum 300 W** pour lisser la décharge dans le temps ;
- **éviter les oscillations** charge/décharge et les pics ;
- respecter une plage de batterie **20 % – 100 %** ;
- **couper charge et décharge** proprement à l'arrêt du programme ;
- journaliser les données dans MySQL toutes les 10 s et purger après 24 h.

---

## 1. Matériel et hypothèses

| Élément | Valeur |
|---|---|
| Batterie | Zendure SolarFlow 800 Plus |
| Capacité | 1 920 Wh |
| Charge max matérielle | 1 000 W |
| Décharge max matérielle | 800 W (le programme la limite volontairement à **300 W**) |
| IP batterie | `BATTERY_IP` (dans `.env`) |
| Numéro de série | `BATTERY_SERIAL` (dans `.env`) |
| Linky | `LINKY_URL`, champ `SINSTS2` (dans `.env`) |
| Panneaux | `SOLAR_URL` (dans `.env`) |
| MySQL visualisation | `MYSQL_HOST` / `MYSQL_USER` / `MYSQL_PASSWORD` (dans `.env`), base `batteries` |
| MySQL historique PV | mêmes identifiants (dans `.env`), base `panneaux` (lecture seule) |

Hypothèses importantes :

- La batterie est **AC-couplée sur la phase 2**, comme les panneaux.
- `SINSTS2` est la puissance apparente **soutirée** sur la phase 2 :
  - `SINSTS2 > 0` : la phase 2 importe ;
  - `SINSTS2 = 0` : la phase 2 n'importe pas (équilibre ou surplus PV).
- Le surplus n'est pas revendu : toute injection est perdue, d'où l'intérêt de charger la batterie.
- Pas de tarification HP/HC : en fonctionnement normal, le programme ne fait **aucune charge volontaire depuis le réseau**. Les ajustements de puissance peuvent provoquer de brefs transitoires d'import de quelques dizaines de watts, corrigés au cycle suivant. La **recharge manuelle forcée** (section 4.6) est l'exception explicite : elle peut charger depuis le réseau pendant ses plages.
- L'API solaire Envoy est actualisée environ **toutes les 5 minutes**. Le Linky, lui, est actualisé toutes les secondes : c'est la boucle de retour rapide.
- La production solaire est supposée entièrement sur la phase 2. Si une partie est sur une autre phase, l'estimation de charge de la phase 2 est approximative ; la régulation par `SINSTS2` reste valable.

---

## 2. Démarrage rapide

Prérequis : **Bun** (version récente, 1.2+ recommandé).

```bash
# à la racine du projet
bun install          # uniquement pour TypeScript et les types (pas nécessaire à l'exécution)
bun run start        # démarrage réel
bun run start:dry    # lecture seule : aucune commande envoyée à la batterie
```

Vérification avant le premier démarrage :

```bash
bun run test:connectivity
```

Le programme :

1. lit la batterie et vérifie le numéro de série ;
2. envoie un **standby persistant** (charge/décharge à 0) ;
3. applique les limites SOC 20 % / 100 % si nécessaire ;
4. démarre les lectures Linky (1 s), batterie (2 s), solaire (30 s) et la régulation (2 s) ;
5. à l'arrêt (`Ctrl+C`, `SIGTERM`, systemd), renvoie un **standby persistant** et vérifie que les limites sont à zéro.

Le programme est prévu pour tourner sur le Raspberry Pi 5, mais il fonctionne aussi depuis le PC Windows pour les tests.

---

## 3. Configuration

Les valeurs non sensibles sont dans **`config.ts`**, avec un commentaire en ligne à côté de chaque variable. Les interfaces et types sont séparés dans **`src/interfaces.ts`**. Les données sensibles (IP, numéro de série, URLs, identifiants MySQL) sont uniquement dans **`.env`**, chargé automatiquement par Bun et ignoré par git.

Les paramètres principaux :

| Paramètre | Défaut | Rôle |
|---|---:|---|
| `battery.minSocPercent` / `maxSocPercent` | 20 / 100 | Plage autorisée, également écrite dans la batterie |
| `battery.maxChargePowerW` | 1000 | Plafond de charge |
| `battery.maxDischargePowerW` | 300 | Plafond de décharge (le matériel accepte 800) |
| `linky.controlField` | `SINSTS2` | Champ utilisé pour la régulation |
| `linky.logField` | `SINSTS2` | Champ stocké dans `conso` : phase 2, identique à la régulation |
| `control.charge.minSolarW` | 80 | Production minimale pour autoriser une charge |
| `control.gridEmaTauMs` | 6000 | Lissage de `SINSTS2` |
| `control.loadEmaTauMs` | 90000 | Lissage de l'estimation de charge de la phase 2 |
| `control.dataTimeoutMs` | 15000 | Au-delà, données invalides → standby |
| `control.recoveryDelayMs` | 10000 | Attente après retour des données |
| `control.charge.startDelayMs` | 20000 | Durée de `SINSTS2 ≈ 0` avant de charger |
| `control.charge.startupSettleMs` | 25000 | Temps laissé à la batterie pour démarrer |
| `control.charge.adjustIntervalMs` | 30000 | Intervalle d'ajustement de charge |
| `control.charge.rampUpStepW` | 100 | Pas de montée en charge |
| `control.charge.backoffAboveGridW` | 50 | Import déclenchant une baisse de charge |
| `control.charge.cooldownAfterMs` | 60000 | Délai charge → décharge |
| `control.charge.schedule` | `{ enabled, power, windows }` | Recharge manuelle forcée, bypass de la régulation |
| `control.discharge.startAboveGridW` | 100 | Seuil de démarrage de décharge |
| `control.discharge.startDelayMs` | 15000 | Durée au-dessus du seuil avant décharge |
| `control.discharge.startupSettleMs` | 25000 | Temps laissé à la batterie pour démarrer |
| `control.discharge.adjustIntervalMs` | 15000 | Intervalle d'ajustement de décharge |
| `control.discharge.rampUpStepW` | 50 | Pas de montée en décharge |
| `control.discharge.rampDownStepW` | 50 | Pas de baisse quand `SINSTS2 = 0` |
| `control.discharge.zeroHoldMs` | 20000 | Attente avant de baisser à `SINSTS2 = 0` |
| `control.discharge.cooldownAfterMs` | 120000 | Délai décharge → charge (anti-oscillation) |
| `control.discharge.schedule` | `{ enabled, mode, windows }` | Plages horaires qui limitent la décharge (la charge n'est pas affectée) |
| `database.history.intervalMs` | 10000 | Écriture MySQL |
| `database.history.retentionHours` | 24 | Purge |
| `localHistory.enabled` | false | JSONL local 1 s (diagnostic, usure SD) |

Création du fichier de secrets :

```bash
cp .env.example .env
# éditer .env avec les valeurs réelles
chmod 600 .env
```

Variables attendues dans `.env` : `BATTERY_IP`, `BATTERY_SERIAL`, `LINKY_URL`, `SOLAR_URL`, `MYSQL_HOST`, `MYSQL_USER`, `MYSQL_PASSWORD`. Aucune de ces valeurs n'apparaît dans `config.ts`, les logs ou la documentation.

---

## 4. Algorithme de régulation

### 4.1 Charge (surplus PV uniquement)

Conditions de démarrage :

- production solaire ≥ `minSolarW` (80 W) ;
- `SINSTS2` ≤ 20 W pendant **20 s** ;
- SOC < 100 % ;
- dernier arrêt de décharge il y a au moins 60 s (cooldown).

Consigne initiale :

- estimation du surplus = `PV - charge estimée de la phase 2` ;
- si l'estimation est fraîche, consigne = `min(300 W, max(100 W, surplus))` ;
- sinon, consigne = **100 W**.

Pendant la charge :

- la batterie met **15 à 18 s** à appliquer la consigne : le programme attend 25 s avant d'ajuster ;
- tous les 30 s, si `SINSTS2` reste ≤ 20 W, la charge augmente de **100 W** (max 1 000 W) ;
- si `SINSTS2` dépasse **50 W** (import réseau), la charge est réduite, idéalement jusqu'au surplus estimé, avec un pas minimal de 100 W ;
- après une réduction, attente de **60 s** avant de remonter (évite les oscillations) ;
- arrêt si la charge tombe à 0 pendant 45 s, si le PV reste sous 80 W pendant 30 s, si le SOC atteint 100 %, ou si l'import dépasse 300 W pendant 30 s.

En fonctionnement normal, la charge n'est **jamais lancée volontairement** à partir du réseau : si `SINSTS2` est positif, elle ne démarre pas ; si l'import apparaît en cours de charge, elle est réduite. Les ajustements peuvent créer de brefs transitoires (quelques dizaines de W), immédiatement corrigés. La seule exception est la **recharge manuelle forcée** décrite en 4.6.

### 4.2 Décharge (consommation maison, max 300 W)

Conditions de démarrage :

- `SINSTS2` ≥ **100 W** pendant **15 s** ;
- SOC > 20 % ;
- dernier arrêt de charge il y a au moins 60 s.

Consigne initiale :

- charge estimée de la phase 2 = `SINSTS2 + PV + décharge actuelle` (bilan de puissance) ;
- si l'estimation est fraîche, consigne = `min(300 W, max(100 W, charge estimée - PV))` ;
- sinon, consigne = **100 W**.

Pendant la décharge :

- la batterie met **15 à 18 s** à démarrer depuis la veille : le programme attend 25 s avant d'ajuster ;
- tous les 15 s, si `SINSTS2` > 80 W, la décharge augmente de **50 W** (max 300 W) ;
- si `SINSTS2` tombe à 0, la décharge est réduite de **50 W** après 20 s, puis à chaque cycle, pour éviter d'injecter sur le réseau ;
- la décharge est maintenue entre les seuils (hystérésis) : pas de va-et-vient pour quelques watts ;
- arrêt si la consigne tombe à 0 pendant 60 s ou si le SOC atteint 20 %.

### 4.3 Anti-oscillation

Le programme combine plusieurs protections :

- **hystérésis** : charge si `SINSTS2 ≤ 20 W`, décharge si `SINSTS2 ≥ 100 W`, zone morte entre les deux ;
- **délais de démarrage** : 20 s pour la charge, 15 s pour la décharge ;
- **cooldowns** : 60 s charge → décharge, 120 s décharge → charge ;
- **lissage EMA** de `SINSTS2` (constante 6 s) ;
- **estimation de charge** lissée sur 90 s, utilisée comme pré-consigne ;
- **attente de 25 s** après chaque démarrage, car la batterie est lente ;
- **commandes limitées** : arrondi 10 W, pas de commande si le changement est inférieur à 20 W, délai minimum entre commandes ;
- **pas de commande répétée** : le programme ne renvoie pas la même consigne en boucle.

### 4.4 Sécurité

- Lecture de la batterie refusée si le **numéro de série** ne correspond pas.
- `faultLevel >= 2`, `is_error`, `dataReady=0` ou `gridState != 1` → **standby**.
- **Protection SOC bas** : `faultLevel=1` avec `socLimit>0` près du SOC minimum n'est **pas** un défaut bloquant. La décharge reste coupée, mais la **charge PV est autorisée** pour remonter le SOC. La protection est considérée non bloquante jusqu'à `SOC minimum + 5 %` pour permettre la récupération.
- Les logs distinguent clairement l'état de la batterie :
  - `SOC minimum atteint (20%) — décharge terminée` ou `SOC sous le seuil (18% < 20%)` : fin de décharge normale ;
  - `protection SOC bas non bloquante: faultLevel=1, socLimit=2; charge PV autorisée` : protection basse normale, charge autorisée ;
  - `Batterie: gridState=0, SOC minimum (20%)` : batterie hors réseau à son minimum, standby ;
  - `Batterie: faultLevel=...` (≥ 2) ou `is_error=...` : défaut matériel ou erreur interne ;
  - `Batterie: dataReady=0` : données non prêtes, attente avant reprise.
- Linky ou batterie sans réponse depuis **15 s** → **standby**.
- Retour des données → attente de 10 s avant de reprendre.
- SOC ≤ 20 % → aucune décharge ; SOC ≥ 100 % → aucune charge.
- **Démarrage** : standby persistant avant tout contrôle (efface un état laissé par une exécution précédente).
- **Arrêt** : standby persistant, jusqu'à 3 tentatives, vérification des limites à zéro.
- Si le processus est tué brutalement (`SIGKILL`, coupure), la batterie peut conserver la dernière consigne en RAM. Le service systemd avec `Restart=always` redémarre le programme, qui renvoie immédiatement un standby. Pour une protection maximale, alimenter le Raspberry Pi par onduleur.

### 4.5 Plages horaires de décharge

La décharge peut être limitée par une ou plusieurs plages horaires. **La charge n'est jamais bloquée par ces plages** : le surplus PV peut toujours charger la batterie.

Dans `config.ts`, section `control.discharge` :

```ts
schedule: {
  enabled: true,
  mode: "block",
  windows: [
    { start: "22:00", end: "06:00" }, // décharge bloquée la nuit
    { start: "12:00", end: "14:00" },
  ],
},
```

Deux modes :

| Mode | Comportement |
|---|---|
| `"block"` | les plages **bloquent** la décharge ; elle est autorisée en dehors |
| `"allow"` | la décharge est autorisée **uniquement** dans les plages |

Règles :

- `enabled: false` désactive la restriction ;
- une liste `windows` vide ne restreint rien ;
- une plage `22:00` → `06:00` traverse minuit ;
- l'heure de fin est exclue : `06:00` signifie que le blocage s'arrête à 06:00 ;
- `start === end` représente une plage de 24 h ;
- les heures sont évaluées en **heure locale du Raspberry Pi** (`timedatectl`) ;
- si la décharge est active quand une plage de blocage commence, elle est coupée ;
- si une plage se termine, la décharge peut reprendre selon les conditions habituelles (`SINSTS2`, SOC, cooldowns). Le cooldown anti-oscillation après une décharge reste actif, mais il est indépendant de la plage horaire.

L'état est visible dans les logs :

```text
décharge=autorisée
décharge=bloquée
Décharge bloquée par la plage horaire
```

### 4.6 Recharge manuelle forcée

Cette fonction permet de **forcer une charge**, y compris depuis le réseau, pendant des plages définies. Elle est indépendante du surplus PV et de `SINSTS2`.

Dans `config.ts`, section `control.charge` :

```ts
schedule: {
  enabled: true,
  power: 500,
  windows: [
    { start: "22:00", end: "23:00" },
  ],
},
```

Pendant une plage active :

- la charge est forcée à `power` W ;
- les paramètres normaux de charge sont ignorés : `SINSTS2`, production PV, seuils de démarrage, rampes, retour arrière, arrêt sur import, SOC minimum, cooldowns et plage de décharge ;
- la batterie peut donc **importer du réseau** ;
- la charge reste soumise aux sécurités : batterie et Linky valides, absence de défaut bloquant, SOC < 100 %, puissance plafonnée à `battery.maxChargePowerW` et à la limite matérielle ;
- si le SOC atteint 100 % pendant la plage, la charge s'arrête et attend la fin de la plage ;
- si la plage se termine pendant une charge forcée, la charge forcée s'arrête et la régulation normale reprend.

`enabled: false`, une liste `windows` vide ou `power: 0` désactivent la recharge forcée.

Les règles horaires sont les mêmes que pour la décharge : heure locale du Raspberry Pi, fin exclue, plages qui traversent minuit, `start === end` = 24 h.

Logs associés :

```text
Recharge forcée: 500 W forcés: 22:00-23:00
recharge=forcée
[PLAGE] Recharge forcée activée (500 W).
[PLAGE] Recharge forcée terminée (500 W).
```

> La recharge forcée est prioritaire sur la régulation et peut consommer du réseau. À utiliser manuellement et avec prudence.

---

## 5. Timings mesurés sur le matériel

Mesures effectuées avec `tests/timing.ts` (SOC 45 %, sans vider la batterie) :

| Mesure | Valeur observée |
|---|---|
| Requête `/properties/report` | ~60–100 ms |
| Écriture `/properties/write` | ~50–130 ms |
| Démarrage réel d'une charge depuis la veille | **~16 s** |
| Démarrage réel d'une décharge depuis la veille | **~16 s** |
| Montée de 300 W → 600 W en charge | ~6 s une fois la batterie active |
| Montée de 100 W → 300 W en décharge | ~3 s une fois la batterie active |
| Transition charge ↔ décharge | ~3–16 s selon le sens et l'état interne |
| Arrêt charge/décharge | ~1–4 s |
| Mise à jour Linky | 1 s |
| Mise à jour Envoy | ~4–5 min (selon `readingTime`) |

Conséquence : la régulation **ne doit pas** réagir toutes les secondes. Les intervalles de 15–30 s et l'attente de 25 s après démarrage sont volontaires.

---

## 6. Base de données de visualisation

La base `batteries` est alimentée toutes les **10 s**. La table `soc` est fournie dans **`database/schema.sql`** (`CREATE TABLE IF NOT EXISTS`) ; le programme ne modifie pas les trois tables existantes.

| Table | Contenu | Convention |
|---|---|---|
| `conso` | puissance Linky **phase 2** `SINSTS2` | W, phase batterie + panneaux |
| `power` | puissance AC de la batterie | **négatif = charge**, **positif = décharge** |
| `solar` | production PV totale `wNow` | W |
| `soc` | niveau de charge de la batterie | **% (0-100)** |

Exemple de valeurs :

- `power = -500` : la batterie charge à 500 W ;
- `power = +300` : la batterie décharge à 300 W ;
- `power = 0` : standby ;
- `soc = 45` : la batterie est à 45 %.

Les lignes des quatre tables de plus de **24 h** sont supprimées automatiquement (toutes les 10 min). Les colonnes `Date` sont écrites en **heure locale du Raspberry Pi** : vérifier le fuseau horaire (`timedatectl`, Europe/Paris) pour que la visualisation soit cohérente.

> La régulation et la table `conso` utilisent toutes les deux **`SINSTS2` (phase 2)**. Le total des trois phases (`SINSTS`) n'est pas stocké dans `conso` ; il reste disponible dans les logs de debug et le fichier local JSONL, si activé.

> Les lignes déjà présentes dans `conso` avant ce changement correspondent à l'ancien champ `SINSTS` (total). Elles seront supprimées automatiquement par la purge 24 h.

La base `panneaux` est utilisée **uniquement en lecture** par `tests/history.ts`. Aucun `INSERT`, `UPDATE` ou `DELETE` n'y est exécuté.

---

## 7. Tests

### 7.1 Connectivité (lecture seule)

```bash
bun run test:connectivity
```

Vérifie la batterie, le Linky, le solaire, la base `batteries` et la base `panneaux`. Aucune commande n'est envoyée.

### 7.2 Contrôleur (unitaire, sans matériel)

```bash
bun test
```

49 tests couvrent : charge/décharge, plafonds 300 W/1 000 W, SOC 20/100 %, absence de charge la nuit, retour arrière sur import, cooldowns, anti-oscillation, classification des défauts batterie, plages horaires de décharge, recharge manuelle forcée, données invalides.

### 7.3 Timing batterie (réel, ~3,5 min)

```bash
bun run test:timing
```

Enchaîne des consignes de charge (100/300/600 W), des décharges (100/300 W) et des transitions. Le test :

- vérifie le SOC avant de commencer ;
- refuse de décharger sous 30 % ou de charger au-dessus de 90 % ;
- reste dans une plage sûre (SOC initial 45 % ici, variation < 1 %) ;
- écrit ses échantillons dans MySQL toutes les 10 s ;
- produit `data/timing-*.jsonl` (1 s) et `data/timing-summary-*.json` ;
- termine toujours par un **standby persistant**.

> Les phases de charge 600 W peuvent importer du réseau : c'est volontaire pour mesurer la réponse de `SINSTS2` et la latence. Le programme normal, lui, ne charge jamais depuis le réseau.

### 7.4 Historique (lecture seule)

```bash
bun run test:history
```

Analyse les dernières 24 h de `batteries` et les 7 derniers jours de `panneaux.PINST` : énergie chargée/déchargée, production quotidienne, pic, plages horaires. Aucune écriture.

Résultat observé sur l'installation : production solaire de **5 à 11 kWh/jour**, pic ~**2 kW**, consommation phase 2 variable (quelques centaines de W à ~1,4 kW). La batterie de 1,92 kWh représente donc une fraction de la production quotidienne ; elle est faite pour lisser, pas pour tout stocker.

### 7.5 Smoke test de bout en bout (~50 s)

```bash
bun run test:smoke
```

Lance le **vrai programme** pendant 45 s, l'arrête automatiquement, puis vérifie dans les logs et sur la batterie :

- `Arrêt automatique` et `Standby persistant envoyé` ;
- `inputLimit = 0`, `outputLimit = 0`, puissance réelle ≈ 0.

C'est ce test qui valide l'exigence « arrêt du script = batterie en standby ».

### 7.6 Test manuel en lecture seule

```bash
bun run start:dry
```

Affiche les décisions que prendrait le programme sans toucher à la batterie. `Ctrl+C` pour arrêter.

Pour un arrêt automatique propre (utile en test) :

```bash
bun run src/main.ts --stop-after-seconds=45
```

---

## 8. Installation sur Raspberry Pi 5

### 8.1 Bun

```bash
curl -fsSL https://bun.sh/install | bash
# ou suivre https://bun.sh/docs/installation
```

Vérifier :

```bash
bun --version
```

### 8.2 Copie du projet

```bash
mkdir -p /home/pi/zendure
# copier les fichiers du projet dans /home/pi/zendure
cd /home/pi/zendure
bun install        # optionnel pour l'exécution, utile pour tsc et les tests
bun run test:connectivity
```

Renseigner `.env` avec les valeurs du réseau local. Sur le Pi, les services MySQL et Envoy sont locaux : les URLs peuvent pointer vers `127.0.0.1` si vous le souhaitez, mais elles restent dans `.env` et ne sont jamais exposées dans `config.ts`.

### 8.3 Service systemd

Un exemple est fourni dans `systemd/zendure.service.example` :

```ini
[Unit]
Description=Contrôleur Zendure SolarFlow 800 Plus
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/zendure
ExecStart=/home/pi/.bun/bin/bun run src/main.ts
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=20
Environment=NODE_ENV=production
EnvironmentFile=/home/pi/zendure/.env

[Install]
WantedBy=multi-user.target
```

Installation :

```bash
sudo cp systemd/zendure.service.example /etc/systemd/system/zendure.service
sudo systemctl daemon-reload
sudo systemctl enable --now zendure
sudo systemctl status zendure
journalctl -u zendure -f
```

`Restart=always` garantit qu'après un crash le programme redémarre et renvoie d'abord un standby, puis reprend la régulation.

Pour arrêter proprement :

```bash
sudo systemctl stop zendure
```

systemd envoie `SIGTERM` ; le programme met la batterie en standby avant de quitter (délai max 20 s).

---

## 9. Structure du projet

```
.env                          données sensibles (ignoré par git)
.env.example                  modèle sans secrets
config.ts                     valeurs non sensibles, commentaires en ligne
src/interfaces.ts             toutes les interfaces et types partagés
src/main.ts                   démarrage, boucles de lecture, commandes, arrêt
src/controller.ts             machine à états et régulation (sans I/O)
src/schedule.ts               plages horaires de décharge
src/devices/battery.ts        client zenSDK (report / write / standby / SOC)
src/devices/linky.ts          client Linky (SINSTS, SINSTS2…)
src/devices/solar.ts          client Envoy (wNow)
src/database.ts               écriture MySQL 10 s + purge 24 h
database/schema.sql           création de la table soc
src/local-history.ts          JSONL local 1 s (optionnel)
src/http.ts                   fetch JSON avec timeout
src/logger.ts                 logs console
tests/connectivity.ts         vérification lecture seule
tests/timing.ts               mesure des latences réelles
tests/history.ts              analyse des historiques (lecture seule)
tests/controller.test.ts      tests unitaires du contrôleur
tests/schedule.test.ts        tests des plages horaires
tests/battery-fault.test.ts   tests de classification des défauts batterie
tests/main-smoke.ts           test de bout en bout + standby
systemd/zendure.service.example
data/                         historiques locaux (ignoré par git)
```

---

## 10. Limites connues et précautions

- **API batterie injoignable** : si le réseau ou l'API locale de la batterie tombe alors que l'onduleur continue, le programme ne peut plus lui envoyer de commande. La dernière consigne RAM peut rester active. Utiliser un réseau stable, un service systemd et, idéalement, un onduleur pour le Pi.
- **Arrêt brutal** : `SIGKILL` ou coupure électrique ne déclenche pas le standby. Le redémarrage du service renvoie un standby immédiat. Éviter `kill -9`.
- **`SINSTS2` est une puissance apparente (VA)**, alors que `wNow` est une puissance active (W). L'estimation de charge est approximative ; la régulation par `SINSTS2` reste le retour principal.
- **Production PV répartie** : l'estimation suppose que tous les panneaux sont sur la phase 2. Si ce n'est pas le cas, la pré-consigne est moins précise, mais l'asservissement sur `SINSTS2` corrige.
- **API Envoy lente** : la production peut avoir 4–5 minutes de retard. Le programme ne l'utilise que comme garde-fou ; le Linky assure la rapidité.
- **Charge réseau** : en fonctionnement normal, aucune charge volontaire depuis le réseau. La **recharge manuelle forcée** (`control.charge.schedule`) permet de charger depuis le réseau sur des plages définies ; elle est prioritaire sur la régulation et doit être utilisée avec prudence.
- **`smartMode`** : les commandes de régulation utilisent `smartMode=1` (pas d'écriture flash). Le standby d'arrêt utilise `smartMode=0` pour persister les limites à zéro. Selon le firmware, la lecture de `smartMode` peut afficher 1 après l'écriture ; ce sont les limites `inputLimit`/`outputLimit` à zéro qui font foi.
- **SOC** : la batterie applique aussi ses propres limites `minSoc`/`socSet` ; le programme les vérifie et les écrit si elles diffèrent.
- **Secrets** : `.env` contient les IP, le numéro de série, les URLs et les identifiants MySQL. Il est ignoré par git et doit rester en `chmod 600`. `config.ts` ne contient que des noms de variables, et les logs/erreurs n'affichent pas ces valeurs.

---

## 11. Dépannage

| Symptôme | Piste |
|---|---|
| `Numéro de série inattendu` | Vérifier `BATTERY_SERIAL` et `BATTERY_IP` dans `.env` ; ne jamais forcer un autre SN |
| Batterie inaccessible | API locale zenSDK désactivée ? Réseau ? Vérifier `BATTERY_IP` dans `.env` |
| Linky `?` / périmé | Vérifier `LINKY_URL` dans `.env` et `meta.stale` |
| Panneaux `?` | Vérifier `SOLAR_URL` dans `.env` et `production[0].wNow` |
| Base MySQL inaccessible | Vérifier `MYSQL_HOST`, `MYSQL_USER`, `MYSQL_PASSWORD` dans `.env` et la base `batteries` |
| La batterie ne charge pas | Vérifier `SINSTS2=0` pendant 20 s, PV ≥ 80 W, SOC < 100 %, pas de cooldown |
| La batterie ne décharge pas | Vérifier `SINSTS2 ≥ 100 W` pendant 15 s, SOC > 20 %, pas de cooldown, et `control.discharge.schedule` / heure locale |
| La recharge forcée ne démarre pas | Vérifier `control.charge.schedule` (`enabled`, `power`, `windows`), l'heure locale, SOC < 100 %, données Linky/batterie valides et absence de défaut bloquant |
| Charge qui oscille | Augmenter `settleAfterBackoffMs`, réduire `rampUpStepW`, augmenter `backoffAboveGridW` |
| Décharge qui oscille | Augmenter `zeroHoldMs`/`cooldownAfterMs`, réduire `rampDownStepW` |
| Le standby final n'est pas confirmé | Le programme réessaie 3 fois ; vérifier l'API batterie et les logs |

---

## 12. Résumé

- Le programme est prévu pour tourner en continu sur le Raspberry Pi, en service systemd.
- Il charge normalement sur surplus solaire, décharge au maximum 300 W, et lisse toutes les décisions.
- Une recharge manuelle forcée peut être planifiée dans `control.charge.schedule` (puissance et plages horaires).
- Il tient compte de la latence réelle de la batterie (~16 s) et de l'API PV (~5 min).
- Il journalise dans MySQL toutes les 10 s, purge après 24 h, et fournit des scripts de test complets.
- À l'arrêt, il envoie un standby persistant et vérifie que la batterie ne charge plus et ne décharge plus.
