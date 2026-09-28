import type { ApprovalRecord } from "../../shared/contracts";

type Item = ApprovalRecord["items"][number];
const decisions: Record<
  Extract<Item, { kind: "toolApproval" }>["decision"],
  { text: string; tone: "allowed" | "declined" | "muted" }
> = {
  allowedOnce: { text: "Allowed once", tone: "allowed" },
  allowedSession: { text: "Allowed for this chat", tone: "allowed" },
  allowedAlways: { text: "Always allowed", tone: "allowed" },
  declined: { text: "Not allowed", tone: "declined" },
  expired: { text: "No answer — timed out", tone: "muted" },
  interrupted: { text: "No answer — stopped", tone: "muted" },
};

function time(at?: string) {
  const date = at ? new Date(at) : null;
  return date && !Number.isNaN(date.getTime())
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : "";
}

// A compact, read-only line in the chat recording what was decided, so the
// conversation keeps an audit trail after the request card goes away.
export function ApprovalRecordView({ record }: { record: ApprovalRecord }) {
  const at = time(record.at);
  return (
    <div className="approval-record" role="group" aria-label="Your decision">
      {record.items.map((item, i) => {
        if (item.kind === "toolApproval") {
          const d = decisions[item.decision] || decisions.declined;
          return (
            <div key={i} className="approval-record-row">
              <span
                className={`approval-record-dot approval-record-${d.tone}`}
                aria-hidden="true"
              />
              <span className="approval-record-body">
                <span className="approval-record-title">
                  {item.action || "Connected business service"}
                </span>
                <span
                  className={`approval-record-badge approval-record-${d.tone}`}
                >
                  {d.text}
                </span>
              </span>
            </div>
          );
        }
        const answer = item.secret
          ? "Answer hidden"
          : item.answer || (record.outcome === "answered" ? "" : "No answer");
        return (
          <div key={i} className="approval-record-row">
            <span
              className="approval-record-dot approval-record-muted"
              aria-hidden="true"
            />
            <span className="approval-record-body">
              <span className="approval-record-question">{item.question}</span>
              <span className="approval-record-answer">{answer}</span>
            </span>
          </div>
        );
      })}
      {at && (
        <time className="approval-record-time" dateTime={record.at}>
          {record.outcome === "answered" ? "You answered" : "Closed"} at {at}
        </time>
      )}
    </div>
  );
}
