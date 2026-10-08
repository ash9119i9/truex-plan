"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentSummary, Project } from "../../../shared/contracts";
import type { AutomationRecipe } from "../../../shared/automations";
import { userMessage } from "@/lib/api";
import {
  controlAutomation,
  createAutomation,
  editAutomation,
  listAutomations,
  runAutomation,
  type AutomationView,
} from "@/lib/automations";
import { AutomationEditor } from "./editor";
import { AutomationList } from "./list";
import { AutomationRecipeSummary } from "./recipe";
import { AutomationRunHistory } from "./run-history";
import { AutomationRunDetails } from "./run-details";

export function AutomationsView({
  agents,
  projects,
  onSession,
}: {
  agents: AgentSummary[];
  projects: Project[];
  onSession: (sessionId: string) => void;
}) {
  const [items, setItems] = useState<AutomationView[]>([]);
  const [available, setAvailable] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [editing, setEditing] = useState<"new" | "edit" | null>(null);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [historyVersion, setHistoryVersion] = useState(0);
  const pendingKeys = useRef(new Map<string, string>());
  const selectedIdRef = useRef<string | null>(null);
  const changed = useCallback(() => setRefresh((version) => version + 1), []);
  const selected = items.find((item) => item.id === selectedId);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const result = await listAutomations();
        if (!live) return;
        setItems(result.items);
        setAvailable(result.available);
        setLoadError("");
        setHistoryVersion((version) => version + 1);
      } catch (e) {
        if (live) setLoadError(userMessage(e));
      } finally {
        if (live) {
          setLoading(false);
          timer = setTimeout(() => void load(), 10000);
        }
      }
    }
    void load();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [refresh]);
  async function save(recipe: AutomationRecipe) {
    const result =
      editing === "edit" && selected
        ? await editAutomation(selected.id, selected.controlVersion, recipe)
        : await createAutomation(recipe);
    setItems((old) => [result, ...old.filter((item) => item.id !== result.id)]);
    setSelectedId(result.id);
    selectedIdRef.current = result.id;
    setEditing(null);
    setRunId(null);
    changed();
  }
  async function control(action: "enable" | "pause" | "resume" | "archive") {
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      const updated = await controlAutomation(
        selected.id,
        selected.controlVersion,
        action,
      );
      setItems((old) =>
        old.map((item) => (item.id === updated.id ? updated : item)),
      );
      changed();
    } catch (e) {
      setError(userMessage(e));
      changed();
    } finally {
      setBusy(false);
    }
  }
  async function run(retryOfRunId?: string) {
    if (!selected) return;
    const operation = `${selected.id}:${selected.revision}:${retryOfRunId ?? "manual"}`;
    const key = pendingKeys.current.get(operation) ?? crypto.randomUUID();
    pendingKeys.current.set(operation, key);
    setBusy(true);
    setError("");
    try {
      const accepted = await runAutomation(
        selected.id,
        key,
        selected.revision,
        retryOfRunId,
      );
      pendingKeys.current.delete(operation);
      if (selectedIdRef.current === selected.id) setRunId(accepted.id);
      changed();
    } catch (e) {
      // Retain identity after an ambiguous receipt; retrying this action recovers the same run.
      setError(userMessage(e));
      changed();
      throw e;
    } finally {
      setBusy(false);
    }
  }
  if (!available)
    return (
      <section className="automations-root">
        <h1>Automations</h1>
        <p role="status">Automations are not enabled in this workspace.</p>
      </section>
    );
  return (
    <section className="automations-root" aria-labelledby="automations-title">
      <header className="automations-header">
        <div>
          <p className="automation-eyebrow">Work on your schedule</p>
          <h1 id="automations-title">Automations</h1>
          <p className="automation-muted">
            Reviewed recipes run while you’re away. Every occurrence keeps its
            own result and audit.
          </p>
        </div>
        <button
          className="automation-button primary"
          disabled={busy || editing !== null}
          onClick={() => {
            setEditing("new");
            setRunId(null);
          }}
        >
          New automation
        </button>
      </header>
      {(error || loadError) && (
        <div role="alert" className="automation-error">
          {error || loadError}
          <button className="automation-button" onClick={changed}>
            Refresh automations
          </button>
        </div>
      )}
      {editing === "new" ? (
        <AutomationEditor
          agents={agents}
          projects={projects}
          onSave={save}
          onClose={() => setEditing(null)}
        />
      ) : (
        <div className="automations-layout">
          <AutomationList
            items={items}
            selectedId={selectedId}
            loading={loading}
            onSelect={(id) => {
              selectedIdRef.current = id;
              setSelectedId(id);
              setRunId(null);
              setEditing(null);
            }}
          />
          <div className="automation-detail">
            {selected ? (
              editing === "edit" ? (
                <AutomationEditor
                  key={`${selected.id}:${selected.revision}`}
                  recipe={selected.recipe}
                  agents={agents}
                  projects={projects}
                  onSave={save}
                  onClose={() => setEditing(null)}
                />
              ) : (
                <>
                  <AutomationRecipeSummary
                    key={`${selected.id}:${selected.revision}`}
                    automation={selected}
                    agentName={
                      agents.find(
                        (agent) => agent.id === selected.recipe.agentId,
                      )?.name
                    }
                    projectName={
                      projects.find(
                        (project) => project._id === selected.recipe.projectId,
                      )?.name
                    }
                    busy={busy}
                    onControl={(action) => void control(action)}
                    onRun={() => {
                      void run().catch(() => {});
                    }}
                    onEdit={() => {
                      setEditing("edit");
                      setRunId(null);
                    }}
                  />
                  {runId && (
                    <AutomationRunDetails
                      key={`${selected.id}:${runId}`}
                      automation={selected}
                      runId={runId}
                      onClose={() => setRunId(null)}
                      onRetry={run}
                      onChanged={changed}
                      onSession={onSession}
                    />
                  )}
                  <AutomationRunHistory
                    key={selected.id}
                    automationId={selected.id}
                    timeZone={selected.recipe.trigger.timeZone}
                    refresh={historyVersion + refresh}
                    onOpen={setRunId}
                  />
                </>
              )
            ) : (
              <div className="automation-empty">
                <h2>Select an automation</h2>
                <p>
                  Review its schedule, recipe, run history and repair actions
                  here.
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
