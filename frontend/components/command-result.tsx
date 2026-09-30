"use client";
import type { CommandRecord, Goal, GoalReview } from "../../shared/contracts";
import {
  formatDuration,
  goalStateLabel,
  goalStatus,
  goalTokens,
  sameGoal,
} from "@/lib/goal";

export function commandLabel(method: string) {
  if (method === "help") return "Chat commands";
  if (method.startsWith("thread/goal/")) return "Goal";
  return (
    (
      {
        "thread/fork": "Conversation branch",
        "thread/compact/start": "Context",
        "thread/settings/update": "Settings",
        "thread/archive": "Archive",
        "thread/unarchive": "Restore",
      } as Record<string, string>
    )[method] || "Command"
  );
}
export function CommandResult({
  command,
  onCommand,
  onOpen,
  onRefresh,
  currentGoal,
  goalReview,
}: {
  command: CommandRecord;
  currentGoal?: Goal | null;
  goalReview?: GoalReview | null;
  onCommand?: (text: string) => void;
  onOpen?: (id: string) => void;
  onRefresh?: () => void;
}) {
  const recorded = command.result?.goal;
  // A card for the conversation's current goal follows its live state; an
  // older card keeps the status it recorded.
  const live = sameGoal(recorded, currentGoal) ? currentGoal! : null;
  const goal = live || recorded;
  const succeeded = command.state === "succeeded";
  const status = {
    running: "Awaiting confirmation",
    succeeded: "Confirmed",
    failed: "Failed",
    unknown: "Unconfirmed",
  }[command.state];
  let summary = "";
  if (succeeded) {
    if (command.result?.help) summary = command.result.help;
    else if (command.method === "thread/goal/clear") summary = "Goal cleared.";
    else if (command.method.startsWith("thread/goal/"))
      summary = goal ? goal.objective : "No goal is set.";
    else if (command.method === "thread/fork")
      summary = "Your new conversation branch is ready.";
    else if (command.method === "thread/compact/start")
      summary =
        "Context compaction requested. Completion will appear in the conversation activity.";
    else if (command.method === "thread/archive")
      summary = "Conversation archived.";
    else if (command.method === "thread/unarchive")
      summary = "Conversation restored.";
    else summary = "Conversation settings updated.";
  }
  return (
    <section
      className={`command-result command-${command.state}`}
      aria-label={`${commandLabel(command.method)} result`}
    >
      <header>
        <span className="eyebrow">{commandLabel(command.method)}</span>
        <span
          role="status"
          className={`ag-chip ${
            command.state === "succeeded"
              ? "is-done"
              : command.state === "running"
                ? "is-running"
                : command.state === "failed"
                  ? "is-warn"
                  : "is-stopped"
          }`}
        >
          {command.state === "running" && (
            <span className="spinner" aria-hidden="true" />
          )}
          {status}
        </span>
      </header>
      {summary && <p>{summary}</p>}
      {command.error && <p role="alert">{command.error}</p>}
      {command.state === "running" && <p>Waiting for the command result.</p>}
      {succeeded && goal && (
        <dl>
          <div>
            <dt>{live ? "Status" : "Status at this update"}</dt>
            <dd>
              {live
                ? goalStateLabel(live, goalReview ?? null)
                : goalStatus[goal.status]?.label || goal.status}
            </dd>
          </div>
          {!!goal.timeUsedSeconds && (
            <div>
              <dt>Time spent</dt>
              <dd>{formatDuration(goal.timeUsedSeconds)}</dd>
            </div>
          )}
          {goal.tokensUsed !== undefined && (
            <div>
              <dt>Tokens used</dt>
              <dd>{goalTokens(goal).toLocaleString()}</dd>
            </div>
          )}
          {goal.tokenBudget != null && (
            <div>
              <dt>Token budget</dt>
              <dd>{goal.tokenBudget.toLocaleString()}</dd>
            </div>
          )}
        </dl>
      )}
      {succeeded && command.method === "thread/settings/update" && (
        <dl>
          {typeof command.params.model === "string" && (
            <div>
              <dt>Model</dt>
              <dd>{command.params.model}</dd>
            </div>
          )}
          {typeof command.params.effort === "string" && (
            <div>
              <dt>Reasoning effort</dt>
              <dd>{command.params.effort}</dd>
            </div>
          )}
        </dl>
      )}
      <div className="command-actions">
        {succeeded && live && onCommand && (
          <>
            <button
              type="button"
              className="btn-soft"
              onClick={() => onCommand("/goal show")}
            >
              Check goal status
            </button>
            <button
              type="button"
              className="btn-soft"
              onClick={() => onCommand("/goal clear")}
            >
              Clear goal…
            </button>
          </>
        )}
        {command.result?.sessionId && onOpen && (
          <button
            type="button"
            className="btn-soft"
            onClick={() => onOpen(command.result!.sessionId!)}
          >
            Open conversation branch
          </button>
        )}
        {(command.state === "unknown" || command.state === "running") &&
          onRefresh && (
            <button type="button" className="btn-soft" onClick={onRefresh}>
              Check saved result
            </button>
          )}
      </div>
    </section>
  );
}
