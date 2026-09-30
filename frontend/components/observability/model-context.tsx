"use client";
import { useEffect, useState } from "react";
import { ApiRequestError, getTurnContext } from "@/lib/api";
import { maskedParts, modelContextVM, type ModelContextVM } from "@/lib/vm-insights";
import type { TurnContext } from "../../../shared/contracts";
import { ObIcon } from "./ob-icon";

type State =
  | { state: "loading" }
  | { state: "gone" }
  | { state: "error"; message: string }
  | { state: "ready"; vm: ModelContextVM; text: string };

// Dev mode only: what the model was fed for this turn, section by section,
// masked on the server. Token counts are estimated from characters (≈).
export function ModelContext({
  sessionId,
  turnId,
  contextWindow,
}: {
  sessionId?: string;
  turnId: string;
  contextWindow?: number | null;
}) {
  const [s, setS] = useState<State>({ state: "loading" });
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let live = true;
    if (!sessionId) {
      setS({ state: "gone" });
      return;
    }
    setS({ state: "loading" });
    getTurnContext(sessionId, turnId)
      .then((data) => {
        if (!live) return;
        const ctx = data as TurnContext;
        if (!Array.isArray(ctx?.sections)) return setS({ state: "gone" });
        setS({
          state: "ready",
          vm: modelContextVM(ctx, contextWindow),
          text: ctx.sections.map((x) => `## ${x.label}\n${x.text}`).join("\n\n"),
        });
      })
      .catch((e) => {
        if (!live) return;
        setS(
          e instanceof ApiRequestError && e.status === 404
            ? { state: "gone" }
            : { state: "error", message: (e as Error).message },
        );
      });
    return () => {
      live = false;
    };
  }, [sessionId, turnId, contextWindow]);

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be blocked; nothing else to do.
    }
  }

  return (
    <>
      {s.state === "loading" && (
        <div className="ob-sec">
          <p className="ob-oneline" role="status">
            Loading model context…
          </p>
        </div>
      )}
      {s.state === "gone" && (
        <div className="ob-sec">
          <p className="ob-oneline" role="status">
            No longer available. Context is captured for live turns only.
          </p>
        </div>
      )}
      {s.state === "error" && (
        <div className="ob-sec">
          <p className="ob-oneline" role="status">
            {s.message}
          </p>
        </div>
      )}
      {s.state === "ready" && (
        <>
          <div className="ob-sec">
            <div className="ob-h">
              Context window<span className="ob-r">{s.vm.summary}</span>
            </div>
            <div className="ob-stack" role="img" aria-label={`Context window: ${s.vm.summary}`}>
              {s.vm.composition.map((c) =>
                c.key === "free" ? (
                  <i key="free" style={{ flexGrow: c.weight, background: "var(--surface-3)" }} />
                ) : (
                  <i key={c.key} className={`ob-c-${c.key}`} style={{ flexGrow: c.weight }} />
                ),
              )}
            </div>
          </div>
          <div className="ob-sec" style={{ gap: 0 }}>
            {!s.vm.sections.length && (
              <p className="ob-oneline">Nothing was recorded for this turn.</p>
            )}
            {s.vm.sections.map((sec, i) => (
              <details className="ob-ctxsec" key={sec.key} open={sec.key === "docs" || (i === 0 && s.vm.sections.length === 1)}>
                <summary>
                  <ObIcon name="chev" sm />
                  <i className={`ob-c-${sec.key}`} />
                  <span>{sec.label}</span>
                  <span className={`ob-share ob-c-${sec.key}`} aria-hidden="true">
                    <i style={{ width: `${sec.share}%` }} />
                  </span>
                  <b>{sec.text}</b>
                </summary>
                <div className="ob-ctxbody">
                  {sec.files.length > 0 && (
                    <ul className="ob-files">
                      {sec.files.map((f) => (
                        <li key={f.key}>
                          <ObIcon name="file" sm />
                          <span title={f.label}>{f.label}</span>
                          <b>{f.text}</b>
                        </li>
                      ))}
                    </ul>
                  )}
                  <pre className="ob-pre">
                    {maskedParts(sec.body).map((p, j) =>
                      p.masked ? <mark key={j}>{p.text}</mark> : p.text,
                    )}
                  </pre>
                </div>
              </details>
            ))}
            {s.vm.truncated && <p className="ob-oneline">Long sections were shortened.</p>}
          </div>
        </>
      )}
      <div className="ob-foot">
        <span className="ob-mask">
          <ObIcon name="lock" sm />
          Masked on the server. Captured for live turns only.
        </span>
        {s.state === "ready" && (
          <span className="ob-right">
            <button
              type="button"
              className="btn ghost"
              style={{ height: 26, fontSize: 12 }}
              onClick={() => void copy(s.text)}
            >
              <ObIcon name={copied ? "check" : "eye"} sm />
              {copied ? "Copied" : "Copy masked"}
            </button>
            <span className="sr-only" role="status">
              {copied ? "Masked context copied" : ""}
            </span>
          </span>
        )}
      </div>
    </>
  );
}
