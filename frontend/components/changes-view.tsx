"use client";
import { useState } from "react";
import { PanelIcon } from "./panel-icons";
import type { SessionFile } from "@/lib/vm-panel";

// Wireframe r2 Board C, note 4 + "Changes view" (gaps table): every file the
// session touched, net lines, a chip per turn that touched it (first one
// marked "created"). Tapping a turn chip opens that turn's diff for the file,
// parsed from diff.updated.
export function ChangesView({
  files,
  selectedId,
  liveId,
}: {
  files: SessionFile[];
  selectedId: string | null;
  liveId: string | null;
}) {
  const [open, setOpen] = useState<{ path: string; turnId: string } | null>(
    null,
  );
  const file = open && files.find((f) => f.path === open.path);
  const edit = file && file.edits.find((e) => e.turnId === open!.turnId);
  return (
    <>
      <ul className="pn-files" aria-label="Files changed across session">
        {files.map((f) => (
          <li key={f.path}>
            <PanelIcon name="file" />
            <code>{f.path}</code>
            {f.writing ? (
              <span className="pill accent sm">writing</span>
            ) : (
              <span>
                {f.added > 0 && <span className="pn-add">+{f.added}</span>}
                {f.added > 0 && f.removed > 0 && " "}
                {f.removed > 0 && <span className="pn-del">-{f.removed}</span>}
              </span>
            )}
            <span className="pn-turnset">
              {f.edits.map((e) => {
                const shown =
                  open?.path === f.path && open.turnId === e.turnId;
                return (
                  <button
                    key={e.turnId}
                    type="button"
                    className={`pn-tc${e.turnId === liveId ? " live" : e.turnId === selectedId || shown ? " on" : ""}`}
                    aria-pressed={shown}
                    aria-label={`Show ${e.label} changes to ${f.path}`}
                    onClick={() =>
                      setOpen(shown ? null : { path: f.path, turnId: e.turnId })
                    }
                  >
                    {e.label}
                    {e.created ? " created" : ""}
                  </button>
                );
              })}
            </span>
          </li>
        ))}
      </ul>
      {file && edit && (
        <div
          className="diff"
          role="group"
          aria-label={`Changes to ${file.path} in ${edit.label}`}
        >
          <div className="hd">
            {file.path} · {edit.label}
          </div>
          {edit.diff.lines.length ? (
            edit.diff.lines.map((line, i) => (
              <div
                key={i}
                className={
                  line[0] === "+" ? "add" : line[0] === "-" ? "del" : undefined
                }
              >
                {line}
              </div>
            ))
          ) : (
            <div>No line changes</div>
          )}
        </div>
      )}
    </>
  );
}
