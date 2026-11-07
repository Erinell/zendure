import type { LogLevel } from "./interfaces";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let currentLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function formatExtra(extra: unknown): string {
  if (extra === undefined) return "";
  if (extra instanceof Error) return ` ${extra.message}`;
  if (typeof extra === "string") return ` ${extra}`;
  try {
    return ` ${JSON.stringify(extra)}`;
  } catch {
    return ` ${String(extra)}`;
  }
}

function localTime(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function write(level: LogLevel, message: string, extra?: unknown): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return;
  const prefix = `[${localTime()}] ${level.toUpperCase().padEnd(5)}`;
  const suffix = formatExtra(extra);
  if (level === "error" || level === "warn") {
    console.error(`${prefix} ${message}${suffix}`);
  } else {
    console.log(`${prefix} ${message}${suffix}`);
  }
}

export const log = {
  debug: (message: string, extra?: unknown) => write("debug", message, extra),
  info: (message: string, extra?: unknown) => write("info", message, extra),
  warn: (message: string, extra?: unknown) => write("warn", message, extra),
  error: (message: string, extra?: unknown) => write("error", message, extra),
};

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
