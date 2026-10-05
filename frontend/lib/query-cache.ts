// Browser metadata only. Each caller receives its own JSON value; no object
// reference or private content is persisted across page loads.
export class QueryCacheError extends Error {
  readonly code: "CACHE_INVALIDATED" | "CACHE_BUSY";
  constructor(code: "CACHE_INVALIDATED" | "CACHE_BUSY") {
    super(
      code === "CACHE_BUSY"
        ? "Too many metadata requests. Try again."
        : "The account or settings changed. Refresh this view.",
    );
    this.code = code;
  }
}

type Entry = { json: string; bytes: number; expires: number };
type Pending = { controller: AbortController; promise: Promise<string> };
export class QueryCache {
  private entries = new Map<string, Entry>();
  private pending = new Map<string, Pending>();
  private generation = 0;
  private bytes = 0;
  private readers = 0;
  private readonly limits;
  private readonly now;
  constructor(
    limits = {
      entries: 64,
      bytes: 512 * 1024,
      valueBytes: 64 * 1024,
      pending: 16,
    },
    now = Date.now,
  ) {
    if (
      Object.values(limits).some(
        (value) => !Number.isSafeInteger(value) || value <= 0,
      )
    )
      throw new RangeError("Cache limits must be positive integers");
    this.limits = limits;
    this.now = now;
  }

  clear() {
    this.generation++;
    this.entries.clear();
    this.bytes = 0;
    // Keep pending slots occupied until cancellation settles, so repeated
    // identity changes cannot create unlimited outstanding origin requests.
    for (const { controller } of this.pending.values()) controller.abort();
  }

  stats() {
    return {
      entries: this.entries.size,
      bytes: this.bytes,
      pending: this.pending.size,
      readers: this.readers,
    };
  }

  async get(
    key: string,
    ttl: number,
    load: (signal: AbortSignal) => Promise<unknown>,
    admit: (value: unknown) => boolean = () => true,
  ): Promise<any> {
    if (key.length > 1024) throw new QueryCacheError("CACHE_BUSY");
    // Single-flight also needs a subscriber bound: a hot key must not retain
    // unlimited waiting promises while one origin request is slow.
    if (this.readers >= this.limits.pending * 16)
      throw new QueryCacheError("CACHE_BUSY");
    this.readers++;
    try {
      return await this.read(key, ttl, load, admit);
    } finally {
      this.readers--;
    }
  }

  private async read(
    key: string,
    ttl: number,
    load: (signal: AbortSignal) => Promise<unknown>,
    admit: (value: unknown) => boolean,
  ): Promise<any> {
    const generation = this.generation;
    const hit = this.entries.get(key);
    if (hit) {
      this.entries.delete(key);
      if (hit.expires > this.now()) {
        this.entries.set(key, hit);
        await Promise.resolve();
        if (generation !== this.generation)
          throw new QueryCacheError("CACHE_INVALIDATED");
        return JSON.parse(hit.json);
      }
      this.bytes -= hit.bytes;
    }
    const pendingKey = JSON.stringify([generation, key]);
    let pending = this.pending.get(pendingKey);
    if (!pending) {
      if (this.pending.size >= this.limits.pending)
        throw new QueryCacheError("CACHE_BUSY");
      const controller = new AbortController();
      const promise = Promise.resolve()
        .then(() => load(controller.signal))
        .then((value) => {
          if (generation !== this.generation)
            throw new QueryCacheError("CACHE_INVALIDATED");
          const json = JSON.stringify(value);
          if (json === undefined)
            throw new TypeError("Metadata response must be JSON");
          const valueBytes = new TextEncoder().encode(json).byteLength;
          const bytes = valueBytes + new TextEncoder().encode(key).byteLength;
          if (
            ttl > 0 &&
            valueBytes <= this.limits.valueBytes &&
            bytes <= this.limits.bytes &&
            admit(value)
          ) {
            // Expired keys are removed on fill, even if never read again.
            for (const [oldKey, old] of this.entries)
              if (old.expires <= this.now()) this.remove(oldKey);
            while (
              this.entries.size >= this.limits.entries ||
              this.bytes + bytes > this.limits.bytes
            )
              this.remove(this.entries.keys().next().value!);
            this.entries.set(key, { json, bytes, expires: this.now() + ttl });
            this.bytes += bytes;
          }
          return json;
        })
        .catch((error) => {
          if (generation !== this.generation)
            throw new QueryCacheError("CACHE_INVALIDATED");
          throw error;
        })
        .finally(() => {
          this.pending.delete(pendingKey);
        });
      pending = { controller, promise };
      this.pending.set(pendingKey, pending);
    }
    const json = await pending.promise;
    if (generation !== this.generation)
      throw new QueryCacheError("CACHE_INVALIDATED");
    return JSON.parse(json);
  }
  private remove(key: string) {
    const entry = this.entries.get(key);
    if (entry) this.bytes -= entry.bytes;
    this.entries.delete(key);
  }
}

// This allow-list intentionally excludes history, sessions, documents,
// approvals, turn context, tool outputs and admin/identity endpoints.
export function metadataTtl(path: string): number {
  if (path.length > 512) return 0;
  if (
    ["/api/models", "/api/features", "/api/assistant-capabilities"].includes(
      path,
    )
  )
    return 30_000;
  if (
    path === "/api/agents" ||
    path === "/api/mcp" ||
    /^\/api\/agents\/[-\w%]+\/mcp$/.test(path)
  )
    return 5_000;
  return 0;
}

export function safeMetadata(value: unknown, depth = 0): boolean {
  if (depth > 20) return false;
  if (!value || typeof value !== "object") return true;
  return Object.entries(value).every(
    ([key, item]) =>
      !/^(apikey|apikeyenc|secret|token|password|headers|config|baseinstructions)$/i.test(
        key,
      ) && safeMetadata(item, depth + 1),
  );
}
