"use client";
import { useEffect, useRef, useState } from "react";
import {
  agentHandle,
  AGENT_NAME_MAX,
  AGENT_PURPOSE_MAX,
  DEFAULT_AGENT_LOOK,
  DEFAULT_AGENT_TINT,
  type AgentSummary,
  type AgentTint,
  type ModelOption,
} from "../../../shared/contracts";
import { ApiRequestError, userMessage } from "@/lib/api";
import {
  createAgent,
  createAgentBody,
  fetchModels,
  handleTaken,
  modelShort,
} from "@/lib/agents";
import { LOOKS, TINTS, tintOf } from "@/lib/agent-look";
import { Badge, Confetti, Robot } from "./agent-badge";
import { Icon } from "./icon";

// New agent dialog (design spec "s-dialog"). Create mode only for now: the
// platform has no edit or remove endpoints yet. When it does, add an
// `editing` prop that seeds the form, fixes the handle and swaps the submit
// action; the form and stage below are shared by both modes.

type Models =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; list: ModelOption[] };

const emptyForm = () => ({
  name: "",
  description: "",
  systemPrompt: "",
  look: DEFAULT_AGENT_LOOK,
  tint: DEFAULT_AGENT_TINT as AgentTint,
  modelProfileId: "",
});

export function AgentDialog({
  open,
  agents,
  onClose,
  onCreated,
  onSayHi,
}: {
  open: boolean;
  agents: AgentSummary[];
  onClose: () => void;
  onCreated: (a: AgentSummary) => void;
  onSayHi: (a: AgentSummary) => void;
}) {
  const [f, setF] = useState(emptyForm),
    [models, setModels] = useState<Models>({ state: "loading" }),
    [created, setCreated] = useState<AgentSummary | null>(null),
    [submitting, setSubmitting] = useState(false),
    [error, setError] = useState(""),
    // A handle the server reported as taken (409) that the list didn't know.
    [serverTaken, setServerTaken] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);
  const set = <K extends keyof ReturnType<typeof emptyForm>>(
    k: K,
    v: ReturnType<typeof emptyForm>[K],
  ) => {
    setF((x) => ({ ...x, [k]: v }));
    setError("");
  };

  useEffect(() => {
    if (!open) return;
    setF(emptyForm());
    setCreated(null);
    setSubmitting(false);
    setError("");
    setServerTaken("");
    setModels({ state: "loading" });
    let live = true;
    fetchModels().then(
      (list) => {
        if (!live) return;
        const safe = Array.isArray(list) ? list : [];
        setModels({ state: "ready", list: safe });
        setF((x) => ({ ...x, modelProfileId: safe[0]?.id || "" }));
      },
      (e) => {
        if (live) setModels({ state: "error", message: userMessage(e) });
      },
    );
    const focus = setTimeout(() => nameRef.current?.focus(), 30);
    return () => {
      live = false;
      clearTimeout(focus);
    };
  }, [open]);
  if (!open) return null;

  const handle = agentHandle(f.name);
  const taken =
    !!handle && (handleTaken(handle, agents) || handle === serverTaken);
  const list = models.state === "ready" ? models.list : [];
  const selectedModel = list.find((m) => m.id === f.modelProfileId);
  const valid = !!handle && !taken && !!selectedModel && !submitting;

  const submit = async () => {
    if (!valid) return;
    setSubmitting(true);
    setError("");
    try {
      const a = await createAgent(createAgentBody(f));
      onCreated(a);
      setCreated(a);
    } catch (e) {
      if (e instanceof ApiRequestError && e.code === "AGENT_HANDLE_TAKEN")
        setServerTaken(handle);
      else setError(userMessage(e));
    } finally {
      setSubmitting(false);
    }
  };

  // Success: no card. The badge drops from the top of the viewport over a dark scrim.
  if (created) {
    const createdHandle = created.handle || agentHandle(created.name);
    return (
      <div
        className="scrim celebrate"
        role="dialog"
        aria-modal="true"
        aria-labelledby="nad-title"
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
      >
        <button
          type="button"
          className="icon-btn ghost dialog-x"
          onClick={onClose}
          aria-label="Close"
        >
          <Icon name="x" size={15} />
        </button>
        <Confetti />
        <div className="celebrate-stage">
          <Badge
            name={created.name}
            handle={createdHandle}
            look={created.look ?? DEFAULT_AGENT_LOOK}
            tint={created.tint || DEFAULT_AGENT_TINT}
            modelLabel={modelShort(selectedModel?.name || created.model || "")}
            tag="new specialist"
          />
        </div>
        <div className="nad-done-copy celebrate-copy">
          <h2 id="nad-title">{created.name} is on the team</h2>
          <p>
            Mention <code>@{createdHandle}</code> anywhere to wake it. Drag the
            badge around while you&apos;re here.
          </p>
          <div className="nad-actions">
            <button
              type="button"
              className="btn-solid lg"
              onClick={() => onSayHi(created)}
              autoFocus
            >
              Say hi to {created.name}
            </button>
            <button type="button" className="btn-soft lg" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="scrim center"
      onMouseDown={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div
        className="agent-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="nad-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="icon-btn ghost dialog-x"
          onClick={onClose}
          aria-label="Close"
        >
          <Icon name="x" size={15} />
        </button>

        <form
          className="nad-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="nad-head">
            <h2 id="nad-title">New agent</h2>
            <p>
              A persistent specialist with its own identity and chat. Mention it
              in groups by its handle.
            </p>
          </div>

          <label className="field">
            <span className="field-label">
              Name
              {handle && (
                <span className={"field-hint" + (taken ? " is-bad" : "")}>
                  {taken ? `@${handle} is taken` : `@${handle}`}
                </span>
              )}
            </span>
            <input
              ref={nameRef}
              className="input"
              value={f.name}
              maxLength={AGENT_NAME_MAX}
              placeholder="Research Scout"
              aria-invalid={taken}
              onChange={(e) => set("name", e.target.value)}
            />
          </label>
          {/* <label className="field">
            <span className="field-label">Purpose</span>
            <input
              className="input"
              value={f.description}
              maxLength={AGENT_PURPOSE_MAX}
              placeholder="What this specialist owns"
              onChange={(e) => set("description", e.target.value)}
            />
          </label> */}
          <label className="field">
            <span className="field-label">Instructions</span>
            <textarea
              className="input"
              value={f.systemPrompt}
              rows={3}
              placeholder="Standing instructions injected into every one of its turns"
              onChange={(e) => set("systemPrompt", e.target.value)}
            />
          </label>

          <div className="field">
            <span className="field-label" id="nad-look">
              Look
            </span>
            <div
              className="look-grid"
              role="radiogroup"
              aria-labelledby="nad-look"
            >
              {LOOKS.map((l, i) => (
                <button
                  key={l.name}
                  type="button"
                  role="radio"
                  aria-checked={f.look === i}
                  aria-label={l.name}
                  title={l.name}
                  className={"look" + (f.look === i ? " is-active" : "")}
                  style={{ background: tintOf(f.tint).bg }}
                  onClick={() => set("look", i)}
                >
                  <Robot look={i} size={40} />
                </button>
              ))}
            </div>
            <div className="tint-row" role="radiogroup" aria-label="Tint">
              <span className="field-label">Tint</span>
              {TINTS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="radio"
                  aria-checked={f.tint === t.id}
                  aria-label={t.label}
                  title={t.label}
                  className={"tint" + (f.tint === t.id ? " is-active" : "")}
                  style={{ background: t.bg }}
                  onClick={() => set("tint", t.id)}
                />
              ))}
            </div>
          </div>

          <label className="field">
            <span className="field-label">Model</span>
            <span className="select full">
              <select
                value={f.modelProfileId}
                disabled={!list.length}
                aria-invalid={models.state === "error" || undefined}
                aria-describedby={
                  models.state === "error" ? "nad-model-error" : undefined
                }
                onChange={(e) => set("modelProfileId", e.target.value)}
              >
                {models.state === "loading" ? (
                  <option value="" disabled>
                    Loading models…
                  </option>
                ) : !list.length ? (
                  <option value="" disabled>
                    No models available
                  </option>
                ) : (
                  list.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))
                )}
              </select>
              <Icon name="chevron" size={14} />
            </span>
            {models.state === "error" && (
              <span id="nad-model-error" className="field-hint is-bad">
                {models.message}
              </span>
            )}
          </label>

          {error && (
            <p className="field-hint is-bad" role="alert">
              {error}
            </p>
          )}
          <div className="nad-actions">
            <span className="grow" />
            <button type="button" className="btn-soft lg" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn-solid lg" disabled={!valid}>
              {submitting ? "Creating…" : "Create agent"}
            </button>
          </div>
        </form>

        <div className="nad-stage">
          <Badge
            name={f.name}
            handle={handle}
            look={f.look}
            tint={f.tint}
            modelLabel={modelShort(selectedModel?.name || "")}
          />
          <span className="nad-stage-note" aria-live="polite">
            live preview · drag it around
          </span>
        </div>
      </div>
    </div>
  );
}
