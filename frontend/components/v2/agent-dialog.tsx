"use client";
import { useEffect, useRef, useState } from "react";
import {
  agentHandle,
  AGENT_NAME_MAX,
  AGENT_INSTRUCTIONS_MAX,
  AGENT_PURPOSE_MAX,
  DEFAULT_AGENT_LOOK,
  DEFAULT_AGENT_TINT,
  type AgentSummary,
  type AgentConfiguration,
  type AgentTint,
  type ModelOption,
} from "../../../shared/contracts";
import { ApiRequestError, userMessage } from "@/lib/api";
import {
  createAgent,
  createAgentBody,
  fetchModels,
  fetchAgentConfiguration,
  updateAgent,
  handleTaken,
  modelShort,
} from "@/lib/agents";
import { LOOKS, TINTS, tintOf } from "@/lib/agent-look";
import { Badge, Confetti, Robot } from "./agent-badge";
import { Icon } from "./icon";

// Creation and editing share the same fields and preview.

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
  editing = null,
  onClose,
  onCreated,
  onUpdated,
  onSayHi,
}: {
  open: boolean;
  agents: AgentSummary[];
  editing?: AgentSummary | null;
  onClose: () => void;
  onCreated: (a: AgentSummary) => void;
  onUpdated: (a: AgentSummary) => void;
  onSayHi: (a: AgentSummary) => void;
}) {
  const [f, setF] = useState(emptyForm),
    [models, setModels] = useState<Models>({ state: "loading" }),
    [created, setCreated] = useState<AgentSummary | null>(null),
    [submitting, setSubmitting] = useState(false),
    [error, setError] = useState(""),
    [configuration, setConfiguration] = useState<AgentConfiguration | null>(
      null,
    ),
    // A handle the server reported as taken (409) that the list didn't know.
    [serverTaken, setServerTaken] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);
  const requestEpoch = useRef(0);
  const set = <K extends keyof ReturnType<typeof emptyForm>>(
    k: K,
    v: ReturnType<typeof emptyForm>[K],
  ) => {
    setF((x) => ({ ...x, [k]: v }));
    setError("");
  };

  useEffect(() => {
    if (!open) return;
    requestEpoch.current++;
    setF(emptyForm());
    setCreated(null);
    setSubmitting(false);
    setError("");
    setServerTaken("");
    setConfiguration(null);
    setModels({ state: "loading" });
    let live = true;
    Promise.all([
      fetchModels(),
      editing ? fetchAgentConfiguration(editing.id) : Promise.resolve(null),
    ]).then(
      ([list, config]) => {
        if (!live) return;
        const safe = Array.isArray(list) ? list : [];
        setModels({ state: "ready", list: safe });
        setConfiguration(config);
        setF(
          config
            ? {
                name: config.name,
                description: config.description,
                systemPrompt: config.systemPrompt,
                look: config.look,
                tint: config.tint,
                modelProfileId: config.modelProfileId,
              }
            : { ...emptyForm(), modelProfileId: safe[0]?.id || "" },
        );
      },
      (e) => {
        if (live) setModels({ state: "error", message: userMessage(e) });
      },
    );
    return () => {
      live = false;
      requestEpoch.current++;
    };
  }, [open, editing]);
  useEffect(() => {
    if (open && models.state === "ready") nameRef.current?.focus();
  }, [open, models.state]);
  if (!open) return null;

  const handle = editing
    ? configuration?.handle || editing.handle || editing.id
    : agentHandle(f.name);
  const taken =
    !editing &&
    !!handle &&
    (handleTaken(handle, agents) || handle === serverTaken);
  const list = models.state === "ready" ? models.list : [];
  const selectedModel = list.find((m) => m.id === f.modelProfileId);
  const valid =
    !!f.name.trim() &&
    (editing || (!!f.description.trim() && !!f.systemPrompt.trim())) &&
    !!handle &&
    !taken &&
    !!selectedModel &&
    (!editing || (!!configuration && !configuration.builtin)) &&
    !submitting;

  const submit = async () => {
    if (!valid) return;
    const epoch = requestEpoch.current;
    setSubmitting(true);
    setError("");
    try {
      if (editing && configuration) {
        const a = await updateAgent(editing.id, f, configuration.version);
        if (requestEpoch.current !== epoch) return;
        onUpdated(a);
        onClose();
      } else {
        const a = await createAgent(createAgentBody(f));
        if (requestEpoch.current !== epoch) return;
        onCreated(a);
        setCreated(a);
      }
    } catch (e) {
      if (requestEpoch.current !== epoch) return;
      if (e instanceof ApiRequestError && e.code === "AGENT_HANDLE_TAKEN")
        setServerTaken(handle);
      else setError(userMessage(e));
    } finally {
      if (requestEpoch.current === epoch) setSubmitting(false);
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
      onMouseDown={() => {
        if (!submitting) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !submitting) onClose();
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
          disabled={submitting}
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
          <fieldset
            disabled={
              submitting ||
              models.state !== "ready" ||
              (!!editing && !configuration)
            }
            style={{ display: "contents" }}
          >
            <div className="nad-head">
              <h2 id="nad-title">
                {editing ? `Edit ${editing.name}` : "New agent"}
              </h2>
              <p>
                {editing
                  ? "Start a new conversation to use updated instructions and model. Your handle stays the same."
                  : "A persistent specialist with its own identity and chat. Mention it in groups by its handle."}
              </p>
            </div>
            {editing && models.state === "loading" && (
              <p role="status">Loading configuration…</p>
            )}

            <label className="field">
              <span className="field-label">
                Agent name (required)
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
                required
                maxLength={AGENT_NAME_MAX}
                placeholder="Research Scout"
                aria-invalid={taken}
                onChange={(e) => set("name", e.target.value)}
              />
            </label>
            <label className="field">
              <span className="field-label">
                {editing ? "Purpose" : "Purpose (required)"}
              </span>
              <input
                className="input"
                value={f.description}
                required={!editing}
                maxLength={AGENT_PURPOSE_MAX}
                placeholder="What this specialist owns"
                onChange={(e) => set("description", e.target.value)}
              />
            </label>
            <label className="field">
              <span className="field-label">
                {editing ? "Instructions" : "Instructions (required)"}
              </span>
              <textarea
                className="input"
                value={f.systemPrompt}
                required={!editing}
                maxLength={AGENT_INSTRUCTIONS_MAX}
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
                  {editing &&
                    models.state === "ready" &&
                    f.modelProfileId &&
                    !selectedModel && (
                      <option value={f.modelProfileId} disabled>
                        Current model unavailable — choose another
                      </option>
                    )}
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
          </fieldset>
          <div className="nad-actions">
            <span className="grow" />
            <button
              type="button"
              className="btn-soft lg"
              onClick={onClose}
              disabled={submitting}
            >
              Cancel
            </button>
            <button type="submit" className="btn-solid lg" disabled={!valid}>
              {editing
                ? submitting
                  ? "Saving…"
                  : "Save changes"
                : submitting
                  ? "Creating…"
                  : "Create agent"}
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
