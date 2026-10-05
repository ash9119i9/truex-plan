import type { BigIntStats } from "node:fs";

// Runtime caches retain derived data only. Callers must validate their source
// before a hit; this helper never establishes workspace or tenant authority.
export const runtimeCacheEnabled = () =>
  process.env.CACHE_RUNTIME_METADATA === "on";

export const sourceStamp = (stats: BigIntStats) =>
  `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;

export class RuntimeCache<T> {
  private readonly entries = new Map<
    string,
    { value: T; bytes: number; expires: number }
  >();
  private bytes = 0;
  constructor(
    private readonly maxEntries: number,
    private readonly maxBytes: number,
    private readonly ttlMs: number,
  ) {
    if (
      !Number.isSafeInteger(maxEntries) ||
      maxEntries < 1 ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      !Number.isFinite(ttlMs) ||
      ttlMs < 0
    )
      throw new Error("Invalid runtime cache bounds");
  }
  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expires <= Date.now()) {
      this.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }
  set(key: string, value: T, bytes: number) {
    this.delete(key);
    if (!Number.isSafeInteger(bytes) || bytes < 0) return;
    bytes += key.length * 2;
    if (!Number.isSafeInteger(bytes) || bytes > this.maxBytes) return;
    while (
      this.entries.size >= this.maxEntries ||
      this.bytes + bytes > this.maxBytes
    )
      this.delete(this.entries.keys().next().value!);
    this.entries.set(key, { value, bytes, expires: Date.now() + this.ttlMs });
    this.bytes += bytes;
  }
  delete(key: string) {
    const entry = this.entries.get(key);
    if (entry) this.bytes -= entry.bytes;
    this.entries.delete(key);
  }
  deletePrefix(prefix: string) {
    for (const key of this.entries.keys())
      if (key.startsWith(prefix)) this.delete(key);
  }
  clear() {
    this.entries.clear();
    this.bytes = 0;
  }
  get size() {
    return this.entries.size;
  }
  get retainedBytes() {
    return this.bytes;
  }
}
