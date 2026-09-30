import type { ApprovalRecord } from "../../shared/contracts";
import { auditRows, type AuditRow } from "@/lib/vm-stream";
import { StreamIcon } from "./stream-icon";

// After-the-fact audit inside the work log (wireframe §1 board 2, pin 7): one
// compact row per decision. Secret answers never render, only a fixed mask.
export function AuditList({ rows }: { rows: AuditRow[] }) {
  return (
    <div className="st-audit" role="list" aria-label="Decisions">
      {rows.map((row, i) => (
        <div key={i} className={row.tone} role="listitem">
          <StreamIcon name={row.icon} />
          <span className="d">{row.label}</span>
          <span className="x" title={row.detail}>
            {row.detail}
            {row.masked && (
              <>
                {" · "}
                <span className="st-mask" aria-label="answer hidden">
                  ••••••••
                </span>
              </>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

// One record on its own, for callers outside the work log.
export function ApprovalRecordView({ record }: { record: ApprovalRecord }) {
  return <AuditList rows={auditRows(record)} />;
}
