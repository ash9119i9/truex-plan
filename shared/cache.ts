import { performance } from "node:perf_hooks";

// Disposable JSON read caching only. Callers own authorization and freshness.
export class CacheCapacityError extends Error {
  constructor() {
    super("Too many cache source loads are already running");
    this.name = "CacheCapacityError";
  }
}

export interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}
export interface JsonCacheOptions {
  maxEntries?: number;
  maxBytes?: number;
  maxValueBytes?: number;
  maxPending?: number;
  maxWaiters?: number;
  now?: () => number;
  monotonicNow?: () => number;
}

export class JsonReadCache<T> {
  private values = new Map<
    string,
    { json: string; expiresAt: number; deadline: number; bytes: number }
  >();
  private pending = new Map<string, Promise<T>>();
  private running = 0;
  private waiters = 0;
  private bytes = 0;
  private readonly limits: Required<JsonCacheOptions>;
  readonly counters = {
    hits: 0,
    misses: 0,
    loads: 0,
    deduped: 0,
    evictions: 0,
    rejected: 0,
  };
  constructor(options: JsonCacheOptions = {}) {
    this.limits = {
      maxEntries: 256,
      maxBytes: 4 * 1024 * 1024,
      maxValueBytes: 256 * 1024,
      maxPending: 32,
      maxWaiters: 256,
      now: Date.now,
      monotonicNow: performance.now.bind(performance),
      ...options,
    };
    for (const [name, value] of Object.entries(this.limits))
      if (
        name !== "now" &&
        name !== "monotonicNow" &&
        (!Number.isSafeInteger(value) || Number(value) <= 0)
      )
        throw new Error(`Invalid cache limit: ${name}`);
  }
  get(key: string): T | undefined {
    const entry = this.values.get(key);
    if (!entry) return undefined;
    if (
      entry.expiresAt <= this.limits.now() ||
      entry.deadline <= this.limits.monotonicNow()
    ) {
      this.remove(key);
      return undefined;
    }
    this.values.delete(key);
    this.values.set(key, entry);
    this.counters.hits++;
    return JSON.parse(entry.json) as T;
  }
  set(key: string, entry: CacheEntry<T>): void {
    if (
      !Number.isFinite(entry.expiresAt) ||
      entry.expiresAt <= this.limits.now()
    )
      return;
    const json = JSON.stringify(entry.value);
    if (json === undefined) return;
    const bytes = Buffer.byteLength(key) + Buffer.byteLength(json);
    if (bytes > this.limits.maxValueBytes || bytes > this.limits.maxBytes) {
      this.counters.rejected++;
      return;
    }
    this.remove(key);
    this.values.set(key, {
      json,
      expiresAt: entry.expiresAt,
      bytes,
      // Wall expiry travels over L2; elapsed time bounds local reuse even if
      // an operator/NTP moves the wall clock backwards after admission.
      deadline:
        this.limits.monotonicNow() + entry.expiresAt - this.limits.now(),
    });
    this.bytes += bytes;
    while (
      this.values.size > this.limits.maxEntries ||
      this.bytes > this.limits.maxBytes
    ) {
      this.remove(this.values.keys().next().value!);
      this.counters.evictions++;
    }
  }
  async getOrLoad(
    key: string,
    loader: () => Promise<CacheEntry<T>>,
  ): Promise<T> {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    this.counters.misses++;
    if (this.waiters >= this.limits.maxWaiters) {
      this.counters.rejected++;
      throw new CacheCapacityError();
    }
    this.waiters++;
    try {
      const existing = this.pending.get(key);
      if (existing) {
        this.counters.deduped++;
        return structuredClone(await existing);
      }
      if (this.running >= this.limits.maxPending) {
        this.counters.rejected++;
        throw new CacheCapacityError();
      }
      this.running++;
      this.counters.loads++;
      // Scheduling the loader after registration also fences synchronous loaders.
      const operation = Promise.resolve()
        .then(loader)
        .then((entry) => {
          if (this.pending.get(key) === operation) this.set(key, entry);
          return entry.value;
        });
      this.pending.set(key, operation);
      try {
        return structuredClone(await operation);
      } finally {
        this.running--;
        if (this.pending.get(key) === operation) this.pending.delete(key);
      }
    } finally {
      this.waiters--;
    }
  }
  invalidate(key: string): void {
    this.remove(key);
    this.pending.delete(key);
  }
  clear(): void {
    this.values.clear();
    this.bytes = 0;
    this.pending.clear();
  }
  snapshot() {
    return {
      ...this.counters,
      entries: this.values.size,
      bytes: this.bytes,
      pending: this.running,
      waiters: this.waiters,
    };
  }
  private remove(key: string) {
    const entry = this.values.get(key);
    if (entry) {
      this.bytes -= entry.bytes;
      this.values.delete(key);
    }
  }
}

// No results are retained. Only concurrent work for an already authorized
// resource is shared; durable persistence/idempotency still belongs to Mongo.
export class SingleFlight {
  private pending = new Map<string, Promise<unknown>>();
  private waiters = 0;
  constructor(
    private readonly maxPending = 32,
    private readonly maxWaiters = 256,
  ) {
    if (!Number.isSafeInteger(maxPending) || maxPending <= 0)
      throw new Error("Invalid single-flight capacity");
    if (!Number.isSafeInteger(maxWaiters) || maxWaiters <= 0)
      throw new Error("Invalid single-flight waiter capacity");
  }
  async run<T>(key: string, load: () => Promise<T>): Promise<T> {
    if (this.waiters >= this.maxWaiters) throw new CacheCapacityError();
    this.waiters++;
    try {
      const existing = this.pending.get(key);
      if (existing) return await (existing as Promise<T>);
      if (this.pending.size >= this.maxPending) throw new CacheCapacityError();
      const operation = Promise.resolve().then(load);
      this.pending.set(key, operation);
      try {
        return await operation;
      } finally {
        if (this.pending.get(key) === operation) this.pending.delete(key);
      }
    } finally {
      this.waiters--;
    }
  }
  get size() {
    return this.pending.size;
  }
}
