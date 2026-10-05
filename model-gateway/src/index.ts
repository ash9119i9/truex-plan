import "dotenv/config";
import { MongoClient } from "mongodb";
import { createGateway, drain } from "./server";
import { createProfileStore, type StoredProfile } from "./profiles";

// The gateway is its own service with its own model-gateway/.env. It shares
// only MODEL_GATEWAY_SECRET with the platform (which signs the tokens) and
// the truex_models collection (which holds the provider keys). Models live in
// the shared catalog database (CATALOG_MONGO_DB), common to all tenants; it
// falls back to MONGO_DB and then "truex" for single-database setups.
const secret = process.env.MODEL_GATEWAY_SECRET || "";
if (secret.length < 32) {
  console.error("MODEL_GATEWAY_SECRET must be set to at least 32 characters.");
  process.exit(1);
}

const client = new MongoClient(
  process.env.MONGO_URI || "mongodb://127.0.0.1:27017",
  { serverSelectionTimeoutMS: 3000 },
);

async function main() {
  await client.connect();
  const log = (line: string) => console.log(line);
  const ttl = Number(process.env.PROFILE_CACHE_TTL_MS ?? 30000);
  const db = client.db(
    process.env.CATALOG_MONGO_DB || process.env.MONGO_DB || "truex",
  );
  const profiles = createProfileStore({
    collection: db.collection<StoredProfile>("truex_models"),
    ttlMs: Number.isSafeInteger(ttl) && ttl >= 0 ? ttl : 30000,
    secretTtlMs: envMs("SECRET_CACHE_TTL_MS", 300000),
    maxEntries: envMs("PROFILE_CACHE_MAX_ENTRIES", 256),
    maxProfileBytes: envMs("PROFILE_CACHE_MAX_BYTES", 2 * 1024 * 1024),
    maxSecretBytes: envMs("SECRET_CACHE_MAX_BYTES", 256 * 1024),
    maxPending: envPositive("PROFILE_CACHE_MAX_PENDING", 32),
    maxWaiters: envPositive("PROFILE_CACHE_MAX_WAITERS", 256),
    lookupTimeoutMs: envPositive("PROFILE_LOOKUP_TIMEOUT_MS", 3000),
    log,
  });
  const server = createGateway({
    secret,
    findProfile: (id) => profiles.find(id),
    // One JSON access line per request on stdout (CloudWatch via awslogs/FireLens).
    log,
    upstreamFirstByteTimeoutMs: envMs("UPSTREAM_FIRST_BYTE_TIMEOUT_MS", 60_000),
    upstreamIdleTimeoutMs: envMs("UPSTREAM_IDLE_TIMEOUT_MS", 120_000),
    providerCacheControls: ["on", "1", "true"].includes(
      process.env.CACHE_PROVIDER_CONTROLS?.trim().toLowerCase() ?? "",
    ),
    ready: async () => (await db.command({ ping: 1 })).ok === 1,
  });
  const port = Number(process.env.PORT || 4200);
  const host = process.env.HOST || "127.0.0.1";
  server.listen(port, host, () =>
    console.log(`model-gateway listening on ${host}:${port}`),
  );
  // On SIGTERM: fail /ready, stop accepting connections, let in-flight model
  // streams finish for up to DRAIN_GRACE_MS, then close what's left.
  const grace = Number(process.env.DRAIN_GRACE_MS ?? 30000);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await drain(server, Number.isFinite(grace) && grace >= 0 ? grace : 30000);
    await client.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

function envMs(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function envPositive(name: string, fallback: number) {
  const value = envMs(name, fallback);
  return value > 0 ? value : fallback;
}
