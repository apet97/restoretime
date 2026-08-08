// Environment configuration (docs/05 §Configuration). No config files, no defaults for
// secrets — every value that matters at runtime comes from the process environment.

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface AppConfig {
  readonly port: number;
  readonly publicBaseUrl: string;
  readonly clockifyParentOrigin: string;
  readonly databasePath: string;
  readonly addonKey: string;
  readonly tokenEncryptionKeyHex: string;
  readonly logLevel: LogLevel;
}

const DEFAULT_PORT = 8080;
const DEFAULT_LOG_LEVEL: LogLevel = "info";
const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing required environment variable ${name}.`);
  }
  return value;
}

function readPort(env: NodeJS.ProcessEnv): number {
  const raw = env.PORT;
  if (raw === undefined || raw.trim() === "") return DEFAULT_PORT;
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`PORT must be an integer between 1 and 65535, got ${JSON.stringify(raw)}.`);
  }
  return port;
}

function readLogLevel(env: NodeJS.ProcessEnv): LogLevel {
  const raw = env.LOG_LEVEL;
  if (raw === undefined || raw.trim() === "") return DEFAULT_LOG_LEVEL;
  if (!LOG_LEVELS.includes(raw as LogLevel)) {
    throw new Error(`LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")}, got ${JSON.stringify(raw)}.`);
  }
  return raw as LogLevel;
}

/** Loads and validates configuration. Throws with an actionable message on any bad value. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: readPort(env),
    publicBaseUrl: requireEnv(env, "PUBLIC_BASE_URL"),
    clockifyParentOrigin: requireEnv(env, "CLOCKIFY_PARENT_ORIGIN"),
    databasePath: requireEnv(env, "DATABASE_PATH"),
    addonKey: requireEnv(env, "ADDON_KEY"),
    tokenEncryptionKeyHex: requireEnv(env, "TOKEN_ENCRYPTION_KEY"),
    logLevel: readLogLevel(env),
  };
}
