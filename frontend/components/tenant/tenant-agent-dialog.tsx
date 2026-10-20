"use client";
import { useEffect, useRef, useState, type MouseEvent } from "react";
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
import {
  fetchConnectors,
  isNotConfigured,
  MAX_CONNECTORS,
  tokenEstimateHint,
  type Connector,
  type ConnectorAccess,
} from "@/lib/tenant-connectors";
import { warnFailure } from "@/lib/api";
// Connect card, tool rows, connector banner and picker styles.
import "@/styles/v2/connectors.css";

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
  // The connector catalog for the picker. null while loading or when the
  // feature is off / the fetch failed — in which case the section is hidden
  // (existing selections on an edited agent are left untouched either way).
  const [connectors, setConnectors] = useState<Connector[] | null>(null);
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

  // The connector picker's catalog. A failure or a feature-off result hides
  // the section silently (connectors stays null); existing selections on an
  // edited agent are kept regardless, since the picker only reads them.
  useEffect(() => {
    if (!open) return;
    let live = true;
    setConnectors(null);
    fetchConnectors().then(
      (result) => {
        if (!live) return;
        setConnectors(result.kind === "list" ? result.connectors : null);
      },
      (error) => {
        if (!live) return;
        setConnectors(null);
        if (!isNotConfigured(error)) warnFailure("connectors catalog", error);
      },
    );
    return () => {
      live = false;
    };
  }, [open, editing]);

  if (!open) return null;

  const set = <K extends keyof AgentForm>(key: K, value: AgentForm[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setError("");
  };

  // Toggles a connector in the form, preserving selection order; a new slug
  // is appended (so the order stays stable) and the cap is enforced here too.
  const toggleConnector = (slug: string) => {
    setForm((f) => {
      const has = f.connectorSlugs.includes(slug);
      const next = has
        ? f.connectorSlugs.filter((s) => s !== slug)
        : f.connectorSlugs.length >= MAX_CONNECTORS
          ? f.connectorSlugs
          : [...f.connectorSlugs, slug];
      return { ...f, connectorSlugs: next };
    });
    setError("");
  };
  // Sets a connector's access (only offered when it has write tools). The
  // form keeps a read_only flag; cleanForm prunes it if the connector is
  // later removed.
  const setConnectorAccess = (slug: string, access: ConnectorAccess) => {
    setForm((f) => ({
      ...f,
      connectorAccess: { ...f.connectorAccess, [slug]: access },
    }));
    setError("");
  };
  const atConnectorCap = form.connectorSlugs.length >= MAX_CONNECTORS;
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

          {connectors && connectors.length > 0 && (
            <fieldset className="field">
              <legend className="field-label">Connected tools</legend>
              <p className="muted sm">
                Let this agent use a tool&apos;s data. Tools that change data
                ask for your approval each time. Up to {MAX_CONNECTORS}.
              </p>
              <div className="connector-picker">
                {connectors.map((c) => {
                  const checked = form.connectorSlugs.includes(c.slug);
                  const disabled = !checked && atConnectorCap;
                  const hint = tokenEstimateHint(c.toolTokenEstimate);
                  const notConnected = c.connection.status !== "active";
                  return (
                    <label
                      key={c.slug}
                      className={[
                        "connector-pick",
                        checked && "is-checked",
                        disabled && "is-disabled",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={disabled}
                        onChange={() => toggleConnector(c.slug)}
                      />
                      <span className="connector-pick-text">
                        <span className="strong block">{c.displayName}</span>
                        {c.description && (
                          <span className="muted sm block">
                            {c.description}
                          </span>
                        )}
                        {hint && (
                          <span className="connector-pick-hint">{hint}</span>
                        )}
                        {checked && notConnected && (
                          <span className="connector-pick-hint">
                            Not connected yet — you can connect from Connected
                            tools.
                          </span>
                        )}
                        {checked && c.writeTools.length > 0 && (
                          <ConnectorAccessChoice
                            slug={c.slug}
                            displayName={c.displayName}
                            access={
                              form.connectorAccess[c.slug] ?? "read_write"
                            }
                            onChange={setConnectorAccess}
                          />
                        )}
                      </span>
                    </label>
                  );
                })}
              </div>
              {atConnectorCap && (
                <p className="connector-pick-hint">
                  You&apos;ve reached the limit of {MAX_CONNECTORS}. Remove one
                  to choose another.
                </p>
              )}
            </fieldset>
          )}

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

// The read/write access choice for one attached connector, shown only when it
// has write tools. Read and write (the default) lets its write tools run,
// each guarded by a per-call approval in the chat; Read only strips them.
// Rendered as buttons (not radios) inside the connector's label so a click
// sets access without toggling the connector's own checkbox.
function ConnectorAccessChoice({
  slug,
  displayName,
  access,
  onChange,
}: {
  slug: string;
  displayName: string;
  access: ConnectorAccess;
  onChange: (slug: string, access: ConnectorAccess) => void;
}) {
  const options: { value: ConnectorAccess; label: string }[] = [
    { value: "read_write", label: "Read and write" },
    { value: "read_only", label: "Read only" },
  ];
  const pick = (e: MouseEvent<HTMLButtonElement>, value: ConnectorAccess) => {
    // The choice sits inside the connector's <label>; stop the click from
    // toggling that checkbox.
    e.preventDefault();
    e.stopPropagation();
    onChange(slug, value);
  };
  return (
    <span
      className="connector-access"
      role="group"
      aria-label={`${displayName} access`}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={
            "connector-access-opt" + (access === o.value ? " is-active" : "")
          }
          aria-pressed={access === o.value}
          onClick={(e) => pick(e, o.value)}
        >
          {o.label}
        </button>
      ))}
    </span>
  );
}
