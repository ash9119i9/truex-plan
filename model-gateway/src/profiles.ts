import { ObjectId } from "mongodb";
import { performance } from "node:perf_hooks";
import type { GatewayProfile } from "./adapter";

// Profiles as stored in truex_models. `apiKeySecretArn` points at an AWS
// Secrets Manager secret holding the provider key, so the key need not be
// stored in Mongo in plaintext.
export type StoredProfile = GatewayProfile & { apiKeySecretArn?: string };

export interface ProfileCollection {
  findOne(
    filter: any,
    options?: { signal?: AbortSignal },
  ): Promise<StoredProfile | null>;
}

export interface SecretSource {
  /** Returns the secret's SecretString. */
  get(arn: string, signal?: AbortSignal): Promise<string>;
}

export interface ProfileStoreOptions {
  collection: ProfileCollection;
  /** How long a found profile is reused before Mongo is asked again. */
  ttlMs?: number;
  /** How long a missing profile is remembered (keeps unknown ids cheap). */
  negativeTtlMs?: number;
  /** How long a resolved secret is reused. */
  secretTtlMs?: number;
  /** Limits apply independently to profile and secret caches. */
  maxEntries?: number;
  maxProfileBytes?: number;
  maxSecretBytes?: number;
  /** Maximum outstanding loads per profile/secret source, including ignored aborts. */
  maxPending?: number;
  /** Maximum find callers awaiting a profile, including singleflight joiners. */
  maxWaiters?: number;
  lookupTimeoutMs?: number;
  secrets?: SecretSource;
  now?: () => number;
  log?: (line: string) => void;
}

export interface ProfileStore {
  find(id: string): Promise<GatewayProfile | null>;
  clear(): void;
  stats(): {
    profiles: { entries: number; bytes: number };
    secrets: { entries: number; bytes: number };
    pending: number;
    waiters: number;
  };
}

// Same id handling as platform/src/documents.ts idCandidates.
const idFilter = (id: string) => ({
  _id: { $in: ObjectId.isValid(id) ? [id, new ObjectId(id)] : [id] },
});

export function createProfileStore(options: ProfileStoreOptions): ProfileStore {
  const ttl = bound(options.ttlMs, 30_000, true);
  const negativeTtl = bound(options.negativeTtlMs, 5_000, true);
  const secretTtl = bound(options.secretTtlMs, 5 * 60_000, true);
  const maxEntries = bound(options.maxEntries, 256, true);
  const maxPending = bound(options.maxPending, 32);
  const maxWaiters = bound(options.maxWaiters, 256);
  const timeoutMs = bound(options.lookupTimeoutMs, 3_000);
  // Process-local TTLs use monotonic time, so a wall-clock adjustment cannot
  // prolong the validity of a cached credential/profile.
  const now = options.now ?? (() => performance.now());
  const log = options.log ?? (() => {});
  let secrets = options.secrets ? Promise.resolve(options.secrets) : undefined;
  const cache = new LocalCache<GatewayProfile | null>(
    maxEntries,
    bound(options.maxProfileBytes, 2 * 1024 * 1024, true),
    now,
    copyProfile,
  );
  const secretCache = new LocalCache<string>(
    maxEntries,
    bound(options.maxSecretBytes, 256 * 1024, true),
    now,
  );
  const pending = new Map<string, Promise<GatewayProfile | null>>();
  const pendingSecrets = new Map<
    string,
    Promise<{ key: string | undefined; expires: number }>
  >();
  const active = new Set<AbortController>();
  const activeSecrets = new Set<AbortController>();
  // Both secret and profile fills are fenced, and waiting callers fail closed.
  let generation = 0;
  let waiters = 0;

  function run<T>(
    load: (signal: AbortSignal) => Promise<T>,
    reservations = active,
  ): Promise<T> {
    if (reservations.size >= maxPending)
      return Promise.reject(new Error("Profile lookup capacity exceeded"));
    const controller = new AbortController();
    reservations.add(controller);
    const timer = setTimeout(
      () => controller.abort(new Error("Profile lookup timed out")),
      timeoutMs,
    );
    let rejectAbort!: (error: unknown) => void;
    const interrupted = new Promise<never>((_, reject) => {
      rejectAbort = reject;
    });
    const aborted = () => rejectAbort(controller.signal.reason);
    controller.signal.addEventListener("abort", aborted, { once: true });
    // Keep the capacity reservation until the underlying call settles, even
    // when a dependency ignores abort and the caller has already timed out.
    const operation = Promise.resolve()
      .then(() => {
        controller.signal.throwIfAborted();
        return load(controller.signal);
      })
      .finally(() => reservations.delete(controller));
    return Promise.race([operation, interrupted]).finally(() => {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", aborted);
    });
  }

  async function secretKey(
    arn: string,
  ): Promise<{ key: string | undefined; expires: number }> {
    const hit = secretCache.get(arn);
    if (hit) return { key: hit.value, expires: hit.expires };
    const existing = pendingSecrets.get(arn);
    if (existing) return existing;
    const started = generation;
    const lookup = run(async (signal) => {
      secrets ??= awsSecrets().catch((error) => {
        secrets = undefined;
        throw error;
      });
      const source = await secrets;
      signal.throwIfAborted();
      const key = parseSecret(await source.get(arn, signal));
      signal.throwIfAborted();
      if (started !== generation) throw new Error("Profile lookup invalidated");
      const expires = now() + secretTtl;
      if (key) secretCache.set(arn, key, expires);
      return { key, expires };
    }, activeSecrets).finally(() => {
      if (pendingSecrets.get(arn) === lookup) pendingSecrets.delete(arn);
    });
    pendingSecrets.set(arn, lookup);
    return lookup;
  }

  async function load(id: string, signal: AbortSignal) {
    const stored = await options.collection.findOne(idFilter(id), { signal });
    signal.throwIfAborted();
    const loadedAt = now();
    if (!stored) return { value: null, expires: loadedAt + negativeTtl };
    const { apiKeySecretArn, ...profile } = stored;
    if (
      profile.enabled === false ||
      !apiKeySecretArn ||
      profile.apiKey ||
      profile.apikey
    )
      return {
        value: profile,
        expires:
          loadedAt +
          (profile.enabled === false || profile.apiKey || profile.apikey
            ? ttl
            : negativeTtl),
      };
    try {
      const { key: apiKey, expires } = await secretKey(apiKeySecretArn);
      if (apiKey)
        return {
          value: { ...profile, apiKey },
          expires: Math.min(loadedAt + ttl, expires),
        };
      log(`profile ${id}: secret has no usable key`);
    } catch (error) {
      log(`profile ${id}: secret lookup failed (${(error as Error).name})`);
      // Dependency failure is transient, not evidence that a model is absent.
      // Do not cache a keyless profile because Secrets Manager timed out.
      throw new Error("Model credential source unavailable");
    }
    // No key: the server answers model_not_found. Don't keep this for the
    // full TTL, so a fixed secret is picked up quickly.
    return { value: profile, expires: loadedAt + negativeTtl };
  }

  // One Mongo lookup per id at a time; the result replaces the cache entry.
  function refresh(id: string): Promise<GatewayProfile | null> {
    const inFlight = pending.get(id);
    if (inFlight) return inFlight;
    const started = generation;
    const lookup: Promise<GatewayProfile | null> = run(async (signal) => {
      const { value, expires } = await load(id, signal);
      signal.throwIfAborted();
      if (started !== generation) throw new Error("Profile lookup invalidated");
      cache.set(id, value, expires);
      return value;
    }).finally(() => {
      if (pending.get(id) === lookup) pending.delete(id);
    });
    pending.set(id, lookup);
    return lookup;
  }

  return {
    async find(id) {
      if (typeof id !== "string" || !id || id.length > 256)
        throw new Error("Invalid model profile id");
      if (waiters >= maxWaiters)
        throw new Error("Profile lookup waiter capacity exceeded");
      waiters++;
      try {
        const hit = cache.get(id);
        // Expiry blocks for authoritative refresh. Disabled profiles and revoked
        // keys cannot remain usable because a Mongo refresh is slow or fails.
        return copyProfile(hit ? hit.value : await refresh(id));
      } finally {
        waiters--;
      }
    },
    clear() {
      generation++;
      for (const controller of [...active, ...activeSecrets])
        controller.abort(new Error("Profile lookup invalidated"));
      cache.clear();
      pending.clear();
      pendingSecrets.clear();
      secretCache.clear();
    },
    stats() {
      return {
        profiles: cache.stats(),
        secrets: secretCache.stats(),
        pending: active.size + activeSecrets.size,
        waiters,
      };
    },
  };
}

function bound(value: number | undefined, fallback: number, zero = false) {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < (zero ? 0 : 1))
    throw new RangeError("Invalid profile cache limit");
  return n;
}

function copyProfile(profile: GatewayProfile | null): GatewayProfile | null {
  return profile ? { ...structuredClone(profile), _id: profile._id } : null;
}

// Keys and values share the byte budget. Expired/least-used entries leave first.
class LocalCache<T> {
  private entries = new Map<
    string,
    { value: T; expires: number; bytes: number }
  >();
  private bytes = 0;
  constructor(
    private readonly limit: number,
    private readonly byteLimit: number,
    private readonly now: () => number,
    private readonly clone: (value: T) => T = structuredClone,
  ) {}
  get(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expires <= this.now()) {
      this.remove(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }
  set(key: string, value: T, expires: number) {
    this.remove(key);
    for (const [id, entry] of this.entries)
      if (entry.expires <= this.now()) this.remove(id);
    const bytes =
      Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(value));
    if (!this.limit || bytes > this.byteLimit || expires <= this.now()) return;
    while (
      this.entries.size >= this.limit ||
      this.bytes + bytes > this.byteLimit
    )
      this.remove(this.entries.keys().next().value!);
    this.entries.set(key, { value: this.clone(value), expires, bytes });
    this.bytes += bytes;
  }
  remove(key: string) {
    const entry = this.entries.get(key);
    if (entry) this.bytes -= entry.bytes;
    this.entries.delete(key);
  }
  clear() {
    this.entries.clear();
    this.bytes = 0;
  }
  stats() {
    return { entries: this.entries.size, bytes: this.bytes };
  }
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
    async get(arn, signal) {
      const result = await client.send(
        new GetSecretValueCommand({ SecretId: arn }),
        { abortSignal: signal },
      );
      if (typeof result.SecretString !== "string")
        throw new Error("Secret has no SecretString");
      return result.SecretString;
    },
  };
}
