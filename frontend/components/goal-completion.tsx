"use client";
import { useId, useMemo, useState } from "react";
import type { Goal } from "../../shared/contracts";
import type { ConversationFile } from "../../shared/assistant-capabilities";
import type { Entry } from "@/lib/chat";
import { closingSummary, goalDocuments } from "@/lib/goal-completion";
import { Button } from "./ui/button";
import { DocumentIcon } from "./document-icon";

// Shows what a completed goal produced, inside the goal bar's review panel.
export function GoalCompletion({
  goal,
  entries,
  documents,
  href,
}: {
  goal: Goal;
  entries: Entry[];
  documents: ConversationFile[];
  href?: (id: string) => string;
}) {
  const [expanded, setExpanded] = useState(false);
  const summaryId = useId();
  const summary = useMemo(() => closingSummary(entries, goal), [entries, goal]);
  const files = useMemo(
    () => goalDocuments(documents, goal),
    [documents, goal],
  );
  if (!summary && !files.length) return null;
  return (
    <div className="goal-completion">
      {summary && (
        <section
          className="goal-completion-summary"
          aria-label="Closing summary"
        >
          <h4>Closing summary</h4>
          <p
            id={summaryId}
            className="goal-completion-text"
            data-expanded={expanded || undefined}
          >
            {expanded ? summary.text : summary.preview}
          </p>
          {summary.truncated && (
            <Button
              type="button"
              variant="ghost"
              className="goal-completion-toggle"
              aria-expanded={expanded}
              aria-controls={summaryId}
              onClick={() => setExpanded((open) => !open)}
            >
              {expanded ? "Show less" : "Show more"}
            </Button>
          )}
        </section>
      )}
      {files.length > 0 && (
        <section
          className="goal-completion-documents"
          aria-label="Documents created during this goal"
        >
          <h4>
            {files.length === 1
              ? "1 document created"
              : `${files.length} documents created`}
          </h4>
          <ul>
            {files.map((file) => (
              <li key={file.id}>
                <DocumentIcon name={file.name} size={14} />
                <span className="goal-completion-name" title={file.name}>
                  {file.name}
                </span>
                {href && (
                  // The documents route serves files as attachments.
                  <a
                    className="button button-outline"
                    href={href(file.id)}
                    download={file.name}
                    aria-label={`Download ${file.name}`}
                  >
                    Download
                  </a>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
