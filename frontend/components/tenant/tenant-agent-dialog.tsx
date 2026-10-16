"use client";
import { useEffect, useRef, useState } from "react";
import { ApiRequestError, userMessage } from "@/lib/api";
import { LOOKS, TINTS, tintOf } from "@/lib/agent-look";
import {
  AGENT_DESCRIPTION_MAX,
  AGENT_NAME_MAX,
  createTenantAgent,
  formChanges,
  formOf,
  formProblem,
  requestIds,
  updateTenantAgent,
  type AgentForm,
  type AgentScope,
  type TenantAgent,
  type TenantModel,
} from "@/lib/tenant-agents";
import { Badge, Robot } from "@/components/v2/agent-badge";
import { Icon } from "@/components/v2/icon";

// Create or edit a personal or workspace agent. Reuses the agent dialog's
// form, look/tint pickers and badge preview (styles/v2/agent-dialog.css).
// Who can use an agent is chosen once, at creation; sharing later is the
// picker's "Share with workspace" action.

const SCOPES: { id: AgentScope; label: string; hint: string }[] = [
  { id: "personal", label: "Just me", hint: "Only you can see and use it." },
  {
    id: "tenant",
    label: "Everyone in this workspace",
    hint: "Every member can see and use it; their chats stay private. It can't be made personal again.",
  },
];

export function TenantAgentDialog({
  open,
  editing,
  models,
  modelsError,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** The agent being edited, or null to create one. */
  editing: TenantAgent | null;
  models: TenantModel[];
  modelsError?: string;
  onClose: () => void;
  onSaved: (agent: TenantAgent) => void;
}) {
  const [form, setForm] = useState<AgentForm>(() => formOf(editing, models));
  const [scope, setScope] = useState<AgentScope>("personal");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);
  const ids = useRef(requestIds());
  // Answers that arrive after the dialog closed or reopened are ignored.
  const generation = useRef(0);

  useEffect(() => {
    if (!open) return;
    generation.current++;
    setForm(formOf(editing, models));
    setScope("personal");
    setSaving(false);
    setError("");
    ids.current.reset();
    const focus = setTimeout(() => nameRef.current?.focus(), 30);
    return () => {
      generation.current++;
      clearTimeout(focus);
    };
    // Only opening or switching agents resets the form; models arriving
    // later fill in the default model below without discarding typing.
  }, [open, editing]);

  useEffect(() => {
    if (open && !editing && !form.modelId && models[0])
      setForm((f) => ({ ...f, modelId: models[0]!.id }));
  }, [open, editing, models, form.modelId]);

  if (!open) return null;

  const set = <K extends keyof AgentForm>(key: K, value: AgentForm[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setError("");
  };
  const selectedModel = models.find((m) => m.id === form.modelId);
  const changes = editing ? formChanges(editing, form) : null;
  const problem =
    formProblem(form) ?? (selectedModel ? null : "Choose an available model.");
  const canSubmit =
    !saving && !problem && (!changes || Object.keys(changes).length > 0);

  const submit = async () => {
    if (!canSubmit) return;
    const version = generation.current;
    setSaving(true);
    setError("");
    try {
      const saved = editing
        ? await updateTenantAgent(editing.id, editing.revision, changes!)
        : await createTenantAgent(form, scope, ids.current.for(form, scope));
      if (generation.current !== version) return;
      onSaved(saved);
    } catch (e) {
      if (generation.current !== version) return;
      setError(
        e instanceof ApiRequestError && e.code === "STALE_REVISION"
          ? "This agent was changed somewhere else. Close this dialog and open it again to edit the latest version."
          : userMessage(e),
      );
    } finally {
      if (generation.current === version) setSaving(false);
    }
  };

  const scopeLabel = editing
    ? editing.source === "tenant"
      ? "workspace agent"
      : "personal agent"
    : scope === "tenant"
      ? "workspace agent"
      : "personal agent";

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
        aria-labelledby="tad-title"
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
            <h2 id="tad-title">{editing ? "Edit agent" : "New agent"}</h2>
            <p>
              A specialist with its own purpose and model. Chats with it are
              always private to the person chatting.
            </p>
          </div>

          <label className="field">
            <span className="field-label">Name</span>
            <input
              ref={nameRef}
              className="input"
              value={form.name}
              required
              maxLength={AGENT_NAME_MAX}
              placeholder="Research Scout"
              onChange={(e) => set("name", e.target.value)}
            />
          </label>
          <label className="field">
            <span className="field-label">
              Purpose
              <span className="field-hint">
                {form.description.trim().length}/{AGENT_DESCRIPTION_MAX}
              </span>
            </span>
            <textarea
              className="input"
              value={form.description}
              required
              rows={2}
              maxLength={AGENT_DESCRIPTION_MAX}
              placeholder="What this specialist owns"
              onChange={(e) => set("description", e.target.value)}
            />
          </label>

          {!editing && (
            <fieldset className="field tad-scope">
              <legend className="field-label">Who can use it</legend>
              {SCOPES.map((s) => (
                <label
                  key={s.id}
                  className={
                    "tad-scope-option" + (scope === s.id ? " is-active" : "")
                  }
                >
                  <input
                    type="radio"
                    name="tad-scope"
                    value={s.id}
                    checked={scope === s.id}
                    onChange={() => {
                      setScope(s.id);
                      setError("");
                    }}
                  />
                  <span>
                    <span className="strong block">{s.label}</span>
                    <span className="muted sm">{s.hint}</span>
                  </span>
                </label>
              ))}
            </fieldset>
          )}

          <div className="field">
            <span className="field-label" id="tad-look">
              Look
            </span>
            <div
              className="look-grid"
              role="radiogroup"
              aria-labelledby="tad-look"
            >
              {LOOKS.map((l, i) => (
                <button
                  key={l.name}
                  type="button"
                  role="radio"
                  aria-checked={form.look === i}
                  aria-label={l.name}
                  title={l.name}
                  className={"look" + (form.look === i ? " is-active" : "")}
                  style={{ background: tintOf(form.tint).bg }}
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
                  aria-checked={form.tint === t.id}
                  aria-label={t.label}
                  title={t.label}
                  className={"tint" + (form.tint === t.id ? " is-active" : "")}
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
                value={form.modelId}
                disabled={!models.length}
                aria-invalid={!!modelsError || undefined}
                aria-describedby={modelsError ? "tad-model-error" : undefined}
                onChange={(e) => set("modelId", e.target.value)}
              >
                {!models.length ? (
                  <option value="">
                    {modelsError ? "Models unavailable" : "No models available"}
                  </option>
                ) : (
                  <>
                    {!selectedModel && (
                      <option value={form.modelId} disabled>
                        Current model unavailable — choose another
                      </option>
                    )}
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.displayName}
                      </option>
                    ))}
                  </>
                )}
              </select>
              <Icon name="chevron" size={14} />
            </span>
            {modelsError ? (
              <span id="tad-model-error" className="field-hint is-bad">
                {modelsError}
              </span>
            ) : (
              models.length > 0 &&
              !selectedModel && (
                <span className="field-hint is-bad">
                  Its model is no longer available. Choose another to save.
                </span>
              )
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
            <button
              type="submit"
              className="btn-solid lg"
              disabled={!canSubmit}
            >
              {editing
                ? saving
                  ? "Saving…"
                  : "Save changes"
                : saving
                  ? "Creating…"
                  : "Create agent"}
            </button>
          </div>
        </form>

        <div className="nad-stage">
          <Badge
            name={form.name}
            handle=""
            subtitle={scopeLabel}
            look={form.look}
            tint={form.tint}
            modelLabel={selectedModel?.shortLabel ?? ""}
          />
          <span className="nad-stage-note" aria-live="polite">
            live preview · drag it around
          </span>
        </div>
      </div>
    </div>
  );
}
