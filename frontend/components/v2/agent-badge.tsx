"use client";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { lookOf, tone } from "@/lib/agent-look";
import {
  dragPose,
  grabX,
  releaseSpin,
  settled,
  swingStep,
  type Swing,
} from "@/lib/lanyard";

// The agent robot portrait and the lanyard its ID card hangs from (spec 15.3).

export function Robot({ look, size = 64 }: { look: number; size?: number }) {
  const L = lookOf(look);
  // Gradient/filter ids must be unique per instance; useId output has colons, which url(#…) dislikes.
  const id = "rb" + useId().replace(/[^a-zA-Z0-9]/g, "");
  const u = (n: string) => `url(#${id}-${n})`;
  const edge = tone(L.body, -0.45);
  const acc = L.accColor || L.body;
  const accEdge = tone(acc, -0.4);
  const limb = { fill: u("limb"), stroke: edge, strokeWidth: 1.5 };
  const accLine = {
    fill: u("acc"),
    stroke: accEdge,
    strokeWidth: 1.4,
    strokeLinejoin: "round" as const,
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 120 120"
      aria-hidden="true"
      shapeRendering="geometricPrecision"
    >
      <defs>
        <linearGradient id={`${id}-body`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={tone(L.body, 0.38)} />
          <stop offset=".55" stopColor={L.body} />
          <stop offset="1" stopColor={tone(L.body, -0.3)} />
        </linearGradient>
        <linearGradient id={`${id}-limb`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={tone(L.body, -0.06)} />
          <stop offset="1" stopColor={tone(L.body, -0.34)} />
        </linearGradient>
        <radialGradient id={`${id}-sheen`} cx=".3" cy=".2" r=".6">
          <stop offset="0" stopColor="#fff" stopOpacity=".6" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${id}-visor`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={tone(L.visor, 0.24)} />
          <stop offset="1" stopColor={tone(L.visor, -0.38)} />
        </linearGradient>
        <radialGradient id={`${id}-screen`} cx=".5" cy=".55" r=".6">
          <stop offset="0" stopColor={L.glow} stopOpacity=".3" />
          <stop offset="1" stopColor={L.glow} stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${id}-acc`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={tone(acc, 0.32)} />
          <stop offset="1" stopColor={tone(acc, -0.22)} />
        </linearGradient>
        <linearGradient id={`${id}-chef`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FFFFFF" />
          <stop offset="1" stopColor="#D6DEE2" />
        </linearGradient>
        <radialGradient id={`${id}-shadow`}>
          <stop offset="0" stopColor="#101820" stopOpacity=".3" />
          <stop offset="1" stopColor="#101820" stopOpacity="0" />
        </radialGradient>
        <filter id={`${id}-glow`} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="1.8" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      <ellipse cx="60" cy="109" rx="36" ry="6.5" fill={u("shadow")} />
      {/* pack and legs sit behind the shell */}
      <rect x="13" y="50" width="20" height="38" rx="9" {...limb} />
      <rect x="37" y="82" width="19" height="25" rx="8.5" {...limb} />
      <rect x="64" y="82" width="19" height="25" rx="8.5" {...limb} />
      <path
        d="M41 101.5h11M68 101.5h11"
        stroke="#fff"
        strokeOpacity=".18"
        strokeWidth="2"
        strokeLinecap="round"
      />

      {/* shell: base gradient, soft top-left sheen, right rim light */}
      <rect
        x="24"
        y="22"
        width="72"
        height="72"
        rx="31"
        fill={u("body")}
        stroke={edge}
        strokeWidth="1.5"
      />
      <rect x="24" y="22" width="72" height="72" rx="31" fill={u("sheen")} />
      <path
        d="M90 46c3.6 10 3.4 24-2 34"
        fill="none"
        stroke="#fff"
        strokeOpacity=".24"
        strokeWidth="3"
        strokeLinecap="round"
      />
      {L.acc !== "scarf" && (
        <circle cx="73" cy="81" r="2.2" fill={L.glow} filter={u("glow")} />
      )}

      {L.acc === "scarf" && (
        <g>
          <path
            d="M72 79l3.5 21c.4 2.2 3.2 2.8 4.6 1.1L87 93l-5.5-15z"
            {...accLine}
          />
          <path
            d="M77 97l1.2 4M81 95.5l1.6 3.6"
            stroke={accEdge}
            strokeWidth="1.2"
            strokeLinecap="round"
          />
          <path
            d="M25 71c20 8.5 50 8.5 70 0v9c-20 8.5-50 8.5-70 0z"
            {...accLine}
          />
          <path
            d="M31 75c16 5.5 42 5.5 58 0"
            fill="none"
            stroke="#fff"
            strokeOpacity=".35"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </g>
      )}

      {/* visor: bezel, glass, screen bloom, glowing face, glare */}
      <rect
        x="35"
        y="36"
        width="54"
        height="33"
        rx="15"
        fill={tone(L.visor, -0.55)}
      />
      <rect
        x="37.5"
        y="38.5"
        width="49"
        height="28"
        rx="12.5"
        fill={u("visor")}
      />
      <rect
        x="37.5"
        y="38.5"
        width="49"
        height="28"
        rx="12.5"
        fill={u("screen")}
      />
      <g filter={u("glow")}>
        {L.face === "line" && (
          <rect x="51" y="50" width="22" height="5.6" rx="2.8" fill={L.glow} />
        )}
        {L.face === "eyes" && (
          <>
            <circle cx="52" cy="53" r="4.1" fill={L.glow} />
            <circle cx="72" cy="53" r="4.1" fill={L.glow} />
          </>
        )}
        {L.face === "happy" && (
          <path
            d="M47 55.5q5-6.2 10 0M67 55.5q5-6.2 10 0"
            fill="none"
            stroke={L.glow}
            strokeWidth="3.2"
            strokeLinecap="round"
          />
        )}
      </g>
      {L.face === "eyes" && (
        <>
          <circle cx="53.4" cy="51.6" r="1.2" fill="#fff" />
          <circle cx="73.4" cy="51.6" r="1.2" fill="#fff" />
        </>
      )}
      <path
        d="M43.5 45c3-2.8 8-3.8 13-3.6"
        fill="none"
        stroke="#fff"
        strokeOpacity=".6"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
      <circle cx="80.5" cy="61" r="1.5" fill="#fff" fillOpacity=".35" />

      {L.acc === "antenna" && (
        <g>
          <path
            d="M60 23V10"
            stroke={edge}
            strokeWidth="3"
            strokeLinecap="round"
          />
          <rect
            x="54.5"
            y="20"
            width="11"
            height="4.5"
            rx="2.25"
            fill={tone(L.body, -0.2)}
            stroke={edge}
            strokeWidth="1.2"
          />
          <circle cx="60" cy="8.5" r="9" fill={L.glow} opacity=".28" />
          <circle
            cx="60"
            cy="8.5"
            r="5.2"
            fill={L.glow}
            stroke={tone(L.glow, -0.4)}
            strokeWidth="1.2"
          />
          <circle cx="58.3" cy="6.8" r="1.6" fill="#fff" opacity=".85" />
        </g>
      )}
      {L.acc === "cap" && (
        <g>
          <path
            d="M80 33.5c10-1 21 0 27 3 2 1.2 1 4-1.5 4-8 0-17-1-26-2.5z"
            {...accLine}
            fill={tone(acc, -0.1)}
          />
          <path d="M26 38C26 10 94 10 94 38c-10-3-58-3-68 0z" {...accLine} />
          <path
            d="M60 15v21"
            stroke={accEdge}
            strokeOpacity=".45"
            strokeWidth="1.2"
          />
          <path
            d="M36 28c5-7 12-10 19-11"
            fill="none"
            stroke="#fff"
            strokeOpacity=".4"
            strokeWidth="2.2"
            strokeLinecap="round"
          />
          <circle
            cx="60"
            cy="14.5"
            r="2.6"
            fill={tone(acc, -0.15)}
            stroke={accEdge}
            strokeWidth="1"
          />
        </g>
      )}
      {L.acc === "hardhat" && (
        <g>
          <path d="M26 33C26 4 94 4 94 33z" {...accLine} />
          <rect
            x="55"
            y="7.5"
            width="10"
            height="25"
            rx="4"
            fill={tone(acc, 0.3)}
            stroke={accEdge}
            strokeWidth="1.2"
          />
          <rect
            x="17"
            y="30"
            width="86"
            height="7"
            rx="3.5"
            {...accLine}
            fill={tone(acc, -0.08)}
          />
          <path
            d="M34 24c3-7 9-11 16-13"
            fill="none"
            stroke="#fff"
            strokeOpacity=".45"
            strokeWidth="2.2"
            strokeLinecap="round"
          />
        </g>
      )}
      {L.acc === "chef" && (
        <g>
          <g fill={u("chef")}>
            <circle cx="44" cy="18" r="10.5" />
            <circle cx="76" cy="18" r="10.5" />
            <circle cx="60" cy="13" r="12.5" />
          </g>
          <path
            d="M41 11c2-2 5-3 8-3M56 5c2-1 5-1.4 7-1"
            fill="none"
            stroke="#fff"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <rect
            x="36"
            y="18"
            width="48"
            height="15"
            rx="5"
            fill={u("chef")}
            stroke="#B9C4CA"
            strokeWidth="1.2"
          />
          <path
            d="M48 21v9M60 21v9M72 21v9"
            stroke="#B9C4CA"
            strokeOpacity=".7"
            strokeWidth="1"
            strokeLinecap="round"
          />
        </g>
      )}
      {L.acc === "headphones" && (
        <g>
          <path
            d="M22 54C22 10 98 10 98 54"
            fill="none"
            stroke={tone(acc, -0.4)}
            strokeWidth="7"
            strokeLinecap="round"
          />
          <path
            d="M22 54C22 10 98 10 98 54"
            fill="none"
            stroke={tone(acc, 0.25)}
            strokeOpacity=".6"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <rect x="13" y="43" width="17" height="27" rx="7.5" {...accLine} />
          <rect x="90" y="43" width="17" height="27" rx="7.5" {...accLine} />
          <path
            d="M17 49v10M94 49v10"
            stroke="#fff"
            strokeOpacity=".45"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </g>
      )}
      {L.acc === "bow" && (
        <g>
          <path
            d="M78 20l-11-7c-2-1.2-4 .4-4 2.6v9c0 2.2 2.2 3.4 4 2.4z"
            {...accLine}
          />
          <path
            d="M78 20l11-7c2-1.2 4 .4 4 2.6v9c0 2.2-2.2 3.4-4 2.4z"
            {...accLine}
          />
          <circle
            cx="78"
            cy="20"
            r="3.6"
            {...accLine}
            fill={tone(acc, -0.12)}
          />
          <path
            d="M66.5 16.5l3 1.8M89.5 16.5l-3 1.8"
            stroke="#fff"
            strokeOpacity=".5"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </g>
      )}
    </svg>
  );
}

// Lanyard hardware: crimp end for the ribbon, swivel, split ring and a clear tab that feeds into the badge slot.
function Clip() {
  const id = "cl" + useId().replace(/[^a-zA-Z0-9]/g, "");
  const metal = `url(#${id}-m)`;
  return (
    <svg
      className="clip"
      width="56"
      height="70"
      viewBox="0 0 56 70"
      aria-hidden="true"
      shapeRendering="geometricPrecision"
    >
      <defs>
        <linearGradient id={`${id}-m`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#8A969D" />
          <stop offset=".35" stopColor="#F4F7F8" />
          <stop offset=".62" stopColor="#B7C1C6" />
          <stop offset="1" stopColor="#77838A" />
        </linearGradient>
        <linearGradient id={`${id}-t`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FFFFFF" stopOpacity=".85" />
          <stop offset="1" stopColor="#EAF2F5" stopOpacity=".6" />
        </linearGradient>
      </defs>
      <rect
        x="20"
        y="35"
        width="16"
        height="35"
        rx="4"
        fill={`url(#${id}-t)`}
        stroke="rgb(31 42 48 / 24%)"
        strokeWidth=".8"
      />
      <path
        d="M23 39v27"
        stroke="#fff"
        strokeOpacity=".9"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <circle
        cx="28"
        cy="47"
        r="3.3"
        fill={metal}
        stroke="#6B777E"
        strokeWidth=".8"
      />
      <ellipse
        cx="28"
        cy="29"
        rx="8.5"
        ry="11"
        fill="none"
        stroke="#66727A"
        strokeWidth="5"
      />
      <ellipse
        cx="28"
        cy="29"
        rx="8.5"
        ry="11"
        fill="none"
        stroke={metal}
        strokeWidth="3.2"
      />
      <rect
        x="24"
        y="12"
        width="8"
        height="7"
        rx="1.6"
        fill={metal}
        stroke="#6B777E"
        strokeWidth=".8"
      />
      <rect
        x="13.5"
        y="0"
        width="29"
        height="13.5"
        rx="3"
        fill={metal}
        stroke="#6B777E"
        strokeWidth=".8"
      />
      <path
        d="M17 4.5h22M17 8.5h22"
        stroke="#6B777E"
        strokeOpacity=".45"
        strokeWidth=".8"
      />
    </svg>
  );
}

// The lanyard the ID card hangs from. Hold it and the card follows the
// pointer: the lanyard pivots on its anchor and the strap stretches. Let go and
// it swings as a damped pendulum from the speed it was released at, then
// rests (lib/lanyard.ts). A press that barely moves is a tap (the desk flips
// the card). Pointer moves write the transform directly, so dragging never
// re-renders the card.
export function Lanyard({
  onTap,
  children,
}: {
  onTap?: () => void;
  children: ReactNode;
}) {
  const el = useRef<HTMLDivElement>(null);
  const strap = useRef<HTMLSpanElement>(null);
  const live = useRef({
    swing: { a: 0, v: 0 } as Swing,
    raf: 0,
    last: 0,
    // The strap's resting length, measured while nothing is stretching it.
    len: 60,
    held: null as null | {
      ox: number;
      oy: number;
      start: { x: number; y: number };
      moved: number;
      r: number;
      r0: number;
    },
    samples: [] as { t: number; a: number }[],
  });

  const pose = (angle: number) => {
    if (el.current)
      el.current.style.transform = angle
        ? `rotate(${angle.toFixed(2)}deg)`
        : "";
  };
  const stop = () => {
    cancelAnimationFrame(live.current.raf);
    live.current.raf = 0;
    live.current.last = 0;
    el.current?.classList.remove("is-swing");
  };
  const tick = (now: number) => {
    const s = live.current;
    const dt = s.last ? Math.min((now - s.last) / 1000, 0.064) : 1 / 60;
    s.last = now;
    swingStep(s.swing, dt, reducedMotion());
    if (settled(s.swing)) {
      s.swing = { a: 0, v: 0 };
      pose(0);
      stop();
      return;
    }
    pose(s.swing.a);
    s.raf = requestAnimationFrame(tick);
  };
  const release = () => {
    const s = live.current;
    if (!s.held) return;
    s.held = null;
    el.current?.classList.remove("is-drag");
    // The strap springs back through its CSS transition.
    if (strap.current) {
      strap.current.style.height = "";
      strap.current.style.width = "";
    }
    s.swing.v = releaseSpin(s.samples);
    s.samples = [];
    if (settled(s.swing)) {
      s.swing = { a: 0, v: 0 };
      pose(0);
      return;
    }
    el.current?.classList.add("is-swing");
    s.last = 0;
    s.raf = requestAnimationFrame(tick);
  };

  // The strap's resting length, read only while nothing stretches or
  // animates it: the celebration unrolls it, and a release springs it back.
  const measure = () => {
    const node = strap.current;
    if (!node || live.current.held || node.style.height) return;
    if (node.getAnimations().length) return;
    live.current.len = node.offsetHeight || live.current.len;
  };
  useEffect(() => {
    measure();
    const node = strap.current;
    window.addEventListener("resize", measure);
    node?.addEventListener("animationend", measure);
    node?.addEventListener("transitionend", measure);
    return () => {
      window.removeEventListener("resize", measure);
      node?.removeEventListener("animationend", measure);
      node?.removeEventListener("transitionend", measure);
      cancelAnimationFrame(live.current.raf);
    };
    // measure reads refs only, so the first one is current for good
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="lanyard-anchor">
      <div
        ref={el}
        className="lanyard"
        aria-hidden="true"
        onPointerDown={(e) => {
          const s = live.current;
          const node = e.currentTarget;
          node.setPointerCapture(e.pointerId);
          measure();
          stop();
          // The pivot: the top centre of the anchor the lanyard hangs from.
          const box = node.parentElement!.getBoundingClientRect();
          const px = box.left + box.width / 2;
          const r = Math.max(
            40,
            Math.hypot(e.clientX - px, e.clientY - box.top),
          );
          const x0 = grabX(s.swing.a, r);
          s.held = {
            ox: e.clientX - x0,
            oy: e.clientY,
            start: { x: e.clientX, y: e.clientY },
            moved: 0,
            r,
            r0: dragPose(x0, 0, s.len, r).reach,
          };
          s.samples = [{ t: e.timeStamp, a: s.swing.a }];
          s.swing.v = 0;
          node.classList.add("is-drag");
        }}
        onPointerMove={(e) => {
          const s = live.current;
          const held = s.held;
          if (!held) return;
          held.moved = Math.max(
            held.moved,
            Math.hypot(e.clientX - held.start.x, e.clientY - held.start.y),
          );
          const p = dragPose(
            e.clientX - held.ox,
            e.clientY - held.oy,
            s.len,
            held.r,
            held.r0,
          );
          s.swing.a = p.angle;
          pose(p.angle);
          if (strap.current) {
            strap.current.style.height = `${p.height}px`;
            strap.current.style.width = `${p.width}px`;
          }
          s.samples.push({ t: e.timeStamp, a: p.angle });
          if (s.samples.length > 32) s.samples.splice(0, s.samples.length - 32);
        }}
        onPointerUp={() => {
          const tap = !!live.current.held && live.current.held.moved < 5;
          release();
          if (tap) onTap?.();
        }}
        onPointerCancel={release}
      >
        <div className="lanyard-sway">
          <span ref={strap} className="strap" />
          <Clip />
          {children}
        </div>
      </div>
    </div>
  );
}

// Reduced motion: the card returns once instead of swinging.
const reducedMotion = () =>
  document.documentElement.dataset.effMotion === "reduce" ||
  matchMedia("(prefers-reduced-motion: reduce)").matches;
