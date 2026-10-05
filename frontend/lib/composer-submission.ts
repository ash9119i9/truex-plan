import type { ApprovalMode } from "../../shared/contracts";

export type DispatchState = "creating" | "sending" | "steering" | null;

// Every edit advances ownership, including replacing text with the same value.
// An asynchronous submission can only clear/restore the revision it owns.
export class ComposerDraft {
  private revision = 0;
  edit(): void {
    this.revision++;
  }
  capture(): number {
    return this.revision;
  }
  isCurrent(revision: number): boolean {
    return this.revision === revision;
  }
}

// A failed update can have changed storage without changing the runtime.
// Keep the intended mode until a successful confirmation; never infer success
// from an optimistic session object or silently fall back to its old mode.
export class ApprovalConfirmation {
  private pending = new Map<string, ApprovalMode>();
  require(sessionId: string, mode: ApprovalMode): void {
    this.pending.set(sessionId, mode);
  }
  wanted(sessionId: string): ApprovalMode | undefined {
    return this.pending.get(sessionId);
  }
  confirm(sessionId: string, mode: ApprovalMode): void {
    if (this.pending.get(sessionId) === mode) this.pending.delete(sessionId);
  }
}
