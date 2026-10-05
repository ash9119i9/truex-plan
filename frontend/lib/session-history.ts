// Share reads, not UI ownership. Each caller still checks its navigation generation.
// This controller belongs to one mounted page and never survives account navigation.
export class SessionHistory<T> {
  private flights = new Map<string, Promise<T>>();

  private readonly read: (id: string, persisted: boolean) => Promise<T>;

  constructor(read: (id: string, persisted: boolean) => Promise<T>) {
    this.read = read;
  }

  loadForOpen(id: string): { persisted: Promise<T>; recovery: Promise<T> } {
    const persisted = this.load(id, true);
    const recovery = this.load(id);
    // Opening installs saved history first. Keep an early recovery rejection
    // handled while that read is pending, without changing the returned promise.
    void recovery.catch(() => {});
    return { persisted, recovery };
  }

  load(id: string, persisted = false): Promise<T> {
    const key = JSON.stringify([id, persisted]);
    const previous = this.flights.get(key);
    if (previous) return previous;
    const promise = Promise.resolve().then(() => this.read(id, persisted));
    this.flights.set(key, promise);
    const clean = () => {
      if (this.flights.get(key) === promise) this.flights.delete(key);
    };
    void promise.then(clean, clean);
    return promise;
  }
}
