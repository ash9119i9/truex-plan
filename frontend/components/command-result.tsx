"use client";
import type { CommandRecord } from "../../shared/contracts";

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
}: {
  command: CommandRecord;
  onCommand?: (text: string) => void;
  onOpen?: (id: string) => void;
  onRefresh?: () => void;
}) {
  const goal = command.result?.goal;
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
        <strong>{commandLabel(command.method)}</strong>
        <span role="status">{status}</span>
      </header>
      {summary && <p>{summary}</p>}
      {command.error && <p role="alert">{command.error}</p>}
      {command.state === "running" && <p>Waiting for the command result.</p>}
      {succeeded && goal && (
        <dl>
          <div>
            <dt>Status at this update</dt>
            <dd>{goal.status}</dd>
          </div>
          {goal.tokensUsed !== undefined && (
            <div>
              <dt>Tokens used</dt>
              <dd>{goal.tokensUsed.toLocaleString()}</dd>
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
        {succeeded && goal && onCommand && (
          <>
            <button type="button" onClick={() => onCommand("/goal show")}>
              Check goal status
            </button>
            <button type="button" onClick={() => onCommand("/goal clear")}>
              Clear goal…
            </button>
          </>
        )}
        {command.result?.sessionId && onOpen && (
          <button
            type="button"
            onClick={() => onOpen(command.result!.sessionId!)}
          >
            Open conversation branch
          </button>
        )}
        {(command.state === "unknown" || command.state === "running") &&
          onRefresh && (
            <button type="button" onClick={onRefresh}>
              Check saved result
            </button>
          )}
      </div>
    </section>
  );
}
