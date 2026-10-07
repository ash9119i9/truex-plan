"use client";
import { useId, useState, type CSSProperties } from "react";
import type { AgentSummary } from "../../../shared/contracts";
import { Robot } from "@/components/v2/agent-badge";
import { tintOf } from "@/lib/agent-look";
import { BOARD_KINDS, TILTS, boardMeta, filterAgents, inkOn, pad2, showNewCard, type BoardKind } from "@/lib/agent-board";

// Agent team list v2 (agent-team-list-v2-spec.md §9.2-9.3): a pinned board of
// tilted cards on grid paper, one pushpin per card, no string.

export type BoardAgent = AgentSummary & { reasoning?: "Low" | "Medium" | "High" };

// Pushpin at the top of every team card: blue by default, red on the agent in the current chat.
const PIN_TONES = { blue: ["#8CC8F0", "#3691CD", "#1D5A86"], red: ["#FF8A80", "#E5322D", "#9E1712"] };
function BoardPin({ live }: { live: boolean }) {
  const id = "bp" + useId().replace(/[^a-zA-Z0-9]/g, "");
  const [hi, mid, lo] = PIN_TONES[live ? "red" : "blue"];
  return (
    <svg className="tb-pin" width="24" height="30" viewBox="-12 -12 24 30" aria-hidden="true">
      <defs>
        <radialGradient id={id} cx=".35" cy=".3" r=".75">
          <stop offset="0" stopColor={hi} /><stop offset=".45" stopColor={mid} /><stop offset="1" stopColor={lo} />
        </radialGradient>
      </defs>
      <ellipse cx="4" cy="15" rx="5" ry="2" fill="rgb(16 24 32 / 22%)" />
      <path d="M1 2l2 12" stroke="#8A969D" strokeWidth="2" strokeLinecap="round" />
      <circle r="10" fill={`url(#${id})`} />
      <circle r="10" fill="none" stroke="rgb(16 24 32 / 25%)" />
      <ellipse cx="-3.5" cy="-3.5" rx="3.4" ry="2.2" fill="#fff" fillOpacity=".7" transform="rotate(-35 -3.5 -3.5)" />
    </svg>
  );
}

// Board glyphs, drawn to the prototype's exact strokes (the shared Icon set uses 1.75).
const TbPlus = ({ size }: { size: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={size < 16 ? 2.2 : 2} strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
);
const TbSearch = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
);
const TbPencil = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z" /></svg>
);
const TbLock = () => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
);
const TbBolt = () => (
  <svg className="tb-doodle tb-bolt" width="54" height="64" viewBox="0 0 54 64" aria-hidden="true">
    <path d="M30 2 10 34h16l-6 28 26-38H30z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    <path d="M4 18l6 3M46 44l6 2M40 8l4-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);
const TbSquig = () => (
  <svg className="tb-doodle tb-squig" width="90" height="30" viewBox="0 0 90 30" aria-hidden="true">
    <path d="M2 20c8-14 14-14 20 0s12 14 20 0 14-14 20 0 12 14 26-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);
const TbArrow = () => (
  <svg width="40" height="28" viewBox="0 0 46 30" aria-hidden="true">
    <path d="M4 26c4-16 18-22 36-16M34 4l6 6-8 3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export function AgentsView({ agents, currentId, onEdit, onChat, onNew }: {
  agents: BoardAgent[]; currentId: string; onEdit: (a: BoardAgent) => void; onChat: (a: BoardAgent) => void; onNew: () => void;
}) {
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<BoardKind>("all");
  const needle = q.trim().toLowerCase();
  const shown = filterAgents(agents, kind, q);
  const yours = agents.filter((a) => !a.builtin).length;
  return (
    <div className="tb-root">
      <div className="tb-top">
        <span className="tb-brand">truex / agents</span>
        <button className="tb-new" onClick={onNew}><TbPlus size={14} />New agent</button>
      </div>

      <header className="tb-hero">
        <h1>What the <span className="tb-script">team</span> can help with</h1>
        <p>{agents.length} specialists · {yours} built by you. Pin one to the chat, or build your own.</p>
      </header>

      <div className="tb-tools">
        <label className="tb-search">
          <TbSearch />
          <input value={q} placeholder="Search by name, handle or purpose" aria-label="Search agents" onChange={(e) => setQ(e.target.value)} />
        </label>
        <div className="tb-pills" role="radiogroup" aria-label="Filter agents">
          {BOARD_KINDS.map(([id, label]) => (
            <button key={id} className="tb-pill" role="radio" aria-checked={kind === id} onClick={() => setKind(id)}>{label}</button>
          ))}
        </div>
      </div>

      <section className="tb-board" aria-label="Agent team">
        <TbBolt />
        <TbSquig />
        <ul className="tb-team">
          {needle && shown.length === 0 ? (
            <li className="tb-empty">
              <strong>No agents match "{q.trim()}"</strong>
              <button className="tb-btn" onClick={() => setQ("")}>Clear search</button>
            </li>
          ) : (
            <>
              {shown.map((a, i) => {
                const t = tintOf(a.tint), live = a.id === currentId;
                return (
                  <li key={a.id} className="tb-card"
                    style={{ "--tint": t.bg, "--frame": t.dot, "--cap": inkOn(t.dot), "--tilt": `${TILTS[i % TILTS.length]}deg`, "--i": i } as CSSProperties}>
                    <BoardPin live={live} />
                    <div className="tb-frame">
                      <button className="tb-photo" onClick={() => onEdit(a)} aria-label={`Edit ${a.name}`}>
                        {a.builtin && <span className="tb-lock" aria-hidden="true"><TbLock />built-in</span>}
                        <span className="tb-robot"><Robot look={a.look} size={128} /></span>
                        <span className="tb-hint" aria-hidden="true"><TbPencil />Edit</span>
                      </button>
                      <div className="tb-caption">{a.name}</div>
                    </div>
                    <div className="tb-info">
                      <div className="tb-handle">
                        @{a.handle || a.id}
                        {a.creatorName && <span className="tb-by"> · by {a.creatorName}</span>}
                        {live && <span className="tb-live"><span className="tb-pulse" aria-hidden="true" />in chat</span>}
                        {a.builtin && <span className="sr-only"> · built-in</span>}
                      </div>
                      <p className="tb-desc">{a.description}</p>
                      <div className="tb-foot">
                        <span className="tb-meta">{boardMeta(a.model, a.reasoning)}</span>
                        <button className="tb-btn" onClick={() => onChat(a)} disabled={live || a.canUse === false} title={a.canUse === false ? "Only its creator can chat with this agent" : undefined}>{live ? "Chatting" : a.canUse === false ? "Read-only" : "Chat"}</button>
                      </div>
                    </div>
                  </li>
                );
              })}
              {showNewCard(kind, q) && (
                <li className="tb-card is-new" style={{ "--tilt": `${TILTS[shown.length % TILTS.length]}deg`, "--i": shown.length } as CSSProperties}>
                  <button className="tb-frame" onClick={onNew}>
                    <span className="tb-photo-empty"><span className="tb-plus"><TbPlus size={18} /></span></span>
                    <span className="tb-caption">New agent</span>
                  </button>
                  <span className="tb-note" aria-hidden="true">build your own<TbArrow /></span>
                </li>
              )}
            </>
          )}
        </ul>
      </section>

      <div className="tb-board-foot">
        <span className="tb-tag">{BOARD_KINDS.find((k) => k[0] === kind)![1]}</span>
        <span className="tb-tag" aria-label={`${shown.length} of ${agents.length} agents shown`}>{pad2(shown.length)}/{pad2(agents.length)}</span>
      </div>
    </div>
  );
}
