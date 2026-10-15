import { loadAuthConfig, type AuthConfig } from "./auth-config";
import { loadGoogleConfig, type GoogleConfig } from "./google-config";

// Startup configuration. Read once from the environment and validated before
// anything connects or listens. Invalid configuration stops startup with every
// problem listed; nothing falls back to a guessed default.

export interface AppConfig {
  readonly port: number;
  readonly mongodbUri: string;
  readonly catalogDbName: string;
  readonly auth: AuthConfig;
  readonly google: GoogleConfig;
}

export const APP_CONFIG = Symbol("APP_CONFIG");

// Every database this app opens starts with this prefix, so a mistyped name
// can never reach the old platform's data.
export const OWNED_DATABASE_PREFIX = "truex_next_";

const DATABASE_NAME = /^[a-z0-9_]{1,63}$/;
const MONGODB_SCHEME = /^mongodb(\+srv)?:\/\//;

export function isOwnedDatabaseName(name: string): boolean {
  return (
    DATABASE_NAME.test(name) &&
    name.startsWith(OWNED_DATABASE_PREFIX) &&
    name.length > OWNED_DATABASE_PREFIX.length
  );
}

export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid configuration:\n- ${problems.join("\n- ")}`);
    this.name = "ConfigError";
  }
}

type Env = Readonly<Record<string, string | undefined>>;

export function loadConfig(env: Env): AppConfig {
  const problems: string[] = [];

  const port = Number(env.PORT);
  if (!env.PORT) problems.push("PORT is required.");
  else if (!Number.isInteger(port) || port < 1 || port > 65_535)
    problems.push("PORT must be an integer from 1 to 65535.");

  // The URI can carry credentials, so problems never echo its value.
  const mongodbUri = env.MONGODB_URI ?? "";
  if (!mongodbUri) problems.push("MONGODB_URI is required.");
  else if (!MONGODB_SCHEME.test(mongodbUri))
    problems.push("MONGODB_URI must start with mongodb:// or mongodb+srv://.");

  const catalogDbName = env.CATALOG_DB_NAME ?? "";
  if (!catalogDbName) problems.push("CATALOG_DB_NAME is required.");
  else if (!isOwnedDatabaseName(catalogDbName))
    problems.push(
      `CATALOG_DB_NAME must start with "${OWNED_DATABASE_PREFIX}" and use only lowercase letters, digits and underscores (max 63 characters).`,
    );

  const auth = loadAuthConfig(env, problems);
  const google = loadGoogleConfig(env, auth?.allowedOrigins, problems);

  if (problems.length > 0 || !auth || !google) throw new ConfigError(problems);
  return { port, mongodbUri, catalogDbName, auth, google };
}
