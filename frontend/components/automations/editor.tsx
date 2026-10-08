"use client";
import { useId, useState } from "react";
import type { AgentSummary, Project } from "../../../shared/contracts";
import type { AutomationRecipe } from "../../../shared/automations";
import {
  defaultAutomationFields,
  fieldsFromRecipe,
  formatAutomationTime,
  previewAutomation,
  recipeFromFields,
  type AutomationFields,
} from "@/lib/automations";
import { userMessage } from "@/lib/api";
import { AutomationRecurrenceFields } from "./recurrence-fields";

export function AutomationEditor({
  recipe,
  agents,
  projects,
  onSave,
  onClose,
}: {
  recipe?: AutomationRecipe;
  agents: AgentSummary[];
  projects: Project[];
  onSave: (recipe: AutomationRecipe) => Promise<void>;
  onClose: () => void;
}) {
  const id = useId();
  const [fields, setFields] = useState<AutomationFields>(() =>
    recipe
      ? fieldsFromRecipe(recipe)
      : defaultAutomationFields(
          agents.find((a) => a.canUse !== false)?.id,
          Intl.DateTimeFormat().resolvedOptions().timeZone,
        ),
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [times, setTimes] = useState<string[]>([]);
  function change<K extends keyof AutomationFields>(
    key: K,
    value: AutomationFields[K],
  ) {
    setFields((previous) => ({ ...previous, [key]: value }));
    setTimes([]);
    setError("");
  }
  async function submit(preview: boolean) {
    setError("");
    let reviewed: AutomationRecipe;
    try {
      reviewed = recipeFromFields(fields);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Check the recipe fields.");
      return;
    }
    setBusy(true);
    try {
      if (preview) setTimes((await previewAutomation(reviewed.trigger)).times);
      else await onSave(reviewed);
    } catch (e) {
      setError(userMessage(e, "Unable to save the automation."));
    } finally {
      setBusy(false);
    }
  }
  const fieldId = (field: string) => `${id}-${field}`;
  return (
    <section className="automation-panel" aria-labelledby={fieldId("heading")}>
      <div className="automation-heading">
        <h2 id={fieldId("heading")}>
          {recipe ? "Edit automation" : "New automation"}
        </h2>
        <button className="automation-button" disabled={busy} onClick={onClose}>
          Cancel
        </button>
      </div>
      <p className="automation-muted">
        Save a draft, then review and explicitly enable the recipe. Each run
        starts a fresh conversation.
      </p>
      <form
        className="automation-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(false);
        }}
      >
        <fieldset className="automation-fields" disabled={busy}>
          <label htmlFor={fieldId("name")}>
            Name
            <input
              id={fieldId("name")}
              value={fields.name}
              maxLength={120}
              required
              onChange={(e) => change("name", e.target.value)}
              autoFocus
            />
          </label>
          <div className="automation-grid">
            <label htmlFor={fieldId("agent")}>
              Agent
              <select
                id={fieldId("agent")}
                value={fields.agentId}
                required
                onChange={(e) => change("agentId", e.target.value)}
              >
                <option value="">Choose an agent</option>
                {agents
                  .filter((a) => a.canUse !== false || a.id === fields.agentId)
                  .map((a) => (
                    <option
                      key={a.id}
                      value={a.id}
                      disabled={a.canUse === false}
                    >
                      {a.name}
                      {a.canUse === false ? " — access unavailable" : ""}
                    </option>
                  ))}
              </select>
            </label>
            <label htmlFor={fieldId("project")}>
              Project (optional)
              <select
                id={fieldId("project")}
                value={fields.projectId}
                onChange={(e) => change("projectId", e.target.value)}
              >
                <option value="">No project</option>
                {projects.map((p) => (
                  <option key={p._id} value={p._id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label htmlFor={fieldId("prompt")}>
            Execution prompt
            <textarea
              id={fieldId("prompt")}
              value={fields.prompt}
              required
              rows={5}
              maxLength={100000}
              onChange={(e) => change("prompt", e.target.value)}
              placeholder="Describe the task, permitted actions and expected result."
            />
          </label>
          <AutomationRecurrenceFields id={id} fields={fields} change={change} />
          <div className="automation-grid">
            <label htmlFor={fieldId("deadline")}>
              Maximum run time (minutes)
              <input
                id={fieldId("deadline")}
                type="number"
                min="1"
                max="30"
                step="1"
                value={fields.executionMinutes}
                required
                onChange={(e) => change("executionMinutes", e.target.value)}
              />
            </label>
            <label htmlFor={fieldId("grace")}>
              Lateness grace (minutes)
              <input
                id={fieldId("grace")}
                type="number"
                min="0"
                max="10"
                step="1"
                value={fields.latenessMinutes}
                required
                onChange={(e) => change("latenessMinutes", e.target.value)}
              />
            </label>
          </div>
          <p className="automation-muted">
            Approval, required input or a missing dependency fails that run. The
            schedule stays enabled. Unconfirmed execution blocks overlapping
            work.
          </p>
          {error && (
            <p role="alert" className="automation-error">
              {error}
            </p>
          )}
          {times.length > 0 && (
            <div role="status">
              <h3>Next five executions</h3>
              <ol className="automation-preview">
                {times.map((time) => (
                  <li key={time}>
                    {formatAutomationTime(time, fields.timeZone)}
                  </li>
                ))}
              </ol>
              {fields.triggerKind === "calendar" && (
                <p className="automation-muted">
                  Daylight saving: nonexistent times are skipped; repeated local
                  times may run twice.
                </p>
              )}
            </div>
          )}
          <div className="automation-actions">
            <button
              type="button"
              className="automation-button"
              disabled={busy}
              onClick={() => void submit(true)}
            >
              {busy ? "Working…" : "Preview next five"}
            </button>
            <button
              className="automation-button primary"
              type="submit"
              disabled={busy}
            >
              {busy ? "Working…" : "Save draft"}
            </button>
          </div>
        </fieldset>
      </form>
    </section>
  );
}
