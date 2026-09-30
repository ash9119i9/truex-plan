"use client";
import { useState, type ReactNode } from "react";
import { OUTPUT_LINES, type LogRow, type WorkView } from "@/lib/vm-stream";
import { StreamIcon } from "./stream-icon";
import { ThinkingBlock } from "./thinking-block";
import { AuditList } from "./approval-record";

// One typed row on the work log's rail (wireframe §1 board 2). A running row
// is the only one that moves: ringed node with a spinner.
export function LogRowView({ row }: { row: LogRow }) {
  const node = row.running ? "k-live" : row.node;
  return (
    <li>
      <span className={node ? `node ${node}` : "node"} aria-hidden="true">
        {row.running ? (
          <span className="spinner" />
        ) : (
          <StreamIcon name={row.icon} sm />
        )}
      </span>
      <div className="what">
        {row.live ? (
          <span className="st-shim">{row.title}</span>
        ) : row.thinking ? (
          <ThinkingBlock
            title={row.title}
            summary={row.thinking.summary}
            raw={row.thinking.raw}
          />
        ) : (
          <RowBody row={row} />
        )}
      </div>
      <span className="t">{row.t}</span>
    </li>
  );
}

function RowBody({ row }: { row: LogRow }) {
  const code = row.code;
  return (
    <>
      <b>
        {row.mono ? (
          <>
            {row.title} · <span className="mono">{row.mono}</span>
          </>
        ) : (
          row.title
        )}
      </b>
      {row.files && !!(row.adds || row.dels) && (
        <span>
          <span className="st-add">+{row.adds}</span>{" "}
          <span className="st-del">−{row.dels}</span>
        </span>
      )}
      {row.sub &&
        (row.query ? (
          <span className="st-q">{row.sub}</span>
        ) : (
          <span className="st-sub">{row.sub}</span>
        ))}
      {code && (
        <div className="st-code">
          {code.command && <div className="cmd">{code.command}</div>}
          {code.output && <pre>{code.output}</pre>}
          {(code.exitCode !== null || code.lines > 0) && (
            <div className="ft">
              {code.exitCode !== null &&
                (code.exitCode === 0 ? (
                  <span className="ok">
                    <StreamIcon name="check" sm />
                    exit 0
                  </span>
                ) : (
                  <span className="bad">
                    <StreamIcon name="alert" sm />
                    exit {code.exitCode}
                  </span>
                ))}
              {code.lines > 0 && (
                <span>
                  {code.lines > OUTPUT_LINES
                    ? `${OUTPUT_LINES} of ${code.lines} lines`
                    : `${code.lines} ${code.lines === 1 ? "line" : "lines"}`}
                </span>
              )}
            </div>
          )}
        </div>
      )}
      {row.files
        ?.filter((f) => f.lines.length)
        .map((f, i) => (
          <div className="diff" key={`${f.path}:${i}`}>
            <div className="hd">{f.path}</div>
            {f.lines.map((l, j) => (
              <div key={j} className={l.kind === "ctx" ? undefined : l.kind}>
                {l.text}
              </div>
            ))}
          </div>
        ))}
      {row.audit && <AuditList rows={row.audit} />}
    </>
  );
}

// One collapsible card per turn (wireframe §1 board 2 pin 2, board 3 pin 1).
// Open while working with a live count; folds when the answer lands. The
// caller remounts it (key) when its default state changes.
export function WorkGroup({
  view,
  holds,
}: {
  view: WorkView;
  // Pending-request rows, placed last on the rail.
  holds?: ReactNode;
}) {
  const [open, setOpen] = useState(view.defaultOpen);
  return (
    <details
      className="st-work"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>
        <span className={view.running ? "st-sq run" : "st-sq"} aria-hidden="true">
          {view.running ? (
            <span className="spinner" />
          ) : (
            <StreamIcon name="check" sm />
          )}
        </span>
        <span className="st-sum">
          <b className={view.shimmer ? "st-shim" : undefined}>{view.title}</b>
          {view.small && <small>{view.small}</small>}
        </span>
        {!view.running && view.types.length > 0 && (
          <span className="st-types" aria-hidden="true">
            {view.types.map((t) => (
              <StreamIcon key={t} name={t} />
            ))}
          </span>
        )}
        <StreamIcon name="chevd" className="st-chev" />
      </summary>
      <ol className="log">
        {view.rows.map((row) => (
          <LogRowView key={row.id} row={row} />
        ))}
        {holds}
      </ol>
    </details>
  );
}
