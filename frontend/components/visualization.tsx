"use client";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  api,
  apiIdentityScope,
  clientCacheEnabled,
  onApiIdentityChange,
  userMessage,
} from "@/lib/api";
import {
  validWidgetState,
  visualizationDocument,
  visualizationExport,
} from "@/lib/visualization";
import type {
  Visualization as Visual,
  VisualizationState,
} from "../../shared/visualizations";

const subscribeIdentity = (listener: () => void) =>
  clientCacheEnabled() ? onApiIdentityChange(listener) : () => {};

export function Visualization({
  sessionId,
  id,
  onPrompt,
}: {
  sessionId: string;
  id: string;
  onPrompt?: (text: string) => void;
}) {
  const [visual, setVisual] = useState<Visual | null>(null);
  const [visualScope, setVisualScope] = useState<string | undefined>();
  const [error, setError] = useState("");
  const [runtimeError, setRuntimeError] = useState(false);
  const [height, setHeight] = useState(360);
  const [expanded, setExpanded] = useState(false);
  const [reload, setReload] = useState(0);
  const [question, setQuestion] = useState<{
    prompt: string;
    title: string;
  } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const iframe = useRef<HTMLIFrameElement>(null),
    dialog = useRef<HTMLDialogElement>(null);
  const state = useRef<VisualizationState | null>(null);
  const scoped = clientCacheEnabled();
  const identity = useSyncExternalStore(
    subscribeIdentity,
    apiIdentityScope,
    () => undefined,
  );
  const stateKey = `truex-visualization:${scoped ? identity + ":" : ""}${sessionId}:${id}`;
  useEffect(() => {
    let cancelled = false;
    setVisual(null);
    setError("");
    setQuestion(null);
    setExpanded(false);
    state.current = null;
    try {
      const saved = scoped
        ? null
        : JSON.parse(localStorage.getItem(stateKey) || "null");
      if (validWidgetState(saved)) state.current = saved;
    } catch {
      /* Storage can be unavailable. */
    }
    api(`/api/sessions/${sessionId}/visualizations/${id}`)
      .then((value) => {
        if (!cancelled) {
          setVisual(value);
          setVisualScope(apiIdentityScope());
        }
      })
      .catch((error) => {
        if (!cancelled) setError(userMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, id, stateKey, scoped]);
  const source = useMemo(
    () =>
      visual && (!scoped || visualScope === identity)
        ? visualizationDocument(visual, state.current)
        : "",
    [visual, expanded, reload, scoped, visualScope, identity],
  );
  useEffect(() => {
    setLoaded(false);
    setRuntimeError(false);
    const timer = setTimeout(() => setRuntimeError(true), 12000);
    function receive(event: MessageEvent) {
      if (
        !iframe.current ||
        (scoped && identity !== apiIdentityScope()) ||
        event.source !== iframe.current.contentWindow ||
        event.origin !== "null"
      )
        return;
      const data = event.data;
      if (
        !data ||
        typeof data !== "object" ||
        data.channel !== "truex-visualization"
      )
        return;
      if (data.type === "ready") {
        clearTimeout(timer);
        setLoaded(true);
      }
      if (data.type === "error") setRuntimeError(true);
      if (data.type === "resize" && Number.isFinite(data.height))
        setHeight(Math.min(900, Math.max(160, data.height + 4)));
      if (data.type === "state" && validWidgetState(data.state)) {
        state.current = data.state;
        try {
          if (!scoped)
            localStorage.setItem(stateKey, JSON.stringify(data.state));
        } catch {
          /* Keep state in memory. */
        }
      }
      if (
        data.type === "followup" &&
        typeof data.prompt === "string" &&
        data.prompt.trim() &&
        data.prompt.length <= 2000
      ) {
        setQuestion({
          prompt: data.prompt,
          title:
            typeof data.title === "string"
              ? data.title.slice(0, 250)
              : "Ask about this visual",
        });
      }
    }
    window.addEventListener("message", receive);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("message", receive);
    };
  }, [source, stateKey, scoped, identity]);
  useEffect(() => {
    if (expanded) dialog.current?.showModal();
    else dialog.current?.close();
  }, [expanded]);
  function context(prompt: string) {
    return `${prompt}\n\nVisualization: ${visual?.title} (ID ${id}).${state.current?.modelContent != null ? "\nSelected values: " + JSON.stringify(state.current.modelContent) : ""}`;
  }
  function download() {
    if (!visual) return;
    const url = URL.createObjectURL(
      new Blob([visualizationExport(visual, state.current)], {
        type: "text/html",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "truex-visualization.html";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  if (error)
    return (
      <div className="visualization-error" role="alert">
        This visual could not be loaded. {error}
      </div>
    );
  if (!visual || (scoped && visualScope !== identity))
    return <p role="status">Loading visual…</p>;
  const frame = (
    <iframe
      ref={iframe}
      title={visual.title}
      srcDoc={source}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"
      style={{ height }}
    />
  );
  const controls = (
    <div className="visualization-controls">
      <button
        className="btn-soft"
        type="button"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? "Close expanded view" : "Expand"}
      </button>
      <button
        className="btn-soft"
        type="button"
        onClick={() => setReload((x) => x + 1)}
      >
        Reload visual
      </button>
      <button className="btn-soft" type="button" onClick={download}>
        Download HTML
      </button>
      {onPrompt && (
        <button
          className="btn-soft"
          type="button"
          onClick={() => {
            onPrompt(context("Explain the current view and selected values."));
            setExpanded(false);
          }}
        >
          Ask about this visual
        </button>
      )}
    </div>
  );
  const followup = question && (
    <div className="visualization-question">
      <strong>{question.title}</strong>
      <p>{question.prompt}</p>
      <button
        className="btn-solid"
        type="button"
        disabled={!onPrompt}
        onClick={() => {
          onPrompt?.(context(question.prompt));
          setQuestion(null);
          setExpanded(false);
        }}
      >
        Add to my message
      </button>
      <button
        className="btn-soft"
        type="button"
        onClick={() => setQuestion(null)}
      >
        Dismiss
      </button>
    </div>
  );
  const status = (
    <>
      {!loaded && !runtimeError && <p role="status">Preparing visual…</p>}
      {runtimeError && (
        <p role="status">
          The visual may not have rendered correctly. Try reloading or ask Truex
          to revise it.
        </p>
      )}
    </>
  );
  return (
    <figure className={`visualization visualization-${visual.mode}`}>
      <figcaption>
        <strong>{visual.title}</strong>
        <p>{visual.description}</p>
      </figcaption>
      {!expanded && (
        <>
          {controls}
          {status}
          {frame}
          {followup}
        </>
      )}
      <dialog
        ref={dialog}
        className="visualization-dialog"
        onCancel={() => setExpanded(false)}
        onClose={() => setExpanded(false)}
      >
        {expanded && (
          <>
            <h2>{visual.title}</h2>
            {controls}
            {status}
            {frame}
            {followup}
          </>
        )}
      </dialog>
    </figure>
  );
}
