export interface PreparedSession<T> {
  key: string;
  promise: Promise<T>;
}

// Requests from Send share one conversation creation. Retain failed
// requests too: a timed-out POST may already have created the conversation.
// Reset explicitly when the user chooses another draft or configuration.
export class SessionPreparation<T> {
  private current: PreparedSession<T> | null = null;

  prepare(key: string, create: () => Promise<T>): PreparedSession<T> {
    if (this.current?.key === key) return this.current;
    const attempt = { key, promise: Promise.resolve().then(create) };
    this.current = attempt;
    return attempt;
  }

  isCurrent(attempt: PreparedSession<T>): boolean {
    return this.current === attempt;
  }

  reset(): void {
    // Do not abort or retry the POST; the server may already be provisioning.
    // A late result remains available in Recents, but cannot attach to this UI.
    this.current = null;
  }
}
