"use client";
import { useCallback, useEffect, useState } from "react";
import { userMessage } from "@/lib/api";
import { tintOf } from "@/lib/agent-look";
import {
  defaultAgent,
  fetchTenantAgents,
  fetchTenantModels,
  withAgent,
  type TenantAgent,
  type TenantModel,
} from "@/lib/tenant-agents";
import { Hero } from "@/components/v2/hero";
import { AgentPicker } from "./agent-picker";
import { TenantAgentDialog } from "./tenant-agent-dialog";

type Load =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready" };

// The tenant chat page before a chat starts: pick, create or manage the agent
// the chat will use. Starting the chat itself arrives with the chat slice.
export function TenantChatHome() {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [agents, setAgents] = useState<TenantAgent[]>([]);
  const [models, setModels] = useState<TenantModel[]>([]);
  const [modelsError, setModelsError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ editing: TenantAgent | null } | null>(
    null,
  );
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setLoad({ state: "loading" });
    void Promise.allSettled([fetchTenantAgents(), fetchTenantModels()]).then(
      ([agentsResult, modelsResult]) => {
        if (!live) return;
        if (modelsResult.status === "fulfilled") {
          setModels(modelsResult.value);
          setModelsError("");
        } else
          setModelsError(
            userMessage(
              modelsResult.reason,
              "Models could not be loaded. Close this dialog and try again.",
            ),
          );
        if (agentsResult.status === "rejected") {
          setLoad({
            state: "error",
            message: userMessage(
              agentsResult.reason,
              "Agents could not be loaded. Try again.",
            ),
          });
          return;
        }
        setAgents(agentsResult.value);
        setLoad({ state: "ready" });
      },
    );
    return () => {
      live = false;
    };
  }, [attempt]);

  const changed = useCallback((agent: TenantAgent) => {
    setAgents((list) => withAgent(list, agent));
  }, []);

  // The selection always names an agent a chat could start with.
  useEffect(() => {
    setSelectedId((current) =>
      agents.some((a) => a.id === current && a.available)
        ? current
        : (defaultAgent(agents)?.id ?? null),
    );
  }, [agents]);

  // Opening the dialog after models failed to load asks for them again.
  const openDialog = (editing: TenantAgent | null) => {
    setDialog({ editing });
    if (!modelsError) return;
    fetchTenantModels().then(
      (list) => {
        setModels(list);
        setModelsError("");
      },
      () => undefined,
    );
  };

  const selected = agents.find((a) => a.id === selectedId) ?? null;

  return (
    <section className="workspace-empty" aria-label="Chat">
      <Hero agentHue={selected ? tintOf(selected.tint).dot : undefined}>
        <p className="workspace-empty-note" role="status">
          {selected
            ? `New chats will use ${selected.name}. Chat will be available here soon.`
            : "Choose an agent to chat with. Chat will be available here soon."}
        </p>
        {load.state === "loading" && (
          <p className="workspace-empty-note" aria-busy="true">
            Loading agents…
          </p>
        )}
        {load.state === "error" && (
          <div className="workspace-empty-note" role="alert">
            <p>{load.message}</p>
            <button
              type="button"
              className="btn-soft"
              onClick={() => setAttempt((n) => n + 1)}
            >
              Try again
            </button>
          </div>
        )}
        {load.state === "ready" && (
          <AgentPicker
            agents={agents}
            selectedId={selectedId}
            onSelect={(agent) => setSelectedId(agent.id)}
            onNew={() => openDialog(null)}
            onEdit={(agent) => openDialog(agent)}
            onChanged={changed}
          />
        )}
      </Hero>
      <TenantAgentDialog
        open={dialog !== null}
        editing={dialog?.editing ?? null}
        models={models}
        modelsError={modelsError}
        onClose={() => setDialog(null)}
        onSaved={(agent) => {
          changed(agent);
          if (!dialog?.editing && agent.available) setSelectedId(agent.id);
          setDialog(null);
        }}
      />
    </section>
  );
}
