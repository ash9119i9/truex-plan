"use client";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { CONFETTI_COLORS } from "@/lib/agent-look";
import { Lanyard } from "@/components/v2/agent-badge";
import { Button } from "@/components/tx/button";
import { classes } from "@/components/tx/classes";

// After Issue ID (spec 15.3, then the legacy dialog's celebration): the desk
// gives way to a dark stage. The sealed card falls in on a strap pinned above
// the window, over a burst of confetti, with the words below it. Nothing
// closes on its own.
export function AgentIssued({
  name,
  handle,
  issued,
  canChat,
  onSayHi,
  onDone,
  children,
}: {
  name: string;
  handle: string;
  /** The issue date printed on the seal, "30 OCT 2026". */
  issued: string;
  /** The agent can start a chat now, so Say hi is offered. */
  canChat: boolean;
  onSayHi: () => void;
  onDone: () => void;
  /** The issued ID card, front up with its seal. */
  children: ReactNode;
}) {
  const titleId = useId();
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => first.current?.focus(), []);
  // Falling, the strap's hidden length runs far above the window. Once it
  // lands that length is dropped, so the card swings from the window's top
  // edge; for one frame the strap has no transition, so the swap can't show.
  const [landed, setLanded] = useState(false);
  const [hung, setHung] = useState(false);
  useEffect(() => {
    if (!landed) return;
    let next = 0;
    const frame = requestAnimationFrame(() => {
      next = requestAnimationFrame(() => setHung(true));
    });
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(next);
    };
  }, [landed]);
  return (
    <div
      className={classes(
        "idd-celebrate",
        landed && "is-landed",
        hung && "is-hung",
      )}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={`${titleId}-d`}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        onDone();
      }}
    >
      <Button
        className="idd-celebrate-x"
        iconOnly
        icon="x"
        variant="ghost"
        size="sm"
        aria-label="Close"
        onClick={onDone}
      />
      <div
        className="idd-celebrate-stage"
        onAnimationEnd={(e) => {
          if (e.animationName === "idc-unroll") setLanded(true);
        }}
      >
        <Confetti />
        <Lanyard>
          <div className="idc-wrap">{children}</div>
        </Lanyard>
      </div>
      <div className="idd-celebrate-copy">
        <span className="idd-celebrate-mark">Agent ID issued · {issued}</span>
        <h2 id={titleId} className="t-h2">
          {name} is on the team
        </h2>
        <p id={`${titleId}-d`}>
          @{handle} is ready to work. Drag its card around while you’re here.
        </p>
        <div className="idd-celebrate-actions">
          {canChat && (
            <Button ref={first} variant="primary" size="lg" onClick={onSayHi}>
              Say hi to {name}
            </Button>
          )}
          <Button ref={canChat ? undefined : first} size="lg" onClick={onDone}>
            Done
          </Button>
        </div>
      </div>
    </div>
  );
}

// 56 pieces thrown out from behind the card, ported from the legacy dialog.
export function Confetti() {
  const bits = useMemo(
    () =>
      Array.from({ length: 56 }, (_, i) => {
        const a = Math.random() * Math.PI * 2;
        const dist = 110 + Math.random() * 220;
        const dot = i % 3 === 0;
        return {
          "--x": `${Math.round(Math.cos(a) * dist)}px`,
          "--y": `${Math.round(Math.sin(a) * dist * 0.75 - 70)}px`,
          "--r": `${Math.round(Math.random() * 720 - 360)}deg`,
          "--c": CONFETTI_COLORS[i % CONFETTI_COLORS.length],
          "--w": dot ? "7px" : `${5 + Math.round(Math.random() * 4)}px`,
          "--h": dot ? "7px" : `${3 + Math.round(Math.random() * 9)}px`,
          "--d": `${Math.round(Math.random() * 140)}ms`,
          "--t": `${1500 + Math.round(Math.random() * 900)}ms`,
          borderRadius: dot ? "50%" : "2px",
        } as CSSProperties;
      }),
    [],
  );
  return (
    <div className="idc-confetti" aria-hidden="true">
      {bits.map((style, i) => (
        <i key={i} style={style} />
      ))}
    </div>
  );
}
