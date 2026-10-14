import { ObjectId } from "mongodb";
import type { GatewayProfile } from "./adapter";

// Profiles as stored in truex_models. `apiKeySecretArn` points at an AWS
// Secrets Manager secret holding the provider key, so the key need not be
// stored in Mongo in plaintext.
export type StoredProfile = GatewayProfile & { apiKeySecretArn?: string };

export interface ProfileCollection {
  findOne(filter: any): Promise<StoredProfile | null>;
}

export interface SecretSource {
  /** Returns the secret's SecretString. */
  get(arn: string): Promise<string>;
}

export interface ProfileStoreOptions {
  collection: ProfileCollection;
  /** How long a found profile is reused before Mongo is asked again. */
  ttlMs?: number;
  /**
   * After the TTL, a found profile is still served immediately (and refreshed
   * in the background) until it is this old, so requests don't wait on Mongo.
   * Beyond this, the request waits for a fresh lookup.
   */
  maxStaleMs?: number;
  /** How long a missing profile is remembered (keeps unknown ids cheap). */
  negativeTtlMs?: number;
  /** How long a resolved secret is reused. */
  secretTtlMs?: number;
  secrets?: SecretSource;
  now?: () => number;
  log?: (line: string) => void;
}

export interface ProfileStore {
  find(id: string): Promise<GatewayProfile | null>;
  clear(): void;
}

// Same id handling as platform/src/persistence/configuration-documents.ts idCandidates.
const idFilter = (id: string) => ({
  _id: { $in: ObjectId.isValid(id) ? [id, new ObjectId(id)] : [id] },
});

export function createProfileStore(options: ProfileStoreOptions): ProfileStore {
  const ttl = options.ttlMs ?? 30_000;
  const maxStale = options.maxStaleMs ?? 60 * 60_000;
  const negativeTtl = options.negativeTtlMs ?? 5_000;
  const secretTtl = options.secretTtlMs ?? 5 * 60_000;
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  let secrets = options.secrets;
  const cache = new Map<
    string,
    { value: GatewayProfile | null; expires: number; loadedAt: number }
  >();
  const pending = new Map<string, Promise<GatewayProfile | null>>();
  const secretCache = new Map<string, { value: string; expires: number }>();
  // Bumped by clear(), so a lookup started before it can't refill the cache.
  let generation = 0;

  async function secretKey(arn: string): Promise<string | undefined> {
    const hit = secretCache.get(arn);
    if (hit && hit.expires > now()) return hit.value;
    secrets ??= await awsSecrets();
    const key = parseSecret(await secrets.get(arn));
    if (key) secretCache.set(arn, { value: key, expires: now() + secretTtl });
    return key;
  }

  async function load(id: string): Promise<GatewayProfile | null> {
    const stored = await options.collection.findOne(idFilter(id));
    if (!stored) return null;
    const { apiKeySecretArn, ...profile } = stored;
    if (!apiKeySecretArn || profile.apiKey || profile.apikey) return profile;
    try {
      const apiKey = await secretKey(apiKeySecretArn);
      if (apiKey) return { ...profile, apiKey };
      log(`profile ${id}: secret has no usable key`);
    } catch (error) {
      log(`profile ${id}: secret lookup failed (${(error as Error).name})`);
    }
    // No key: the server answers model_not_found. Don't keep this for the
    // full TTL, so a fixed secret is picked up quickly.
    return profile;
  }

  // One Mongo lookup per id at a time; the result replaces the cache entry.
  function refresh(id: string): Promise<GatewayProfile | null> {
    const inFlight = pending.get(id);
    if (inFlight) return inFlight;
    const started = generation;
    const lookup: Promise<GatewayProfile | null> = load(id)
      .then((value) => {
        if (started === generation) {
          const usable = value && (value.apiKey || value.apikey);
          const at = now();
          cache.set(id, {
            value,
            expires: at + (usable ? ttl : negativeTtl),
            loadedAt: at,
          });
        }
        return value;
      })
      .finally(() => {
        if (pending.get(id) === lookup) pending.delete(id);
      });
    pending.set(id, lookup);
    return lookup;
  }

  return {
    async find(id) {
      const hit = cache.get(id);
      const at = now();
      if (hit && hit.expires > at) return hit.value;
      // Stale-while-revalidate: a usable profile is served at once while
      // Mongo is asked in the background. Disabling a profile therefore takes
      // effect on the second request after the TTL. Missing and keyless
      // profiles are never served stale, and neither is anything older than
      // maxStaleMs. If the refresh fails (Mongo down), the stale copy stays
      // in use until then.
      if (
        hit?.value &&
        (hit.value.apiKey || hit.value.apikey) &&
        at - hit.loadedAt < maxStale
      ) {
        refresh(id).catch((error) =>
          log(
            `profile ${id}: background refresh failed (${(error as Error).name})`,
          ),
        );
        return hit.value;
      }
      return refresh(id);
    },
    clear() {
      generation++;
      cache.clear();
      pending.clear();
      secretCache.clear();
    },
  };
}

// A secret may hold the raw key or JSON such as {"apiKey": "..."}.
export function parseSecret(value: string): string | undefined {
  const text = value.trim();
  if (!text.startsWith("{")) return text || undefined;
  try {
    const json = JSON.parse(text);
    for (const field of ["apiKey", "api_key", "key"])
      if (typeof json[field] === "string" && json[field]) return json[field];
  } catch {}
  return undefined;
}

// Loaded only when a profile uses apiKeySecretArn, so the gateway runs
// without AWS configuration. Region and credentials come from the default
// provider chain (AWS_REGION, task role, ...).
async function awsSecrets(): Promise<SecretSource> {
  const { SecretsManagerClient, GetSecretValueCommand } =
    await import("@aws-sdk/client-secrets-manager");
  const client = new SecretsManagerClient({});
  return {
    async get(arn) {
      const result = await client.send(
        new GetSecretValueCommand({ SecretId: arn }),
      );
      if (typeof result.SecretString !== "string")
        throw new Error("Secret has no SecretString");
      return result.SecretString;
    },
  };
}
