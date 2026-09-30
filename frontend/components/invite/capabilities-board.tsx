"use client";

// Right pane of the join page (join-tenant-v3-dev-spec.html, "Capabilities board").
// Decorative: the board itself is aria-hidden and the legend is the readable version.
// The copy is product-level only. The page is public, so it never shows tenant counts or names.
// Styles: styles/v2/invite-board.css (the page imports it), scoped under .join-page .right.

import { useEffect, useId, useRef, useState, type CSSProperties } from "react";

/** Specimen 07, "Your profile". An empty name shows the open seat ("YOU", "Your name", "seat open"). */
export type BoardProfile = {
  name: string;
  initials: string;
  sub: string;
  joined: boolean;
  /** CSS custom property names for the aura, for example ["--mint-dot", "--peach-dot", "--mint"]. Absent means the empty fallback. */
  aura?: [string, string, string];
};

// Custom properties set inline (placement from the spec's table).
type Vars = CSSProperties & Record<`--${string}`, string | number>;

const LEGEND: [n: string, title: string, desc: string][] = [
  ["01", "Named agents", "@mention an agent and it picks up work."],
  ["02", "Live sessions", "Agents keep working in the background."],
  ["03", "Goals and plans", "Turn a goal into a plan you can edit."],
  ["04", "Search everything", "⌘K finds chats, files and agents."],
  ["05", "One-click sessions", "Start a chat from any project or thread."],
  ["06", "Team in the loop", "Teammates share threads and files."],
  ["07", "Your profile", "How teammates see you, live as you type."],
  ["08", "Custom agents", "Pick a look, skills and tone."],
];

// Decorative timer from the prototype: starts at 00:31:23 and ticks each second.
const TIMER_START = 31 * 60 + 23;
const pad = (n: number) => String(n).padStart(2, "0");
const clock = (s: number) => `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;

function Check() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="12" cy="12" r="10" />
      <path d="M7.5 12.2l3 3 6-6" fill="none" stroke="var(--board-bg)" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

function Plus({ width }: { width: number }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={width} strokeLinecap="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function CapabilitiesBoard({ profile }: { profile: BoardProfile }) {
  // useId output can hold characters that break url(#…); keep it to a safe id.
  const clipId = `clover-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const rightRef = useRef<HTMLElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const [secs, setSecs] = useState(TIMER_START);
  const [hot, setHot] = useState<number | null>(null);

  useEffect(() => {
    const id = window.setInterval(() => setSecs((s) => s + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  // Pointer parallax on the whole panel, measured against the board. Skipped under reduced motion.
  useEffect(() => {
    const right = rightRef.current;
    const board = boardRef.current;
    if (!right || !board) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const move = (e: PointerEvent) => {
      const r = board.getBoundingClientRect();
      board.style.setProperty("--px", String(((e.clientX - r.left) / r.width - 0.5) * -10));
      board.style.setProperty("--py", String(((e.clientY - r.top) / r.height - 0.5) * -10));
    };
    const leave = () => {
      board.style.setProperty("--px", "0");
      board.style.setProperty("--py", "0");
    };
    right.addEventListener("pointermove", move);
    right.addEventListener("pointerleave", leave);
    return () => {
      right.removeEventListener("pointermove", move);
      right.removeEventListener("pointerleave", leave);
    };
  }, []);

  const sp = (c: number) => `sp s${c}${hot === c ? " is-hot" : ""}`;
  const empty = profile.name.trim() === "";
  const auraStyle: Vars | undefined =
    !empty && profile.aura
      ? { "--a1": `var(${profile.aura[0]})`, "--a2": `var(${profile.aura[1]})`, "--a3": `var(${profile.aura[2]})` }
      : undefined;

  return (
    <aside ref={rightRef} className="right" aria-labelledby={`${clipId}-h`} style={{ "--clover": `url(#${clipId})` } as Vars}>
      {/* Shared clover (water-lily) shape, in object-bounding-box units */}
      <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
        <clipPath id={clipId} clipPathUnits="objectBoundingBox">
          <path d="M.5,.1 C.82,-.1 1.1,.18 .9,.5 C1.1,.82 .82,1.1 .5,.9 C.18,1.1 -.1,.82 .1,.5 C-.1,.18 .18,-.1 .5,.1Z" />
        </clipPath>
      </svg>

      <div className="right-head">
        <div>
          <h2 id={`${clipId}-h`}>
            What you can do in <em>truex</em>
          </h2>
          <p>Eight things waiting on the other side of that button.</p>
        </div>
        <span className="mono">TRUEX · CAPABILITIES</span>
      </div>

      <div className="board-wrap">
        <div ref={boardRef} className={`board${hot ? " has-hot" : ""}`} aria-hidden="true">
          <div className="sp bar-a grain" style={{ "--d": 0.4, "--fd": "12s" } as Vars} />
          <div className="sp bar-b grain" style={{ "--d": 0.6, "--fd": "10s", "--fdl": "-3s" } as Vars} />

          <div className={`${sp(1)} drop`} style={{ "--d": 0.9, "--fd": "9s", "--fdl": "-1s" } as Vars}>
            <div className="clover grain lit">
              <span className="aurora" />
              <span className="core" />
            </div>
            <span className="idx">01</span>
          </div>

          <div className={sp(2)} style={{ "--d": 1.3, "--fd": "8s", "--fdl": "-4s" } as Vars}>
            <div className="pill glass">
              <span className="live" />
              <span>{clock(secs)}</span>
            </div>
            <span className="idx" style={{ right: "-5cqw", top: 0 }}>02</span>
          </div>

          <div className={sp(3)} style={{ "--d": 1.1, "--fd": "11s", "--fdl": "-2s" } as Vars}>
            <div className="tile glass grain">
              <div className="lotus">
                <i />
                <i />
                <i />
                <i />
              </div>
            </div>
            <span className="idx">03</span>
          </div>

          <div className={sp(4)} style={{ "--d": 1.6, "--fd": "7s", "--fdl": "-5s" } as Vars}>
            <div className="orb glass">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <circle cx="10.5" cy="10.5" r="6.5" />
                <path d="M15.5 15.5L20 20" />
              </svg>
            </div>
            <kbd>⌘ K</kbd>
            <span className="idx">04</span>
          </div>

          <div className={sp(5)} style={{ "--d": 0.7, "--fd": "10s", "--fdl": "-6s" } as Vars}>
            <div className="ghost-pill">Start session</div>
            <span className="idx" style={{ right: "-4.6cqw" }}>05</span>
          </div>

          <div className={sp(6)} style={{ "--d": 1.2, "--fd": "12s", "--fdl": "-3s" } as Vars}>
            <div className="frame drop">
              <div className="clover grain">
                <span className="photo" />
                <span className="vign" />
              </div>
              <span className="plus">
                <Plus width={1.8} />
              </span>
            </div>
            <div className="who">
              Your team
              <Check />
            </div>
            <div className="sub">shared threads</div>
            <span className="idx" style={{ top: 0 }}>06</span>
          </div>

          <div className={sp(7)} style={{ "--d": 0.9, "--fd": "10s", "--fdl": "-2s" } as Vars}>
            <div className="drop">
              <div className={`clover grain${empty ? " is-empty" : ""}`} style={auraStyle}>
                <span className="aura" />
                <span className="me">{empty ? "YOU" : profile.initials}</span>
              </div>
            </div>
            <div className="who">
              <span>{empty ? "Your name" : profile.name}</span>
              {!empty && profile.joined && <Check />}
            </div>
            <div className="sub">{empty ? "seat open" : profile.sub}</div>
            <span className="idx" style={{ right: "-2.6cqw" }}>07</span>
          </div>

          <div className={sp(8)} style={{ "--d": 1.4, "--fd": "9s", "--fdl": "-7s" } as Vars}>
            <div className="tile glass">
              <span className="pearl" style={{ "--c": "var(--mint-dot)" } as Vars} />
              <span className="pearl add">
                <Plus width={2.2} />
              </span>
              <span className="pearl" style={{ "--c": "var(--butter-dot)" } as Vars} />
              <span className="pearl" style={{ "--c": "var(--lilac-dot)" } as Vars} />
            </div>
            <span className="idx">08</span>
          </div>

          <div className="board-foot">
            <div className="mono">
              truex-invite-v3
              <br />
              agents · sessions
              <br />
              goals · search
            </div>
            <div className="sig">Capabilities</div>
          </div>
        </div>
      </div>

      <ol className="legend">
        {LEGEND.map(([n, title, desc], i) => {
          const c = i + 1;
          const on = () => setHot(c);
          const off = () => setHot((h) => (h === c ? null : h));
          return (
            // Focusable so keyboard users get the same highlight; the items have no action (spec, Legend).
            <li key={n} tabIndex={0} data-c={c} onMouseEnter={on} onMouseLeave={off} onFocus={on} onBlur={off}>
              <span className="n">{n}</span>
              <b>{title}</b>
              <span className="d">{desc}</span>
            </li>
          );
        })}
      </ol>
    </aside>
  );
}
