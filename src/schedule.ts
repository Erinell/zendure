import type { DischargeScheduleConfig, DischargeScheduleWindow } from "./interfaces";

/** Convertit "HH:MM" en minutes depuis minuit. "24:00" est accepté pour la fin de journée. */
export function parseTimeToMinutes(value: string): number {
  const trimmed = value.trim();
  if (trimmed === "24:00") return 24 * 60;
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(trimmed);
  if (!match) {
    throw new Error(`Heure invalide "${value}" (format attendu HH:MM)`);
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Heure locale (celle du Raspberry Pi) en minutes depuis minuit. */
function localMinutes(now: number): number {
  const date = new Date(now);
  return date.getHours() * 60 + date.getMinutes();
}

/**
 * Indique si l'instant courant est dans une plage.
 * - plage normale : [start, end[
 * - plage qui traverse minuit (ex. 22:00-06:00) : [start, 24h[ ∪ [0h, end[
 * - start === end : plage de 24 h
 */
export function isTimeInWindow(now: number, window: DischargeScheduleWindow): boolean {
  const start = parseTimeToMinutes(window.start);
  const end = parseTimeToMinutes(window.end);
  if (start === end) return true;

  const minutes = localMinutes(now);
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;
}

/**
 * Applique la restriction horaire à la décharge.
 *
 * Une plage vide ou `enabled=false` ne restreint rien.
 * - mode "block" : la décharge est bloquée dans les plages, autorisée dehors.
 * - mode "allow" : la décharge est autorisée uniquement dans les plages.
 */
export function isDischargeAllowed(now: number, schedule: DischargeScheduleConfig): boolean {
  if (!schedule.enabled || schedule.windows.length === 0) return true;

  const inside = schedule.windows.some((window) => isTimeInWindow(now, window));
  return schedule.mode === "allow" ? inside : !inside;
}

/** Valide les plages au démarrage pour éviter une erreur silencieuse à l'exécution. */
export function validateDischargeSchedule(schedule: DischargeScheduleConfig): void {
  if (!schedule.enabled) return;
  if (schedule.mode !== "block" && schedule.mode !== "allow") {
    throw new Error(`discharge.schedule.mode invalide: "${schedule.mode}" (attendu "block" ou "allow")`);
  }
  if (!Array.isArray(schedule.windows)) {
    throw new Error("discharge.schedule.windows doit être un tableau");
  }

  for (const window of schedule.windows) {
    const start = parseTimeToMinutes(window.start);
    const end = parseTimeToMinutes(window.end);
    if (start >= 24 * 60) {
      throw new Error(`discharge.schedule: l'heure de début "${window.start}" doit être < 24:00`);
    }
    if (end > 24 * 60) {
      throw new Error(`discharge.schedule: l'heure de fin "${window.end}" est invalide`);
    }
  }
}

/** Résumé lisible pour le log de démarrage. */
export function describeDischargeSchedule(schedule: DischargeScheduleConfig): string {
  if (!schedule.enabled) return "désactivée (décharge autorisée à toute heure)";
  if (schedule.windows.length === 0) return "aucune plage (décharge autorisée à toute heure)";
  const mode = schedule.mode === "block" ? "blocage" : "autorisation";
  return `${mode}: ${schedule.windows.map((window) => `${window.start}-${window.end}`).join(", ")}`;
}
