// One value loaded on demand and reused for `ttlMs`. Concurrent readers share
// a single load, and a failed load is not kept, so the next reader retries.
// For small catalog data the product team changes rarely; a change made by
// another process (the operator CLI) is seen within `ttlMs + staleMs`.
//
// With `staleMs`, a value up to `staleMs` past its expiry is still returned
// while a reload runs in the background, so a reader never waits on the
// database for a value it had. The first reader after expiry gets the old
// value and starts the reload; a value older than `ttlMs + staleMs` is
// loaded first. A failed background reload keeps the old value until then.

// How long the catalog caches (models, built-ins, connectors) keep serving a
// value past its TTL while they reload it. With their 60 s TTLs, a change is
// seen within 2 minutes.
export const CATALOG_STALE_MS = 60_000;

export class TtlCache<T> {
  private value?: { data: T; expires: number };
  private loading?: Promise<T>;
  // Bumped by clear(), so a load started before it cannot refill the cache.
  private generation = 0;

  constructor(
    private readonly load: () => Promise<T>,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
    private readonly staleMs = 0,
  ) {}

  get(): Promise<T> {
    const now = this.now();
    const value = this.value;
    if (value && value.expires > now) return Promise.resolve(value.data);
    if (value && value.expires + this.staleMs > now) {
      // A failure here is dropped; the next reader tries again, and once the
      // value is too old a reader waits for the load and sees its error.
      this.reload().catch(() => undefined);
      return Promise.resolve(value.data);
    }
    return this.reload();
  }

  private reload(): Promise<T> {
    if (this.loading) return this.loading;
    const started = this.generation;
    const loading = this.load()
      .then((data) => {
        if (started === this.generation)
          this.value = { data, expires: this.now() + this.ttlMs };
        return data;
      })
      .finally(() => {
        if (this.loading === loading) this.loading = undefined;
      });
    this.loading = loading;
    return loading;
  }

  clear(): void {
    this.generation++;
    this.value = undefined;
    this.loading = undefined;
  }
}
