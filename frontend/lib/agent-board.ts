// Agent team board (agent-team-list-v2-spec.md §2, §4, §10): pure helpers so
// node tests can import them.
import type { AgentSummary } from "../../shared/contracts";
import { modelShort } from "./agents.ts";

/** Card tilts in degrees, cycled by index. */
export const TILTS = [-4, 3, -2.5, 4.5, -3.5, 2, -1.5, 3.5];

export const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Caption ink on a frame colour: white on dark tints, graphite otherwise.
 *  Channels are linearised (WCAG relative luminance): with raw sRGB channels the
 *  ice frame #3691CD scores .51 and would get graphite, contradicting spec §2/§8. */
export const inkOn = (hex: string): "#FFFFFF" | "#1F2A30" => {
  const n = parseInt(hex.slice(1), 16);
  const c = (s: number) => {
    const v = ((n >> s) & 255) / 255;
    return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
  };
  return .2126 * c(16) + .7152 * c(8) + .0722 * c(0) < .45 ? "#FFFFFF" : "#1F2A30";
};

export type BoardKind = "all" | "yours" | "builtin";
export const BOARD_KINDS = [["all", "All"], ["yours", "Yours"], ["builtin", "Built-in"]] as const;

type Filterable = Pick<AgentSummary, "id" | "name" | "description" | "builtin" | "handle">;

export function filterAgents<T extends Filterable>(agents: T[], kind: BoardKind, q: string): T[] {
  const needle = q.trim().toLowerCase();
  return agents.filter((a) => (kind === "all" || (kind === "builtin") === !!a.builtin)
    && `${a.name} ${a.handle || a.id} ${a.description}`.toLowerCase().includes(needle));
}

/** The new-agent card shows unless the Built-in filter or a search is active. */
export const showNewCard = (kind: BoardKind, q: string): boolean => kind !== "builtin" && !q.trim();

/** Card meta line: "opus 5.5 · high", "default" reasoning when unset. */
export const boardMeta = (model: string, reasoning?: string): string =>
  `${modelShort(model)} · ${(reasoning || "Default").toLowerCase()}`;
