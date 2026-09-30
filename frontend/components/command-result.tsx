"use client";
import type { CommandRecord, Goal, GoalReview } from "../../shared/contracts";
import { sameGoal } from "@/lib/goal";
import { commandLabel, commandView } from "@/lib/vm-stream";
import { StreamIcon } from "./stream-icon";

export { commandLabel };

// Result card that hangs under a slash-command bubble (wireframe §1 board 1,
// pins 4 and 5): icon tile, title, state pill, what changed. A failed command
// uses the bad tone and echoes the command in mono; the user edits and resends.
export function CommandResult({
  command,
  text = "",
  onCommand,
  onOpen,
  onRefresh,
  currentGoal,
}: {
  command: CommandRecord;
  // The bubble text, e.g. "/goal Ship the plan".
  text?: string;
  currentGoal?: Goal | null;
  // Kept for callers; goal review status now lives in the topbar.
  goalReview?: GoalReview | null;
  onCommand?: (text: string) => void;
  onOpen?: (id: string) => void;
  onRefresh?: () => void;
}) {
  const recorded = command.result?.goal;
  // A card for the conversation's current goal follows its live state; an
  // older card keeps what it recorded.
  const live = sameGoal(recorded, currentGoal) ? currentGoal! : null;
  const goal = live || recorded;
  const v = commandView(text, command, goal?.objective, !!live);
  const succeeded = command.state === "succeeded";
  const actions = [
    succeeded &&
      live &&
      onCommand && { label: "Check goal", run: () => onCommand("/goal show") },
    succeeded &&
      live &&
      onCommand && { label: "Clear goal…", run: () => onCommand("/goal clear") },
    command.result?.sessionId &&
      onOpen && {
        label: "Open branch",
        run: () => onOpen(command.result!.sessionId!),
      },
    (command.state === "unknown" || command.state === "running") &&
      onRefresh && { label: "Check saved result", run: onRefresh },
  ].filter(Boolean) as { label: string; run: () => void }[];
  return (
    <section
      className={v.tone === "bad" ? "st-rc bad" : "st-rc"}
      aria-label={`${commandLabel(command.method)} result`}
    >
      <span className="tile" aria-hidden="true">
        <StreamIcon name={v.tile} />
      </span>
      <div className="b">
        <div className="h">
          <b>{v.title}</b>
          <span className={`pill ${v.pill.tone}`} role="status">
            {v.pill.spinner && <span className="spinner" aria-hidden="true" />}
            {v.pill.icon && <StreamIcon name={v.pill.icon} sm />}
            {v.pill.label}
          </span>
        </div>
        <span role={v.tone === "bad" ? "alert" : undefined}>{v.body}</span>
        {v.foot && (
          <span className="f">
            {v.foot.icon && <StreamIcon name={v.foot.icon} sm />}
            {v.foot.mono && <span className="mono">{v.foot.mono}</span>}
            {v.foot.mono ? ` · ${v.foot.text}` : v.foot.text}
          </span>
        )}
        {!!actions.length && (
          <span className="f acts">
            {actions.map((a) => (
              <button
                key={a.label}
                type="button"
                className="st-mini"
                onClick={a.run}
              >
                {a.label}
              </button>
            ))}
          </span>
        )}
      </div>
    </section>
  );
}
