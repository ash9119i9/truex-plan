import { Terminal, FileDiff, Wrench, Brain } from "lucide-react";
export function RuntimeItem({ item }: { item: any }) {
  if (item.type === "agentMessage" || item.type === "userMessage") return null;
  const Icon =
    item.type === "commandExecution"
      ? Terminal
      : item.type === "fileChange"
        ? FileDiff
        : item.type === "reasoning"
          ? Brain
          : Wrench;
  const label =
    item.type === "commandExecution"
      ? "Command"
      : item.type === "fileChange"
        ? "File changes"
        : item.type === "mcpToolCall"
          ? `${item.server} · ${item.tool}`
          : item.type;
  return (
    <details className={`runtime-item runtime-${item.type}`}>
      <summary>
        <Icon size={14} />
        <b>{label}</b>
        <span>{item.status || ""}</span>
      </summary>
      {item.type === "commandExecution" ? (
        <>
          <code>{item.command}</code>
          <pre>{item.aggregatedOutput || "Waiting for output…"}</pre>
          {item.exitCode !== null && item.exitCode !== undefined && (
            <small>Exit code {item.exitCode}</small>
          )}
        </>
      ) : item.type === "fileChange" ? (
        (item.changes || []).map((change: any, i: number) => (
          <section key={i}>
            <b>{change.path}</b>
            <pre>{change.diff || JSON.stringify(change.kind)}</pre>
          </section>
        ))
      ) : item.type === "reasoning" ? (
        <p>{(item.summary || []).join("\n")}</p>
      ) : (
        <pre>{JSON.stringify(item, null, 2)}</pre>
      )}
    </details>
  );
}
