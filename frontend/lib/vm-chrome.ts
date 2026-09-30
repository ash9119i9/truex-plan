// Session chrome view models (convo-v2-wireframe-r2.html §3 "Session chrome").
// Pure functions: components render these, never the raw contracts.
import type { Goal, GoalReview, Session } from "../../shared/contracts";
import { awaitingReview, formatTokens, goalAccepted, goalStateLabel } from "./goal.ts";

/* ---------------- status pill ---------------- */

export type TurnState =
  | "idle"
  | "starting"
  | "running"
  | "interrupting"
  | "waiting"
  | "ended";

export type PillInput = {
  /** Turn in flight (the page's `running`). */
  running: boolean;
  /** Sent, but no event from the turn yet. */
  starting?: boolean;
  /** Stop was pressed and the turn hasn't settled. */
  stopping?: boolean;
  /** Open approvals / questions (PendingRequest[] length). */
  pendingCount?: number;
  sessionStatus?: Session["status"];
  /** ms epoch the running turn started; drives the Working timer. */
  startedAt?: number | null;
  now?: number;
  /** Any MCP server in needs-auth or failed. */
  toolIssue?: boolean;
};

export type PillVM = {
  state: TurnState;
  /** "ch-pill" modifier: s-idle | s-run | s-stop | s-wait | "" (starting). */
  tone: "" | "s-idle" | "s-run" | "s-stop" | "s-wait";
  label: string;
  /** Glyph before the label. */
  glyph: "pulse" | "pulse-idle" | "pulse-warn" | "spinner" | "square" | "user";
  /** "0:42" while running, else null. */
  time: string | null;
  flag: boolean;
};

/** m:ss, or h:mm:ss past an hour. Negative or missing → 0:00. */
export function formatElapsed(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

export function turnState(i: PillInput): TurnState {
  if (i.sessionStatus === "dead") return "ended";
  if (i.stopping) return "interrupting";
  if ((i.pendingCount ?? 0) > 0) return "waiting";
  if (i.starting) return "starting";
  if (i.running) return "running";
  return "idle";
}

export function statusPill(i: PillInput): PillVM {
  const state = turnState(i);
  const flag = !!i.toolIssue;
  const base = { state, flag, time: null as string | null };
  switch (state) {
    case "ended":
      return { ...base, tone: "s-idle", label: "Ended", glyph: "pulse-idle" };
    case "interrupting":
      return { ...base, tone: "s-stop", label: "Stopping…", glyph: "square" };
    case "waiting":
      return { ...base, tone: "s-wait", label: "Waiting on you", glyph: "user" };
    case "starting":
      return { ...base, tone: "", label: "Starting…", glyph: "spinner" };
    case "running":
      return {
        ...base,
        tone: "s-run",
        label: "Working",
        glyph: "pulse",
        time:
          i.startedAt != null
            ? formatElapsed((i.now ?? Date.now()) - i.startedAt)
            : null,
      };
    default:
      // Orphaned sessions keep "Idle" but the dot turns amber (Board C).
      return {
        ...base,
        tone: "s-idle",
        label: "Idle",
        glyph: i.sessionStatus === "orphaned" ? "pulse-warn" : "pulse-idle",
      };
  }
}

/** Screen-reader label for the pill button, e.g. "Qlik Analyst, working, one tool needs attention". */
export function pillAriaLabel(agentName: string, pill: PillVM, issues = 0) {
  const parts = [agentName, pill.label.replace("…", "").toLowerCase()];
  if (pill.flag)
    parts.push(
      issues === 1 ? "one tool needs attention" : `${issues || "some"} tools need attention`,
    );
  return parts.join(", ");
}

/* ---------------- crumb ---------------- */

export type CrumbVM = { project: string | null; title: string; archived: boolean };

/** Project folder name, then the title. Falls back to "New conversation". */
export function crumb(input: {
  title?: string | null;
  projectName?: string | null;
  archived?: boolean;
}): CrumbVM {
  return {
    project: input.projectName?.trim() || null,
    title: input.title?.trim() || "New conversation",
    archived: !!input.archived,
  };
}

/* ---------------- connected tools (mcp.status) ---------------- */

export type McpStartupState = "starting" | "ready" | "failed" | "cancelled";

/** One server as the page knows it: the agent's profile plus the latest mcp.status. */
export type McpServerInput = {
  id: string;
  name: string;
  /** Profile disabled / missing in the tenant. */
  enabled?: boolean;
  status?: McpStartupState | null;
  failureReason?: "reauthenticationRequired" | null;
  toolCount?: number | null;
};

export type CartState = "ready" | "auth" | "failed" | "starting";

export type CartVM = {
  id: string;
  name: string;
  state: CartState;
  /** "12 tools" | "Needs auth" | "Failed" | "Starting…" */
  sub: string;
  /** Masking tape text; only for servers that need attention. */
  tape: "sign in" | "failed" | null;
  led: "" | "warn" | "bad";
  /** Label tone class, cycling through the wireframe's cartridge tones. */
  tone: "tone-1" | "tone-main" | "tone-0" | "tone-2";
  /** Glyph for the cartridge label. */
  glyph: "chart" | "term" | "file" | "list" | "plug";
};

export type ToolsVM = {
  carts: CartVM[];
  ready: number;
  total: number;
  /** "2 of 4 ready" */
  count: string;
  attention: number;
  /** "2 tools need attention" | "1 tool needs attention" | null */
  footer: string | null;
};

const TONES: CartVM["tone"][] = ["tone-1", "tone-main", "tone-0", "tone-2"];

function glyphFor(name: string): CartVM["glyph"] {
  const n = name.toLowerCase();
  if (/qlik|chart|analytic|bi\b/.test(n)) return "chart";
  if (/git|term|shell|code/.test(n)) return "term";
  if (/drive|doc|file|sharepoint|notion/.test(n)) return "file";
  if (/jira|linear|task|issue|asana/.test(n)) return "list";
  return "plug";
}

export function cartState(s: McpServerInput): CartState {
  if (s.failureReason === "reauthenticationRequired") return "auth";
  if (s.enabled === false || s.status === "failed" || s.status === "cancelled")
    return "failed";
  if (s.status === "starting") return "starting";
  return "ready";
}

export function connectedTools(servers: McpServerInput[]): ToolsVM {
  const carts = servers.map((s, i): CartVM => {
    const state = cartState(s);
    const tools = s.toolCount ?? null;
    return {
      id: s.id,
      name: s.name,
      state,
      sub:
        state === "auth"
          ? "Needs auth"
          : state === "failed"
            ? "Failed"
            : state === "starting"
              ? "Starting…"
              : tools != null
                ? `${tools} ${tools === 1 ? "tool" : "tools"}`
                : "Connected",
      tape: state === "auth" ? "sign in" : state === "failed" ? "failed" : null,
      led: state === "auth" ? "warn" : state === "failed" ? "bad" : "",
      tone: TONES[i % TONES.length],
      glyph: glyphFor(s.name),
    };
  });
  const ready = carts.filter((c) => c.state === "ready").length;
  const attention = carts.filter((c) => c.tape).length;
  return {
    carts,
    ready,
    total: carts.length,
    count: `${ready} of ${carts.length} ready`,
    attention,
    footer: attention
      ? `${attention} ${attention === 1 ? "tool needs" : "tools need"} attention`
      : null,
  };
}

/* ---------------- goal strip ---------------- */

export type GoalStripVM = {
  objective: string;
  pill: { tone: "accent" | "warn" | "ok" | ""; label: string; pulse: boolean };
  /** Null without a budget. */
  meter: { used: string; budget: string; pct: number; warn: boolean } | null;
  /** Token total shown when there is no budget. */
  total: string;
};

/** Pill for the goal's status. Blocked, usage limit and budget reached are amber; complete is green. */
export function goalPill(goal: Goal, review: GoalReview | null): GoalStripVM["pill"] {
  if (goalAccepted(goal, review)) return { tone: "ok", label: "Accepted", pulse: false };
  if (awaitingReview(goal, review))
    return { tone: "warn", label: "Ready for review", pulse: false };
  switch (goal.status) {
    case "active":
      return { tone: "accent", label: "Active", pulse: true };
    case "paused":
      return { tone: "", label: "Paused", pulse: false };
    case "blocked":
    case "usageLimited":
    case "budgetLimited":
      return { tone: "warn", label: goalStateLabel(goal, review), pulse: false };
    default:
      return { tone: "", label: goalStateLabel(goal, review), pulse: false };
  }
}

export function goalStrip(
  goal: Goal,
  review: GoalReview | null,
  totalTokens: number,
): GoalStripVM {
  const budget = goal.tokenBudget ?? null;
  const pct = budget
    ? Math.min(100, Math.max(0, Math.round((goal.tokensUsed / budget) * 100)))
    : 0;
  return {
    objective: goal.objective,
    pill: goalPill(goal, review),
    meter: budget
      ? {
          used: formatTokens(goal.tokensUsed),
          budget: formatTokens(budget),
          pct,
          // The bar turns amber past 80%.
          warn: pct > 80,
        }
      : null,
    total: formatTokens(totalTokens),
  };
}

/* ---------------- session health ---------------- */

export type HealthVM =
  | { kind: "orphaned"; title: string; sub: string; placeholder: string }
  | { kind: "dead"; title: string; sub: string }
  | { kind: "archived"; text: string }
  | null;

/** Which of the three "stops taking input" states applies. Dead wins over archived. */
export function sessionHealth(
  session: Pick<Session, "status" | "archived"> | null | undefined,
): HealthVM {
  if (!session) return null;
  if (session.status === "dead")
    return {
      kind: "dead",
      title: "This session has ended.",
      sub: "You can read it, but it can no longer run.",
    };
  if (session.status === "orphaned")
    return {
      kind: "orphaned",
      title: "This session lost its runner. Reconnect or start a new chat.",
      sub: "Your history is safe.",
      placeholder: "Reconnect to send a message",
    };
  if (session.archived) return { kind: "archived", text: "This chat is archived." };
  return null;
}

/* ---------------- error toast ---------------- */

export type ToastVM = {
  title: string;
  /** What happened to the turn. */
  detail: string | null;
  /** "err_7f3a21" style reference, mono. */
  ref: string | null;
};

export function errorToast(input: {
  message: string;
  detail?: string | null;
  ref?: { code?: string; requestId?: string; turnId?: string } | null;
}): ToastVM | null {
  const title = input.message.trim();
  if (!title) return null;
  const r = input.ref;
  const ref = r ? [r.code, r.requestId ?? r.turnId].filter(Boolean).join(" · ") : "";
  return { title, detail: input.detail?.trim() || null, ref: ref || null };
}
