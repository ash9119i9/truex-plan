// A reply's commands, the lead's and its helpers', against
// RuntimeLimits.maxCommands and maxFailedCommands. A command fails when it
// didn't complete (failed or declined) or exited non-zero. One already
// counted, by its key, counts once: Codex may send item/completed again.

export class CommandTally {
  commands = 0;
  failed = 0;
  private readonly seen = new Set<string>();

  // Counts one finished command; false for a key already counted. A command
  // with no key is always counted.
  add(
    key: string,
    item: { readonly status?: unknown; readonly exitCode?: unknown },
  ): boolean {
    if (key) {
      if (this.seen.has(key)) return false;
      this.seen.add(key);
    }
    this.commands++;
    if (
      item.status !== "completed" ||
      (typeof item.exitCode === "number" && item.exitCode !== 0)
    )
      this.failed++;
    return true;
  }

  over(limits: {
    readonly maxCommands: number;
    readonly maxFailedCommands: number;
  }): boolean {
    return (
      this.failed >= limits.maxFailedCommands ||
      this.commands >= limits.maxCommands
    );
  }
}
