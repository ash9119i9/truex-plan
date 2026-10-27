// One value loaded on demand and reused for `ttlMs`. Concurrent readers share
// a single load, and a failed load is not kept, so the next reader retries.
// For small catalog data the product team changes rarely; a change made by
// another process (the operator CLI) is seen within `ttlMs`.
export class TtlCache<T> {
  private value?: { data: T; expires: number };
  private loading?: Promise<T>;
  // Bumped by clear(), so a load started before it cannot refill the cache.
  private generation = 0;

  constructor(
    private readonly load: () => Promise<T>,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(): Promise<T> {
    if (this.value && this.value.expires > this.now())
      return Promise.resolve(this.value.data);
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
