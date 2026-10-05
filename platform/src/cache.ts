import { createHash } from "node:crypto";
import { createClient, createCluster } from "@redis/client";
import {
  CacheCapacityError,
  JsonReadCache,
  type CacheEntry,
} from "../../shared/cache";
import { log } from "../../shared/logging";
import { measure } from "./http";
import { ApiError } from "./errors";

const on = (value: string | undefined) => value?.trim().toLowerCase() === "on";
const MAX_VALUE_BYTES = 256 * 1024;
export interface SharedReadCache {
  start(): Promise<void>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
  flush(): Promise<void>;
  close(): void;
}

// Single-key disposable operations. No leases, budgets or credentials here.
export class ValkeyReadCache implements SharedReadCache {
  private readonly client;
  private readonly subscriber;
  private connecting?: Promise<void>;
  private retry?: ReturnType<typeof setTimeout>;
  private closed = false;
  private openUntil = 0;
  private active = 0;
  // Node-redis retains Pub/Sub listener sets across destroy/connect. Reusing
  // one callback avoids accumulating listeners after forced deadline recovery.
  private readonly onInvalidationMessage = (message: string) => {
    if (message === "clear") this.invalidate();
  };
  readonly counters = { hits: 0, misses: 0, errors: 0, bypasses: 0 };
  constructor(
    url: string,
    private readonly channel: string,
    private readonly invalidate: () => void,
    cluster = false,
    private readonly timeoutMs = 50,
  ) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("Invalid CACHE_URL");
    }
    if (!["redis:", "rediss:"].includes(parsed.protocol))
      throw new Error("CACHE_URL must use redis or rediss");
    if (process.env.NODE_ENV === "production" && parsed.protocol !== "rediss:")
      throw new Error("Production cache requires TLS (rediss://)");
    const defaults = {
      disableOfflineQueue: true,
      commandsQueueMaxLength: 64,
      socket: {
        connectTimeout: 1000,
        reconnectStrategy: (attempt: number) =>
          Math.min(100 * 2 ** Math.min(attempt, 5), 3000),
      },
    };
    this.client = cluster
      ? createCluster({ rootNodes: [{ url }], defaults })
      : createClient({ url, ...defaults });
    this.subscriber = this.client.duplicate();
    for (const client of [this.client, this.subscriber]) {
      client.on("error", () => {
        this.openUntil = Date.now() + 1000;
        this.invalidate();
      });
      client.on("ready", () => this.invalidate());
      client.on("reconnecting", () => this.invalidate());
    }
  }
  start(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.connecting) return this.connecting;
    if (this.retry) {
      clearTimeout(this.retry);
      this.retry = undefined;
    }
    let operation: Promise<void>;
    operation = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const connecting = (async () => {
          await Promise.all([this.client.connect(), this.subscriber.connect()]);
          await this.subscriber.subscribe(
            this.channel,
            this.onInvalidationMessage,
          );
        })();
        await Promise.race([
          connecting,
          new Promise<never>((_r, reject) => {
            timer = setTimeout(
              () => reject(new Error("Cache connection deadline exceeded")),
              2000,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    })().catch(() => {
      if (this.connecting !== operation || this.closed) return;
      for (const client of [this.client, this.subscriber])
        if (client.isOpen) client.destroy();
      this.connecting = undefined;
      this.counters.errors++;
      // Never print the URL or error message: either can contain credentials.
      log("warn", "shared read cache connection unavailable", {
        op: "cache.connect",
      });
      this.retry = setTimeout(() => {
        this.retry = undefined;
        void this.start();
      }, 1000);
      this.retry.unref();
    });
    this.connecting = operation;
    return this.connecting;
  }
  private async command<T>(run: () => Promise<T>, fallback: T): Promise<T> {
    if (
      this.closed ||
      !this.client.isReady ||
      Date.now() < this.openUntil ||
      this.active >= 32
    ) {
      this.counters.bypasses++;
      return fallback;
    }
    this.active++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          // Native command timeouts stop guarding work once it is written.
          // Closing the connection also releases all outstanding reply slots.
          for (const client of [this.client, this.subscriber])
            if (client.isOpen) client.destroy();
          this.connecting = undefined;
          this.invalidate();
          this.openUntil = Date.now() + 1000;
          if (!this.closed) void this.start();
          reject(new Error("Cache command deadline exceeded"));
        }, this.timeoutMs);
      });
      return await Promise.race([run(), deadline]);
    } catch {
      this.counters.errors++;
      this.openUntil = Date.now() + 1000;
      log("warn", "shared read cache command failed; using source", {
        op: "cache.command",
      });
      return fallback;
    } finally {
      if (timer) clearTimeout(timer);
      this.active--;
    }
  }
  async get(key: string) {
    const value = await this.command(
      () =>
        this.client.withCommandOptions({ timeout: this.timeoutMs }).get(key),
      null,
    );
    if (value === null) this.counters.misses++;
    else this.counters.hits++;
    return value;
  }
  async set(key: string, value: string, ttlMs: number) {
    if (ttlMs <= 0 || Buffer.byteLength(value) > MAX_VALUE_BYTES) return;
    await this.command(async () => {
      await this.client
        .withCommandOptions({ timeout: this.timeoutMs })
        .set(key, value, { PX: Math.max(1, Math.floor(ttlMs)) });
    }, undefined);
  }
  async flush() {
    await this.command(async () => {
      await this.client
        .withCommandOptions({ timeout: this.timeoutMs })
        .publish(this.channel, "clear");
    }, undefined);
  }
  close() {
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    for (const client of [this.client, this.subscriber])
      if (client.isOpen) client.destroy();
  }
}

export interface PlatformCacheOptions {
  enabled?: boolean;
  namespace?: string;
  backend?: SharedReadCache;
  now?: () => number;
  jitter?: () => number;
}
export class PlatformReadCache {
  readonly enabled: boolean;
  readonly local: JsonReadCache<unknown>;
  readonly backend?: SharedReadCache;
  private readonly namespace: string;
  private readonly now: () => number;
  private readonly jitter: () => number;
  private closed = false;
  private generation = 0;
  private readonly metricsLog: boolean;
  private metricsTimer?: ReturnType<typeof setInterval>;
  constructor(
    options: PlatformCacheOptions = {},
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.enabled = options.enabled ?? on(env.CACHE_L1);
    this.metricsLog = env.CACHE_METRICS_LOG?.trim().toLowerCase() !== "off";
    this.namespace = `truex:display:v1:${createHash("sha256")
      .update(options.namespace ?? env.CACHE_NAMESPACE ?? "development")
      .digest("hex")
      .slice(0, 24)}`;
    this.now = options.now ?? Date.now;
    this.local = new JsonReadCache({ now: this.now });
    this.jitter = options.jitter ?? Math.random;
    if (on(env.CACHE_L2) && (!this.enabled || !env.CACHE_URL))
      throw new Error("CACHE_L2 requires CACHE_L1=on and CACHE_URL");
    if (on(env.CACHE_L2) && !env.CACHE_NAMESPACE)
      throw new Error(
        "CACHE_L2 requires a deployment-specific CACHE_NAMESPACE",
      );
    this.backend =
      options.backend ??
      (on(env.CACHE_L2)
        ? new ValkeyReadCache(
            env.CACHE_URL!,
            `${this.namespace}:invalidate`,
            () => this.clearLocal(),
            on(env.CACHE_CLUSTER),
          )
        : undefined);
  }
  start() {
    if (this.enabled && this.metricsLog && !this.closed && !this.metricsTimer) {
      // Bounded labels and numeric fields only: never keys, tenant identifiers
      // or payloads. Operators can aggregate these without a public admin API.
      this.metricsTimer = setInterval(() => {
        log("info", "display cache counters", {
          op: "cache.metrics",
          local: this.local.snapshot(),
          shared:
            this.backend instanceof ValkeyReadCache
              ? { ...this.backend.counters }
              : undefined,
        });
      }, 30_000);
      this.metricsTimer.unref();
    }
    return this.backend?.start() ?? Promise.resolve();
  }
  key(scope: unknown, resource: string) {
    return `${this.namespace}:${resource}:${createHash("sha256").update(JSON.stringify(scope)).digest("hex")}`;
  }
  async read<T>(
    key: string,
    ttlMs: number,
    load: () => Promise<T>,
    valid: (value: unknown) => value is T,
    shared = false,
  ): Promise<T> {
    if (!this.enabled || this.closed) return measure("mongo", load);
    const generation = this.generation;
    return measure("cache", () =>
      this.local.getOrLoad(key, async (): Promise<CacheEntry<unknown>> => {
        const now = this.now();
        if (shared && this.backend) {
          const raw = await this.backend.get(key);
          if (raw && Buffer.byteLength(raw) <= MAX_VALUE_BYTES) {
            try {
              const entry = JSON.parse(raw);
              if (
                entry.v === 1 &&
                Number.isFinite(entry.expiresAt) &&
                entry.expiresAt > now &&
                entry.expiresAt <= now + ttlMs &&
                valid(entry.value)
              )
                return { value: entry.value, expiresAt: entry.expiresAt };
            } catch {
              /* Corrupt cache is a miss; source errors still propagate. */
            }
          }
        }
        const started = this.now();
        const value = await measure("mongo", load);
        const expiresAt =
          started +
          ttlMs * (0.9 + Math.max(0, Math.min(1, this.jitter())) * 0.1);
        if (!valid(value)) return { value, expiresAt: started };
        if (
          shared &&
          this.backend &&
          generation === this.generation &&
          !this.closed
        )
          await this.backend.set(
            key,
            JSON.stringify({ v: 1, expiresAt, value }),
            expiresAt - this.now(),
          );
        return { value, expiresAt };
      }),
    ).catch((error) => {
      if (error instanceof CacheCapacityError)
        throw new ApiError(
          503,
          "Catalog loading is busy. Try again shortly.",
          "CACHE_SOURCE_BUSY",
        );
      throw error;
    }) as Promise<T>;
  }
  invalidate() {
    this.clearLocal();
    // Publication only reduces display staleness; authorization never uses it.
    void this.backend?.flush().catch(() =>
      log("warn", "cache invalidation unavailable", {
        op: "cache.invalidate",
      }),
    );
  }
  clearLocal() {
    this.generation++;
    this.local.clear();
  }
  close() {
    this.closed = true;
    if (this.metricsTimer) clearInterval(this.metricsTimer);
    this.clearLocal();
    this.backend?.close();
  }
}

export function publicRows<T>(
  keys: readonly string[],
  required: readonly string[],
) {
  const allowed = new Set(keys);
  return (value: unknown): value is T[] =>
    Array.isArray(value) &&
    value.length <= 5000 &&
    value.every(
      (row) =>
        row &&
        typeof row === "object" &&
        !Array.isArray(row) &&
        Object.keys(row).every((key) => allowed.has(key)) &&
        required.every((key) => typeof row[key] === "string"),
    );
}
