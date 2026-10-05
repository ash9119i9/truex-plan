import type { SubAgent } from "../../shared/contracts";
import {
  isRunning,
  isTerminal,
  upsertAgent,
  type SubAgentState,
} from "./subagents.ts";

// Stop admission changes only the selected helper; its runtime status remains
// running until an authoritative completion arrives.
export function markHelperStop(
  state: SubAgentState,
  threadId: string,
  stopStatus: "pending" | "unconfirmed",
): SubAgentState {
  const agent = state.agents.find((a) => a.threadId === threadId);
  if (!agent || !isRunning(agent)) return state;
  return {
    ...state,
    agents: state.agents.map((a) => (a === agent ? { ...a, stopStatus } : a)),
  };
}

export function confirmHelperStop(
  state: SubAgentState,
  threadId: string,
  result: { ok?: unknown; agent?: SubAgent },
): SubAgentState | null {
  if (
    result?.ok !== true ||
    result.agent?.threadId !== threadId ||
    !isTerminal(result.agent.status) ||
    result.agent.stopStatus !== undefined
  )
    return null;
  // Natural completion may have won the race while Stop was in flight.
  const agent = state.agents.find((a) => a.threadId === threadId);
  if (!agent || !isRunning(agent)) return state;
  return { ...state, agents: upsertAgent(state.agents, result.agent) };
}
