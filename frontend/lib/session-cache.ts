export interface SessionCacheOptions<T> {
  maxEntries?: number;
  maxBytes?: number;
  idleTtlMs?: number;
  now?: () => number;
  estimateBytes?: (value: T) => number;
}

interface CachedSession<T> {
  value: T;
  bytes: number;
  accessedAt: number;
}

// This is a page-owned display cache, not an authorization or live-state source.
// Values must be treated as immutable; callers own revalidation and invalidation.
export class SessionCache<T> {
  private readonly entries = new Map<string, CachedSession<T>>();
  private bytes = 0;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly idleTtlMs: number;
  private readonly now: () => number;
  private readonly estimateBytes: (value: T) => number;

  constructor(options: SessionCacheOptions<T> = {}) {
    this.maxEntries = options.maxEntries ?? 16;
    this.maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
    this.idleTtlMs = options.idleTtlMs ?? 5 * 60_000;
    this.now = options.now ?? (() => performance.now());
    // Serialized UTF-16 length is a cheap budget estimate, not a heap measurement.
    this.estimateBytes =
      options.estimateBytes ?? ((value) => JSON.stringify(value).length * 2);
    if (
      !Number.isSafeInteger(this.maxEntries) ||
      this.maxEntries < 0 ||
      !Number.isSafeInteger(this.maxBytes) ||
      this.maxBytes < 0 ||
      !Number.isFinite(this.idleTtlMs) ||
      this.idleTtlMs < 0
    )
      throw new RangeError(
        "Session cache limits must be nonnegative finite values.",
      );
  }

  get(id: string): T | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    const now = this.now();
    if (now - entry.accessedAt >= this.idleTtlMs) {
      this.delete(id);
      return undefined;
    }
    entry.accessedAt = now;
    this.entries.delete(id);
    this.entries.set(id, entry);
    return entry.value;
  }

  set(id: string, value: T): void {
    this.delete(id);
    if (this.maxEntries === 0 || this.maxBytes === 0 || this.idleTtlMs === 0)
      return;
    let bytes: number;
    try {
      const estimate = this.estimateBytes(value);
      if (!Number.isFinite(estimate) || estimate < 0) return;
      bytes = Math.ceil(estimate);
    } catch {
      // Unserializable display data remains usable by the page without caching.
      return;
    }
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.maxBytes)
      return;
    const now = this.now();
    for (const [key, entry] of this.entries)
      if (now - entry.accessedAt >= this.idleTtlMs) this.delete(key);
    this.entries.set(id, { value, bytes, accessedAt: now });
    this.bytes += bytes;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes)
      this.delete(this.entries.keys().next().value!);
  }

  delete(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    this.bytes -= entry.bytes;
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }
}
