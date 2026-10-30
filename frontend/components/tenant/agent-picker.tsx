"use client";
import { useRef, useState } from "react";
import type { TenantAgent } from "@/lib/tenant-agents";
import { AgentAvatar } from "./agent-avatar";
import { Icon } from "@/components/tx/icon";
import { Menu, type MenuEntry } from "@/components/tx/menu";
import { classes } from "@/components/tx/classes";

type PickAgent = Pick<TenantAgent, "id" | "name" | "description" | "available"> &
  Partial<Pick<TenantAgent, "look" | "tint">>;

// The menu behind the picker chip (DESIGN-SPEC 11.6): one radio row per agent
// that can start a chat, then New agent and Browse all agents.
export function agentMenu(
  agents: readonly PickAgent[],
  selectedId: string | null,
): MenuEntry[] {
  return [
    ...agents
      .filter((agent) => agent.available)
      .map((agent) => ({
        id: `agent:${agent.id}`,
        label: agent.name,
        detail: agent.description,
        checked: agent.id === selectedId,
        lead: (
          <AgentAvatar name={agent.name} look={agent.look} tint={agent.tint} />
        ),
      })),
    "separator",
    { id: "new", label: "New agent", icon: "plus" },
    { id: "browse", label: "Browse all agents", icon: "list" },
  ];
}

// The dock's Agent menu: a few agents to start a chat with, then Browse all
// agents and Create agent. The selected agent is always among the few.
export const DOCK_AGENTS = 5;
export function dockAgentMenu(
  agents: readonly PickAgent[],
  selectedId: string | null,
): MenuEntry[] {
  const rows = agentMenu(agents, selectedId).filter(
    (entry): entry is Exclude<MenuEntry, "separator"> =>
      entry !== "separator" && entry.id.startsWith("agent:"),
  );
  const shown = rows.slice(0, DOCK_AGENTS);
  const selected = rows.find((row) => row.checked);
  if (selected && !shown.includes(selected))
    shown[shown.length - 1] = selected;
  return [
    ...shown,
    ...(shown.length ? (["separator"] as const) : []),
    { id: "browse", label: "Browse all agents", icon: "list" },
    { id: "new", label: "Create agent", icon: "plus" },
  ];
}

// Room the menu needs below the chip before it flips up (17rem menu, 6 rows).
const MENU_ROOM = 320;

// The hero composer's agent chip (DESIGN-SPEC 11.6).
export function AgentPick({
  agents,
  selectedId,
  onSelect,
  onNew,
  onBrowse,
}: {
  agents: PickAgent[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onBrowse: () => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [up, setUp] = useState(false);
  const selected = agents.find((agent) => agent.id === selectedId) ?? null;
  // The menu opens downward unless the chip sits too close to the bottom.
  const measure = () => {
    const box = wrap.current?.getBoundingClientRect();
    if (box) setUp(window.innerHeight - box.bottom < MENU_ROOM);
  };
  return (
    <div
      className="cs-agent"
      ref={wrap}
      onPointerDownCapture={measure}
      onKeyDownCapture={measure}
    >
      <Menu
        label="Agents"
        heading="Agents"
        items={agentMenu(agents, selectedId)}
        panelClassName={classes("cs-agent-menu", up && "is-up")}
        onSelect={(id) => {
          if (id === "new") onNew();
          else if (id === "browse") onBrowse();
          else onSelect(id.slice("agent:".length));
        }}
        trigger={({ ref, ...props }) => (
          <button
            ref={ref}
            type="button"
            className="tx-chip cs-agent-pick"
            aria-label={
              selected
                ? `Agent: ${selected.name}. Change agent`
                : "Choose an agent"
            }
            {...props}
          >
            <AgentAvatar
              name={selected?.name}
              look={selected?.look}
              tint={selected?.tint}
            />
            <span>{selected?.name ?? "Choose an agent"}</span>
            <Icon name="chev-down" size="sm" className="cs-agent-chev" />
          </button>
        )}
      />
    </div>
  );
}
