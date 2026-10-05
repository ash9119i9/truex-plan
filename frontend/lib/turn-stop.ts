import type { TurnState } from "../../shared/contracts";

export type StopStatus = "pending" | "unconfirmed" | null;

// Keep request completions behind the same turn boundary as live events.
// A delayed failure must never restore a Stop button after turn completion.
export class TurnStop {
  status: StopStatus = null;
  private turnId: string | undefined;
  private attempt = 0;

  reset() {
    this.attempt++;
    this.turnId = undefined;
    this.status = null;
  }

  observe(state: TurnState, eventTurnId?: string): boolean {
    if (eventTurnId && this.turnId && eventTurnId !== this.turnId) return false;
    if (state.kind === "idle") {
      this.reset();
      return true;
    }
    const nextTurnId = "turnId" in state ? state.turnId : undefined;
    if (this.turnId && nextTurnId && this.turnId !== nextTurnId) this.reset();
    this.turnId = nextTurnId ?? this.turnId;
    if (state.kind === "interrupting")
      this.status = state.stopStatus ?? "pending";
    // A running snapshot can race the Stop request; only confirmed idle or a
    // different turn clears the local admission block.
    return true;
  }

  begin(): number | null {
    if (this.status === "pending") return null;
    this.status = "pending";
    return ++this.attempt;
  }

  current(attempt: number): boolean {
    return attempt === this.attempt && this.status !== null;
  }

  fail(attempt: number): boolean {
    if (!this.current(attempt)) return false;
    this.status = "unconfirmed";
    return true;
  }
}
