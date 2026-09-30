"use client";
import { useState } from "react";
import { Code2 } from "lucide-react";
import { Icon } from "../v2/icon";
import { getTurnContext, ApiRequestError } from "@/lib/api";
import { formatDuration } from "@/lib/observability";
import type { TurnContext, TurnTrace } from "../../../shared/contracts";
import { StepTimeline } from "./step-timeline";
import { TokenBar } from "./token-bar";
import { PrivacyCard } from "./privacy-card";
import { useDeveloperMode } from "./use-developer-mode";

// Level 2: timeline, tokens and privacy for one turn. Level 3 (developer
// toggle): what the model saw, the raw trace and its ids.
export function TraceCard({
  trace,
  sessionId,
  id,
}: {
  trace: TurnTrace;
  sessionId?: string;
  id: string;
}) {
  const [developer, setDeveloper] = useDeveloperMode();
  return (
    <section className="tc" id={id} aria-label="Turn details">
      <div className="tc-section">
        <h4>
          Where the time went
          <span>{formatDuration(trace.totalMs)} total</span>
        </h4>
        <StepTimeline trace={trace} />
      </div>
      <div className="tc-section">
        <h4>
          What it used
          {trace.model && <span>{trace.model}</span>}
        </h4>
        <TokenBar usage={trace.usage} helperUsage={trace.helperUsage} />
      </div>
      <div className="tc-section">
        <h4>Your data</h4>
        <PrivacyCard report={trace.privacy} />
      </div>
      <label className="tc-dev-toggle">
        <input
          type="checkbox"
          checked={developer}
          onChange={(e) => setDeveloper(e.target.checked)}
        />
        <Code2 size={13} aria-hidden="true" /> Developer details
      </label>
      {developer && <DeveloperDetails trace={trace} sessionId={sessionId} />}
    </section>
  );
}

type ContextState =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "gone" }
  | { state: "error"; message: string }
  | { state: "ready"; context: TurnContext };

function DeveloperDetails({
  trace,
  sessionId,
}: {
  trace: TurnTrace;
  sessionId?: string;
}) {
  const [context, setContext] = useState<ContextState>({ state: "idle" });
  const [copied, setCopied] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const json = JSON.stringify(trace, null, 2);
  async function loadContext() {
    if (!sessionId) return setContext({ state: "gone" });
    setContext({ state: "loading" });
    try {
      const data = (await getTurnContext(sessionId, trace.turnId)) as TurnContext;
      setContext(
        Array.isArray(data?.sections)
          ? { state: "ready", context: data }
          : { state: "gone" },
      );
    } catch (e) {
      setContext(
        e instanceof ApiRequestError && e.status === 404
          ? { state: "gone" }
          : { state: "error", message: (e as Error).message },
      );
    }
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setShowRaw(true);
    }
  }
  return (
    <div className="tc-dev">
      <dl className="tc-ids">
        <dt>Turn</dt>
        <dd>
          <code>{trace.turnId}</code>
        </dd>
        <dt>Thread</dt>
        <dd>
          <code>{trace.threadId}</code>
        </dd>
        <dt>Status</dt>
        <dd>{trace.status}</dd>
      </dl>
      <div className="tc-dev-actions">
        <button
          type="button"
          className="link"
          onClick={() => void loadContext()}
          disabled={context.state === "loading"}
          aria-expanded={context.state === "ready"}
        >
          {context.state === "loading" ? "Loading…" : "What the model saw"}
        </button>
        <button
          type="button"
          className="link"
          aria-expanded={showRaw}
          onClick={() => setShowRaw((v) => !v)}
        >
          {showRaw ? "Hide trace JSON" : "Show trace JSON"}
        </button>
        <button type="button" className="link" onClick={() => void copy()}>
          {copied ? (
            <Icon name="check" size={12} />
          ) : (
            <Icon name="doc" size={12} />
          )}
          {copied ? "Copied" : "Copy trace JSON"}
        </button>
        <span className="sr-only" role="status">
          {copied ? "Trace JSON copied" : ""}
        </span>
      </div>
      {context.state === "gone" && (
        <p className="tc-note" role="status">
          No longer available, context is kept only while the session is live.
        </p>
      )}
      {context.state === "error" && (
        <p className="tc-note" role="status">
          {context.message}
        </p>
      )}
      {context.state === "ready" && (
        <div className="tc-context">
          <p className="tc-note">
            <span className="tc-tag">Reconstructed</span> Rebuilt from the
            turn’s events with personal data masked. It may differ from the
            exact prompt.
          </p>
          {context.context.sections.map((s, i) => (
            <details key={i} className="tc-context-section">
              <summary>
                {s.label}
                <span>{s.chars.toLocaleString()} chars</span>
              </summary>
              <pre>{s.text}</pre>
            </details>
          ))}
          {!context.context.sections.length && (
            <p className="tc-note">Nothing was recorded for this turn.</p>
          )}
          {context.context.truncated && (
            <p className="tc-note">Long sections were shortened.</p>
          )}
        </div>
      )}
      {showRaw && (
        <pre className="tc-json" tabIndex={0} aria-label="Trace JSON">
          {json}
        </pre>
      )}
    </div>
  );
}
