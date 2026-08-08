// Structured JSON logger to stdout. No logging framework (implementation/DEPENDENCIES.md
// rejects one). Fields are limited to IDs, states, and error codes by every call site — this
// module does not enforce that; docs/12 "Data protection" and code review do.

import type { LogLevel } from "./config.js";

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(level: LogLevel = "info"): Logger {
  const threshold = LEVEL_RANK[level];

  function write(entryLevel: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (LEVEL_RANK[entryLevel] < threshold) return;
    const line = { time: new Date().toISOString(), level: entryLevel, msg, ...fields };
    process.stdout.write(`${JSON.stringify(line)}\n`);
  }

  return {
    debug: (msg, fields) => write("debug", msg, fields),
    info: (msg, fields) => write("info", msg, fields),
    warn: (msg, fields) => write("warn", msg, fields),
    error: (msg, fields) => write("error", msg, fields),
  };
}
