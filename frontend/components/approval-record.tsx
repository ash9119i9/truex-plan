import type { ApprovalRecord } from "../../shared/contracts";
import {
  autoAnswerNote,
  decisionLabel,
  recordSummary,
  type ModeRecord,
} from "@/lib/approval-mode";

function time(at?: string) {
  const date = at ? new Date(at) : null;
  return date && !Number.isNaN(date.getTime())
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : "";
}

// A compact, read-only line in the chat recording what was decided, so the
// conversation keeps an audit trail after the request card goes away.
export function ApprovalRecordView({
  record: shared,
}: {
  record: ApprovalRecord | ModeRecord;
}) {
  const record = shared as ModeRecord;
  const at = time(record.at);
  return (
    <div className="approval-record" role="group" aria-label="Your decision">
      {record.items.map((item, i) => {
        if (item.kind === "toolApproval") {
          const d = decisionLabel(record, item.decision);
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
          : item.answer
            ? record.outcome === "auto"
              ? `${item.answer} (${autoAnswerNote(record)})`
              : item.answer
            : record.outcome === "answered"
              ? ""
              : "No answer";
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
          {recordSummary(record)} at {at}
        </time>
      )}
    </div>
  );
}
