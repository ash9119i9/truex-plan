# truex agent created: standalone

The screen that appears right after you click **Create agent**: the dark blurred scrim, the badge dropping in on its lanyard, the confetti burst, "{name} is on the team", and the **Say hi** / **Done** buttons. The code is copied as-is from `app.tsx` and `index.html`, plus a small demo host at the end.

## Run it

1. Copy the code block below into a file, e.g. `agent-created.html`.
2. Open it in a browser. No build step and no server needed: React 18 and Babel load from unpkg.

It opens straight on the success screen with a sample agent. Drag the badge around. **Replay** runs the drop and confetti again.

## How it works

- **Where it lives in `app.tsx`:** `AgentDialog`'s `submit()` builds the new agent, calls `onCreate(a)` and sets `created`. When `created` is set, the dialog returns this screen instead of the form. Here that branch is pulled out into `AgentCreated`.
- **Badge drop:** `.celebrate-stage .lanyard-anchor` plays `drop` (from `translateY(-110%)`) over 0.9s with the overshooting curve `cubic-bezier(.34, 1.56, .64, 1)`, so it bounces once as it lands. The strap height scales with the viewport (`clamp(24px, 16vh, 180px)`).
- **Confetti:** `Confetti` makes 56 pieces, each with a random angle, distance, spin, size, delay and duration, set as CSS variables. The `burst` keyframes fling each piece out, then drop it 170px while it fades.
- **Copy:** the heading and buttons fade up with `rise`, delayed 0.35s so they land after the badge.
- **Drag physics:** the same `Badge` as the form preview. The drag goes through `tanh` for rubber-band resistance, the lanyard rotates around its top anchor, the strap stretches, and it springs back on release.
- **Buttons:** Escape or **Done** closes it. **Say hi** calls `onSayHi`. In the real app that handler is:

  ```tsx
  onSayHi={a => { setCreating(false); newChat(); setAgent(a); const t = `@${a.handle} hi, `; setDraft(t); focusInput(t); }}
  ```

  which starts a new chat with the agent and pre-fills the composer. In the demo it just shows the draft.

## Code

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>truex agent created</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700;800&family=Newsreader:ital,opsz,wght@1,6..72,400..500&family=JetBrains+Mono:wght@400;500&family=Caveat:wght@600;700&display=swap" rel="stylesheet" />
  <style>
    :root {
      --brand-50: #F8FCFD; --brand-100: #F4FAFC; --brand-200: #EAF5F8; --brand-300: #D8EBF0;
      --brand-400: #BCDEE8; --brand-500: #3691CD; --brand-600: #2A7DB4; --brand-700: #226A9B;

      --bg: #FFFFFF;
      --surface: #FFFFFF;
      --surface-2: #FFFFFF;
      --surface-3: #F6F9FA;     /* soft surface */
      --line: #E3ECEF;
      --line-strong: #D8E0E4;
      --border-control: #D8E0E4;
      --ink: #1F2A30;           /* graphite */
      --ink-2: #5F6D73;         /* secondary */
      --ink-3: #849198;         /* muted */
      --ink-disabled: #B4BEC3;

      --accent: #3691CD;        /* primary action: buttons, active controls */
      --accent-2: #2A7DB4;      /* strong: hover, dots, progress, focus */
      --accent-hover: #2A7DB4;
      --accent-pressed: #226A9B;
      --accent-soft: #EAF5F8;   /* ice: selected + secondary */
      --accent-soft-2: #BCDEE8; /* pastel companion border */
      --signature: #BCDEE8;
      --accent-fg: #2A72A3;     /* blue text/icons, AA on white and ice */
      --accent-text: #2A72A3;
      --accent-ink: #1F2A30;    /* content on pastel fills */
      --on-accent: #FFFFFF;     /* content on #3691CD fills */
      --warn: #7D5D1D;

      --success-bg: #E7F4ED; --success-text: #35624E;
      --warning-bg: #FFF3D9; --warning-text: #7D5D1D;
      --error-bg: #FBE7E7;   --error-text: #8D4545;
      --info-bg: #EAF5F8;    --info-text: #2A72A3;
      --neutral-bg: #F6F9FA; --neutral-text: #5F6D73;

      --glow-1: rgb(188 222 232 / 60%);
      --glow-2: rgb(234 245 248 / 90%);
      --shadow-sm: 0 1px 2px rgb(31 42 48 / 5%);
      --shadow-md: 0 1px 2px rgb(31 42 48 / 4%), 0 8px 24px -8px rgb(31 42 48 / 10%);
      --shadow-lg: 0 2px 4px rgb(31 42 48 / 4%), 0 10px 35px rgb(31 42 48 / 8%);
      --radius: 16px;

      --font-sans: "Figtree", ui-sans-serif, system-ui, sans-serif;
      --font-display: "Figtree", ui-sans-serif, system-ui, sans-serif;
      --font-accent: "Newsreader", ui-serif, Georgia, serif;
      --font-mono: "JetBrains Mono", ui-monospace, monospace;
      --display-weight: 600; --display-track: -.035em;
      --accent-style: italic; --accent-weight: 400; --accent-scale: 1.04;
      color-scheme: light;
    }
    /* Dark theme is not in the brand system (light-mode-first); derived from graphite with #3691CD / #BCDEE8 accents. */
    @media (prefers-color-scheme: dark) {
      :root:not([data-theme="light"]) {
        --bg: #171717; --surface: #171717; --surface-2: #171717; --surface-3: #242424;
        --line: #2A2A2A; --line-strong: #363636; --border-control: #404040;
        --ink: #EEF4F6; --ink-2: #B7C3C8; --ink-3: #8B999F; --ink-disabled: #4E5C62;
        --accent: #3691CD; --accent-2: #5AA8DC; --accent-hover: #2A7DB4; --accent-pressed: #226A9B;
        --accent-soft: #14283A; --accent-soft-2: #1F4461; --accent-fg: #BCDEE8; --accent-text: #BCDEE8; --accent-ink: #1F2A30; --on-accent: #FFFFFF;
        --warn: #E6C27A;
        --success-bg: #16291F; --success-text: #A8D8BE; --warning-bg: #2E2512; --warning-text: #E6C27A;
        --error-bg: #2F1A1A; --error-text: #EDB0B0; --info-bg: #14283A; --info-text: #BCDEE8;
        --neutral-bg: #242424; --neutral-text: #8B999F;
        --glow-1: rgb(54 145 205 / 16%); --glow-2: rgb(188 222 232 / 6%);
        --shadow-md: 0 1px 2px rgb(0 0 0 / 30%), 0 8px 24px -8px rgb(0 0 0 / 50%);
        --shadow-lg: 0 2px 4px rgb(0 0 0 / 30%), 0 24px 48px -16px rgb(0 0 0 / 70%);
        color-scheme: dark;
      }
    }
    :root[data-theme="dark"] {
      --bg: #171717; --surface: #171717; --surface-2: #171717; --surface-3: #242424;
      --line: #2A2A2A; --line-strong: #363636; --border-control: #404040;
      --ink: #EEF4F6; --ink-2: #B7C3C8; --ink-3: #8B999F; --ink-disabled: #4E5C62;
      --accent: #3691CD; --accent-2: #5AA8DC; --accent-hover: #2A7DB4; --accent-pressed: #226A9B;
      --accent-soft: #14283A; --accent-soft-2: #1F4461; --accent-fg: #BCDEE8; --accent-text: #BCDEE8; --accent-ink: #1F2A30; --on-accent: #FFFFFF;
      --warn: #E6C27A;
      --success-bg: #16291F; --success-text: #A8D8BE; --warning-bg: #2E2512; --warning-text: #E6C27A;
      --error-bg: #2F1A1A; --error-text: #EDB0B0; --info-bg: #14283A; --info-text: #BCDEE8;
      --neutral-bg: #242424; --neutral-text: #8B999F;
      --glow-1: rgb(54 145 205 / 16%); --glow-2: rgb(188 222 232 / 6%);
      --shadow-md: 0 1px 2px rgb(0 0 0 / 30%), 0 8px 24px -8px rgb(0 0 0 / 50%);
      --shadow-lg: 0 2px 4px rgb(0 0 0 / 30%), 0 24px 48px -16px rgb(0 0 0 / 70%);
      color-scheme: dark;
    }
    * { box-sizing: border-box; }
    html, body, #root { height: 100%; margin: 0; }
    body {
      background: var(--bg); color: var(--ink);
      font: 14px/1.5 var(--font-sans);
      -webkit-font-smoothing: antialiased; overflow: hidden;
    }
    button { font: inherit; color: inherit; }
    :focus-visible { outline: 2px solid var(--accent-fg); outline-offset: 2px; border-radius: 8px; }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { transition-duration: 0ms !important; animation-duration: 0ms !important; }
    }

/* ---- base bits from app.tsx ---- */
@keyframes rise { from { opacity: 0; transform: translateY(6px); } }
.scrim { position: fixed; inset: 0; z-index: 50; display: flex; justify-content: center; align-items: flex-start; padding: 14vh 16px 16px; background: color-mix(in srgb, var(--ink) 18%, transparent); backdrop-filter: blur(2px); animation: fade .12s; }
@keyframes fade { from { opacity: 0; } }
.grow { flex: 1; min-width: 0; }
.strong { font-weight: 500; color: var(--ink); }
.icon-btn { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 10px; border: 1px solid var(--line); background: var(--surface); color: var(--ink-2); cursor: pointer; transition: background .15s, color .15s; }
.icon-btn:hover { color: var(--ink); background: var(--surface-3); }
.icon-btn.ghost { border-color: transparent; background: transparent; width: 32px; height: 32px; }
.icon-btn.ghost:hover { background: var(--surface-3); }
.btn-solid, .btn-soft, .btn-ghost { display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px; border-radius: 9px; font-size: 13px; font-weight: 500; cursor: pointer; }
.btn-solid { border: 0; background: var(--accent); color: var(--on-accent); }
.btn-soft { border: 1px solid var(--line); background: var(--surface); color: var(--ink); }
.btn-soft:hover { background: var(--surface-3); }
.btn-ghost { border: 0; background: none; color: var(--ink-3); }
.btn-ghost:hover { color: var(--ink); }
.dialog-x { position: absolute; top: 12px; right: 12px; z-index: 3; }
.nad-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; padding-top: 4px; }
.btn-solid.lg, .btn-soft.lg { height: 38px; padding: 0 16px; font-size: 14px; }
.btn-solid:hover:not(:disabled) { background: var(--accent-hover); }
.btn-solid:disabled { opacity: .45; cursor: not-allowed; }

/* ---- lanyard badge, drag physics ---- */
.lanyard-anchor { position: absolute; top: -18px; left: 0; right: 0; display: flex; justify-content: center; pointer-events: none; }
.lanyard { pointer-events: auto; transform-origin: 50% 0; transition: transform .7s cubic-bezier(.34, 1.56, .64, 1); cursor: grab; touch-action: none; user-select: none; -webkit-user-select: none; }
.lanyard.is-drag { transition: none; cursor: grabbing; }
.lanyard-sway { display: flex; flex-direction: column; align-items: center; transform-origin: 50% 0; animation: sway 6s ease-in-out infinite; }
.lanyard.is-drag .lanyard-sway { animation-play-state: paused; }
@keyframes sway { 0%, 100% { transform: rotate(-1.4deg); } 50% { transform: rotate(1.4deg); } }
.strap { position: relative; width: 24px; height: 92px; box-shadow: 0 2px 6px rgb(31 42 48 / 18%);
  background:
    repeating-linear-gradient(0deg, rgb(255 255 255 / 0) 0 2px, rgb(255 255 255 / 16%) 2px 3px),
    linear-gradient(90deg, color-mix(in srgb, var(--strap) 70%, #1F2A30) 0%, var(--strap) 22%, color-mix(in srgb, var(--strap) 65%, #fff) 50%, var(--strap) 78%, color-mix(in srgb, var(--strap) 70%, #1F2A30) 100%); }
.lanyard .strap { transition: height .7s cubic-bezier(.34, 1.56, .64, 1), width .7s cubic-bezier(.34, 1.56, .64, 1); }
.lanyard.is-drag .strap { transition: none; }
.strap::before, .strap::after { content: ""; position: absolute; top: 0; bottom: 0; border-left: 1px dashed rgb(255 255 255 / 65%); }
.strap::before { left: 3.5px; }
.strap::after { right: 3.5px; }
.clip { display: block; position: relative; z-index: 2; margin-top: -6px; filter: drop-shadow(0 2px 2px rgb(31 42 48 / 22%)); }
.badge { position: relative; width: 256px; margin-top: -16px; border-radius: 18px; background: #FFFFFF; color: #1F2A30; overflow: hidden;
  box-shadow: 0 1px 1px rgb(31 42 48 / 8%), 0 4px 10px -2px rgb(31 42 48 / 12%), 0 26px 50px -16px rgb(31 42 48 / 42%); }
/* laminate: hairline edge */
.badge::after { content: ""; position: absolute; inset: 0; border-radius: inherit; pointer-events: none;
  box-shadow: inset 0 0 0 1px rgb(255 255 255 / 70%), inset 0 0 0 1.5px rgb(31 42 48 / 6%); }
.badge-slot { position: absolute; top: 12px; left: 50%; z-index: 1; width: 40px; height: 8px; margin-left: -20px; border-radius: 4px;
  background: rgb(31 42 48 / 16%); box-shadow: inset 0 1px 2px rgb(31 42 48 / 40%), 0 1px 0 rgb(255 255 255 / 75%); }
.badge-brand { position: absolute; z-index: 1; top: 10px; left: 16px; font: 800 12px var(--font-display); letter-spacing: -.03em; color: rgb(31 42 48 / 55%); }
.badge-top { position: relative; display: grid; place-items: center; height: 188px; padding-top: 12px; transition: background .25s; }
.badge-body { padding: 14px 18px 12px; }
.badge-name { font: 700 24px/1.15 var(--font-display); letter-spacing: -.03em; overflow-wrap: anywhere; }
.badge-name.is-empty { color: #A3AFB5; }
.badge-handle { margin-top: 4px; font: 500 11px var(--font-mono); letter-spacing: .06em; text-transform: uppercase; color: var(--accent-fg); overflow-wrap: anywhere; }
.badge-foot { display: flex; justify-content: space-between; gap: 12px; padding: 10px 18px 14px; border-top: 1px dashed #E3ECEF; font: 11px var(--font-mono); white-space: nowrap; color: #5F6D73; }

/* ---- success screen: badge drop, copy, confetti, shine ---- */
.nad-stage.done { min-height: 480px; justify-content: flex-end; border-left: 0; border-bottom: 1px solid var(--line); }
.nad-done-copy { padding: 22px 24px 24px; text-align: center; }
.nad-done-copy h2 { margin: 0 0 6px; font: var(--display-weight) 26px/1.2 var(--font-display); letter-spacing: var(--display-track); }
.nad-done-copy p { margin: 0 auto 18px; max-width: 38ch; color: var(--ink-2); }
.nad-done-copy code { padding: 1px 6px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface-3); color: var(--ink); font: 500 13px var(--font-mono); }
.nad-done-copy .nad-actions { justify-content: center; }
.scrim.celebrate { flex-direction: column; align-items: stretch; justify-content: flex-end; padding: 0; overflow: hidden; background: rgb(12 15 17 / 78%); backdrop-filter: blur(6px); animation: fade .25s; }
.scrim.celebrate .dialog-x { position: fixed; top: 16px; right: 16px; color: #F4F7F8; }
.scrim.celebrate .confetti { position: fixed; top: 42%; }
.celebrate-stage { position: absolute; inset: 0; pointer-events: none; }
.celebrate-stage .lanyard-anchor { top: 0; animation: drop .9s cubic-bezier(.34, 1.56, .64, 1); }
.celebrate-stage .strap { height: clamp(24px, 16vh, 180px); }
@keyframes drop { from { transform: translateY(-110%); } }
.celebrate-copy { position: relative; z-index: 3; padding: 0 16px max(40px, 6vh); color: #F4F7F8; animation: rise .4s .35s ease-out backwards; }
.celebrate-copy h2 { font-size: 32px; }
.celebrate-copy p { color: rgb(244 247 248 / 72%); }
.celebrate-copy code { border-color: rgb(255 255 255 / 16%); background: rgb(255 255 255 / 8%); color: #F4F7F8; }
@media (max-height: 720px) { .celebrate-stage .strap { height: 20px; } .celebrate-copy h2 { font-size: 26px; } }
.confetti { position: absolute; left: 50%; top: 60%; width: 0; height: 0; pointer-events: none; z-index: 2; }
.confetti i { position: absolute; left: 0; top: 0; width: var(--w); height: var(--h); background: var(--c); opacity: 0; animation: burst var(--t) cubic-bezier(.2, .7, .35, 1) var(--d) forwards; }
@keyframes burst {
  0% { opacity: 1; transform: translate(0, 0) rotate(0deg) scale(.5); }
  45% { opacity: 1; transform: translate(var(--x), var(--y)) rotate(calc(var(--r) * .5)) scale(1); }
  100% { opacity: 0; transform: translate(calc(var(--x) * 1.15), calc(var(--y) + 170px)) rotate(var(--r)) scale(1); }
}
/* edit mode */
.badge-shine { position: absolute; inset: 0; z-index: 2; pointer-events: none; transform: translateX(-120%);
  background: linear-gradient(105deg, transparent 35%, rgb(255 255 255 / 80%) 50%, transparent 65%); animation: shine .9s ease-out forwards; }
@keyframes shine { to { transform: translateX(120%); } }

/* ---- demo page (standalone only) ---- */
.demo { display: grid; place-items: center; min-height: 100%; padding: 16px; text-align: center; }
.demo-closed p { margin: 0 0 16px; color: var(--ink-2); }
.demo-closed code { padding: 1px 6px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface-3); font: 500 13px var(--font-mono); }
#boot-error { position: fixed; inset: 16px; padding: 16px; border-radius: 12px; background: #2a0f0f; color: #ffd7d7; font: 12px/1.5 var(--font-mono); white-space: pre-wrap; overflow: auto; }
  </style>
</head>
<body>
  <div id="root"></div>

  <script src="https://unpkg.com/react@18.3.1/umd/react.production.min.js" crossorigin></script>
  <script src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js" crossorigin></script>
  <script src="https://unpkg.com/@babel/standalone@7.26.4/babel.min.js" crossorigin></script>

  <!-- App source (TSX). Babel strips types + JSX in the browser. -->
  <script type="text/plain" id="app-src">
const { useState, useRef, useMemo } = React;

interface Agent {
  id: string; name: string; desc: string; hue: string;
  handle?: string; look?: number; tint?: string; model?: string; instructions?: string;
  builtin?: boolean;  // ships with the workspace: instructions and model are editable; name, look and removal are not
}

// Agent looks: shaded vector robots drawn in SVG (Robot). Tints are the badge backgrounds; `dot` doubles as the agent hue.
interface Look { name: string; body: string; visor: string; glow: string; face: "line" | "eyes" | "happy"; acc?: string; accColor?: string }
const LOOKS: Look[] = [
  { name: "Graphite", body: "#3A4750", visor: "#1F2A30", glow: "#BCDEE8", face: "line" },
  { name: "Antenna", body: "#F4F7F8", visor: "#2B3F6B", glow: "#BCDEE8", face: "eyes", acc: "antenna" },
  { name: "Navy", body: "#2E4470", visor: "#16213A", glow: "#BCDEE8", face: "line" },
  { name: "Listener", body: "#D5DDE1", visor: "#2B3F6B", glow: "#BCDEE8", face: "happy", acc: "headphones", accColor: "#3691CD" },
  { name: "Scout", body: "#D8C3A0", visor: "#3A4750", glow: "#EBCB8B", face: "line", acc: "cap", accColor: "#E07B6E" },
  { name: "Chef", body: "#F4F7F8", visor: "#2B3F6B", glow: "#BCDEE8", face: "eyes", acc: "chef" },
  { name: "Builder", body: "#F4F7F8", visor: "#3A4750", glow: "#EBCB8B", face: "eyes", acc: "hardhat", accColor: "#F2C94C" },
  { name: "Scarf", body: "#3A4750", visor: "#1F2A30", glow: "#F0B999", face: "happy", acc: "scarf", accColor: "#E07B6E" },
  { name: "Mint", body: "#BFE3CF", visor: "#1F2A30", glow: "#A9D5BE", face: "eyes", acc: "antenna" },
  { name: "Lilac", body: "#CFC8EC", visor: "#2B3F6B", glow: "#C4BDE3", face: "happy", acc: "bow", accColor: "#F0A3B5" },
  { name: "Peach", body: "#F5C7A8", visor: "#3A4750", glow: "#F0B999", face: "line", acc: "headphones", accColor: "#3A4750" },
  { name: "Captain", body: "#2E4470", visor: "#16213A", glow: "#BCDEE8", face: "eyes", acc: "cap", accColor: "#3691CD" },
];
const TINTS = [
  { id: "ice", label: "Ice", bg: "#EAF5F8", dot: "#3691CD" },
  { id: "mint", label: "Mint", bg: "#E7F4ED", dot: "#A9D5BE" },
  { id: "butter", label: "Butter", bg: "#FFF3D9", dot: "#EBCB8B" },
  { id: "peach", label: "Peach", bg: "#FBE9DD", dot: "#F0B999" },
  { id: "lilac", label: "Lilac", bg: "#EFEDF8", dot: "#C4BDE3" },
];
const MODELS = [
  { id: "opus", label: "Claude Opus 5.5", short: "opus 5.5" },
  { id: "sonnet", label: "Claude Sonnet 5.5", short: "sonnet 5.5" },
  { id: "haiku", label: "Claude Haiku 4.5", short: "haiku 4.5" },
];
const tintOf = (id?: string) => TINTS.find(t => t.id === id) || TINTS[0];
const modelOf = (id?: string) => MODELS.find(m => m.id === id) || MODELS[0];
// The editable fields of an agent, with defaults filled in, so a draft can be compared against what's saved.
const agentFields = (a: Agent) => ({
  name: a.name, desc: a.desc, instructions: a.instructions || "", look: a.look ?? 2,
  tint: a.tint || "ice", model: modelOf(a.model).id,
});
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 20);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
// Mix a hex colour toward white (amt > 0) or black (amt < 0); used for the robots' shading.
const tone = (hex: string, amt: number) => {
  const n = parseInt(hex.slice(1), 16), t = amt < 0 ? 0 : 255, k = Math.abs(amt);
  const ch = (sh: number) => Math.round(((n >> sh) & 255) + (t - ((n >> sh) & 255)) * k).toString(16).padStart(2, "0");
  return "#" + ch(16) + ch(8) + ch(0);
};

// Only the icon this screen uses.
const PATHS: Record<string, string> = { x: "M18 6 6 18M6 6l12 12" };

function Icon({ name, size = 18, stroke = 1.75 }: { name: string; size?: number; stroke?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}

/* ---------------------------------------------------------------- new agent */

function Robot({ look, size = 64 }: { look: number; size?: number }) {
  const L = LOOKS[look] || LOOKS[0];
  // Gradient/filter ids must be unique per instance; useId output has colons, which url(#…) dislikes.
  const id = "rb" + React.useId().replace(/[^a-zA-Z0-9]/g, "");
  const u = (n: string) => `url(#${id}-${n})`;
  const edge = tone(L.body, -.45);
  const acc = L.accColor || L.body;
  const accEdge = tone(acc, -.4);
  const limb = { fill: u("limb"), stroke: edge, strokeWidth: 1.5 };
  const accLine = { fill: u("acc"), stroke: accEdge, strokeWidth: 1.4, strokeLinejoin: "round" as const };
  return (
    <svg width={size} height={size} viewBox="0 0 120 120" aria-hidden="true" shapeRendering="geometricPrecision">
      <defs>
        <linearGradient id={`${id}-body`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={tone(L.body, .38)} />
          <stop offset=".55" stopColor={L.body} />
          <stop offset="1" stopColor={tone(L.body, -.3)} />
        </linearGradient>
        <linearGradient id={`${id}-limb`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={tone(L.body, -.06)} />
          <stop offset="1" stopColor={tone(L.body, -.34)} />
        </linearGradient>
        <radialGradient id={`${id}-sheen`} cx=".3" cy=".2" r=".6">
          <stop offset="0" stopColor="#fff" stopOpacity=".6" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${id}-visor`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={tone(L.visor, .24)} />
          <stop offset="1" stopColor={tone(L.visor, -.38)} />
        </linearGradient>
        <radialGradient id={`${id}-screen`} cx=".5" cy=".55" r=".6">
          <stop offset="0" stopColor={L.glow} stopOpacity=".3" />
          <stop offset="1" stopColor={L.glow} stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${id}-acc`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={tone(acc, .32)} />
          <stop offset="1" stopColor={tone(acc, -.22)} />
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
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>

      <ellipse cx="60" cy="109" rx="36" ry="6.5" fill={u("shadow")} />
      {/* pack and legs sit behind the shell */}
      <rect x="13" y="50" width="20" height="38" rx="9" {...limb} />
      <rect x="37" y="82" width="19" height="25" rx="8.5" {...limb} />
      <rect x="64" y="82" width="19" height="25" rx="8.5" {...limb} />
      <path d="M41 101.5h11M68 101.5h11" stroke="#fff" strokeOpacity=".18" strokeWidth="2" strokeLinecap="round" />

      {/* shell: base gradient, soft top-left sheen, right rim light */}
      <rect x="24" y="22" width="72" height="72" rx="31" fill={u("body")} stroke={edge} strokeWidth="1.5" />
      <rect x="24" y="22" width="72" height="72" rx="31" fill={u("sheen")} />
      <path d="M90 46c3.6 10 3.4 24-2 34" fill="none" stroke="#fff" strokeOpacity=".24" strokeWidth="3" strokeLinecap="round" />
      {L.acc !== "scarf" && <circle cx="73" cy="81" r="2.2" fill={L.glow} filter={u("glow")} />}

      {L.acc === "scarf" && (
        <g>
          <path d="M72 79l3.5 21c.4 2.2 3.2 2.8 4.6 1.1L87 93l-5.5-15z" {...accLine} />
          <path d="M77 97l1.2 4M81 95.5l1.6 3.6" stroke={accEdge} strokeWidth="1.2" strokeLinecap="round" />
          <path d="M25 71c20 8.5 50 8.5 70 0v9c-20 8.5-50 8.5-70 0z" {...accLine} />
          <path d="M31 75c16 5.5 42 5.5 58 0" fill="none" stroke="#fff" strokeOpacity=".35" strokeWidth="1.6" strokeLinecap="round" />
        </g>
      )}

      {/* visor: bezel, glass, screen bloom, glowing face, glare */}
      <rect x="35" y="36" width="54" height="33" rx="15" fill={tone(L.visor, -.55)} />
      <rect x="37.5" y="38.5" width="49" height="28" rx="12.5" fill={u("visor")} />
      <rect x="37.5" y="38.5" width="49" height="28" rx="12.5" fill={u("screen")} />
      <g filter={u("glow")}>
        {L.face === "line" && <rect x="51" y="50" width="22" height="5.6" rx="2.8" fill={L.glow} />}
        {L.face === "eyes" && <><circle cx="52" cy="53" r="4.1" fill={L.glow} /><circle cx="72" cy="53" r="4.1" fill={L.glow} /></>}
        {L.face === "happy" && <path d="M47 55.5q5-6.2 10 0M67 55.5q5-6.2 10 0" fill="none" stroke={L.glow} strokeWidth="3.2" strokeLinecap="round" />}
      </g>
      {L.face === "eyes" && <><circle cx="53.4" cy="51.6" r="1.2" fill="#fff" /><circle cx="73.4" cy="51.6" r="1.2" fill="#fff" /></>}
      <path d="M43.5 45c3-2.8 8-3.8 13-3.6" fill="none" stroke="#fff" strokeOpacity=".6" strokeWidth="2.6" strokeLinecap="round" />
      <circle cx="80.5" cy="61" r="1.5" fill="#fff" fillOpacity=".35" />

      {L.acc === "antenna" && (
        <g>
          <path d="M60 23V10" stroke={edge} strokeWidth="3" strokeLinecap="round" />
          <rect x="54.5" y="20" width="11" height="4.5" rx="2.25" fill={tone(L.body, -.2)} stroke={edge} strokeWidth="1.2" />
          <circle cx="60" cy="8.5" r="9" fill={L.glow} opacity=".28" />
          <circle cx="60" cy="8.5" r="5.2" fill={L.glow} stroke={tone(L.glow, -.4)} strokeWidth="1.2" />
          <circle cx="58.3" cy="6.8" r="1.6" fill="#fff" opacity=".85" />
        </g>
      )}
      {L.acc === "cap" && (
        <g>
          <path d="M80 33.5c10-1 21 0 27 3 2 1.2 1 4-1.5 4-8 0-17-1-26-2.5z" {...accLine} fill={tone(acc, -.1)} />
          <path d="M26 38C26 10 94 10 94 38c-10-3-58-3-68 0z" {...accLine} />
          <path d="M60 15v21" stroke={accEdge} strokeOpacity=".45" strokeWidth="1.2" />
          <path d="M36 28c5-7 12-10 19-11" fill="none" stroke="#fff" strokeOpacity=".4" strokeWidth="2.2" strokeLinecap="round" />
          <circle cx="60" cy="14.5" r="2.6" fill={tone(acc, -.15)} stroke={accEdge} strokeWidth="1" />
        </g>
      )}
      {L.acc === "hardhat" && (
        <g>
          <path d="M26 33C26 4 94 4 94 33z" {...accLine} />
          <rect x="55" y="7.5" width="10" height="25" rx="4" fill={tone(acc, .3)} stroke={accEdge} strokeWidth="1.2" />
          <rect x="17" y="30" width="86" height="7" rx="3.5" {...accLine} fill={tone(acc, -.08)} />
          <path d="M34 24c3-7 9-11 16-13" fill="none" stroke="#fff" strokeOpacity=".45" strokeWidth="2.2" strokeLinecap="round" />
        </g>
      )}
      {L.acc === "chef" && (
        <g>
          <g fill={u("chef")}>
            <circle cx="44" cy="18" r="10.5" /><circle cx="76" cy="18" r="10.5" /><circle cx="60" cy="13" r="12.5" />
          </g>
          <path d="M41 11c2-2 5-3 8-3M56 5c2-1 5-1.4 7-1" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
          <rect x="36" y="18" width="48" height="15" rx="5" fill={u("chef")} stroke="#B9C4CA" strokeWidth="1.2" />
          <path d="M48 21v9M60 21v9M72 21v9" stroke="#B9C4CA" strokeOpacity=".7" strokeWidth="1" strokeLinecap="round" />
        </g>
      )}
      {L.acc === "headphones" && (
        <g>
          <path d="M22 54C22 10 98 10 98 54" fill="none" stroke={tone(acc, -.4)} strokeWidth="7" strokeLinecap="round" />
          <path d="M22 54C22 10 98 10 98 54" fill="none" stroke={tone(acc, .25)} strokeOpacity=".6" strokeWidth="2" strokeLinecap="round" />
          <rect x="13" y="43" width="17" height="27" rx="7.5" {...accLine} />
          <rect x="90" y="43" width="17" height="27" rx="7.5" {...accLine} />
          <path d="M17 49v10M94 49v10" stroke="#fff" strokeOpacity=".45" strokeWidth="2" strokeLinecap="round" />
        </g>
      )}
      {L.acc === "bow" && (
        <g>
          <path d="M78 20l-11-7c-2-1.2-4 .4-4 2.6v9c0 2.2 2.2 3.4 4 2.4z" {...accLine} />
          <path d="M78 20l11-7c2-1.2 4 .4 4 2.6v9c0 2.2-2.2 3.4-4 2.4z" {...accLine} />
          <circle cx="78" cy="20" r="3.6" {...accLine} fill={tone(acc, -.12)} />
          <path d="M66.5 16.5l3 1.8M89.5 16.5l-3 1.8" stroke="#fff" strokeOpacity=".5" strokeWidth="1.6" strokeLinecap="round" />
        </g>
      )}
    </svg>
  );
}

// Lanyard hardware: crimp end for the ribbon, swivel, split ring and a clear tab that feeds into the badge slot.
function Clip() {
  const id = "cl" + React.useId().replace(/[^a-zA-Z0-9]/g, "");
  const metal = `url(#${id}-m)`;
  return (
    <svg className="clip" width="56" height="70" viewBox="0 0 56 70" aria-hidden="true" shapeRendering="geometricPrecision">
      <defs>
        <linearGradient id={`${id}-m`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#8A969D" /><stop offset=".35" stopColor="#F4F7F8" />
          <stop offset=".62" stopColor="#B7C1C6" /><stop offset="1" stopColor="#77838A" />
        </linearGradient>
        <linearGradient id={`${id}-t`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FFFFFF" stopOpacity=".85" /><stop offset="1" stopColor="#EAF2F5" stopOpacity=".6" />
        </linearGradient>
      </defs>
      <rect x="20" y="35" width="16" height="35" rx="4" fill={`url(#${id}-t)`} stroke="rgb(31 42 48 / 24%)" strokeWidth=".8" />
      <path d="M23 39v27" stroke="#fff" strokeOpacity=".9" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="28" cy="47" r="3.3" fill={metal} stroke="#6B777E" strokeWidth=".8" />
      <ellipse cx="28" cy="29" rx="8.5" ry="11" fill="none" stroke="#66727A" strokeWidth="5" />
      <ellipse cx="28" cy="29" rx="8.5" ry="11" fill="none" stroke={metal} strokeWidth="3.2" />
      <rect x="24" y="12" width="8" height="7" rx="1.6" fill={metal} stroke="#6B777E" strokeWidth=".8" />
      <rect x="13.5" y="0" width="29" height="13.5" rx="3" fill={metal} stroke="#6B777E" strokeWidth=".8" />
      <path d="M17 4.5h22M17 8.5h22" stroke="#6B777E" strokeOpacity=".45" strokeWidth=".8" />
    </svg>
  );
}

// Lanyard ID badge. Drag it and the strap stays pinned at the top: the lanyard pivots around its anchor
// and the strap stretches (with rubber-band resistance) so the grabbed point follows the pointer. Springs back on release.
function Badge({ name, handle, look, tint, model, tag, shine = 0 }: {
  name: string; handle: string; look: number; tint: string; model: string; tag?: string; shine?: number;
}) {
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  // Resting strap length and the grabbed point's distance below the anchor, measured when a drag starts.
  const rest = useRef({ len: 92, r: 200 });
  const strapRef = useRef<HTMLSpanElement>(null);
  const end = () => { origin.current = null; setDrag(null); };

  let swing: any, stretch: any;
  if (drag) {
    const { len, r } = rest.current;
    const dy = drag.y > 0 ? 220 * Math.tanh(drag.y / 280) : -len * .25 * Math.tanh(-drag.y / 90);
    const dx = 260 * Math.tanh(drag.x / 320);
    const reach = Math.hypot(dx, r + dy);
    const h = Math.max(len * .75, len + reach - r);
    swing = { transform: `rotate(${-Math.atan2(dx, r + dy) * 180 / Math.PI}deg)` };
    stretch = { height: h, width: clamp(24 * Math.sqrt(len / h), 16, 24) };
  }
  return (
    <div className="lanyard-anchor">
      <div className={"lanyard" + (drag ? " is-drag" : "")} style={swing} aria-hidden="true"
        onPointerDown={e => {
          const el = e.currentTarget;
          el.setPointerCapture(e.pointerId);
          rest.current = { len: strapRef.current?.offsetHeight || 92, r: Math.max(40, e.clientY - el.getBoundingClientRect().top) };
          origin.current = { x: e.clientX, y: e.clientY }; setDrag({ x: 0, y: 0 });
        }}
        onPointerMove={e => { const o = origin.current; if (o) setDrag({ x: e.clientX - o.x, y: e.clientY - o.y }); }}
        onPointerUp={end} onPointerCancel={end}>
        <div className="lanyard-sway">
          <span ref={strapRef} className="strap" style={{ "--strap": tintOf(tint).dot, ...stretch } as any} />
          <Clip />
          <div className="badge">
            <span className="badge-slot" />
            {shine > 0 && <span key={shine} className="badge-shine" />}
            <span className="badge-brand">truex</span>
            <div className="badge-top" style={{ background: tintOf(tint).bg }}><Robot look={look} size={150} /></div>
            <div className="badge-body">
              <div className={"badge-name" + (name.trim() ? "" : " is-empty")}>{name.trim() || "Unnamed"}</div>
              <div className="badge-handle">@{handle || "handle"}{tag && ` · ${tag}`}</div>
            </div>
            <div className="badge-foot"><span>{modelOf(model).short}</span></div>
          </div>
        </div>
      </div>
    </div>
  );
}

const CONFETTI_COLORS = ["#3691CD", "#BCDEE8", "#A9D5BE", "#EBCB8B", "#F0B999", "#C4BDE3", "#F2C94C"];

function Confetti() {
  const bits = useMemo(() => Array.from({ length: 56 }, (_, i) => {
    const a = Math.random() * Math.PI * 2, dist = 110 + Math.random() * 220, dot = i % 3 === 0;
    return {
      "--x": `${Math.round(Math.cos(a) * dist)}px`, "--y": `${Math.round(Math.sin(a) * dist * .75 - 70)}px`,
      "--r": `${Math.round(Math.random() * 720 - 360)}deg`, "--c": CONFETTI_COLORS[i % CONFETTI_COLORS.length],
      "--w": dot ? "7px" : `${5 + Math.round(Math.random() * 4)}px`, "--h": dot ? "7px" : `${3 + Math.round(Math.random() * 9)}px`,
      "--d": `${Math.round(Math.random() * 140)}ms`, "--t": `${1500 + Math.round(Math.random() * 900)}ms`,
      borderRadius: dot ? "50%" : "2px",
    } as any;
  }), []);
  return <div className="confetti" aria-hidden="true">{bits.map((s, i) => <i key={i} style={s} />)}</div>;
}

/* ---------------------------------------------------------------- agent created */

// Success screen shown right after "Create agent". In app.tsx this is the `if (created) return (...)` branch of AgentDialog.
// No card: the badge drops from the top of the viewport over a dark scrim, confetti bursts, the badge stays draggable.
function AgentCreated({ created, onClose, onSayHi }: { created: Agent; onClose: () => void; onSayHi: (a: Agent) => void }) {
  return (
    <div className="scrim celebrate" role="dialog" aria-modal="true" aria-labelledby="nad-title"
      onKeyDown={e => { if (e.key === "Escape") onClose(); }}>
      <button className="icon-btn ghost dialog-x" onClick={onClose} aria-label="Close"><Icon name="x" size={15} /></button>
      <Confetti />
      <div className="celebrate-stage">
        <Badge name={created.name} handle={created.handle!} look={created.look!} tint={created.tint!} model={created.model!} tag="new specialist" />
      </div>
      <div className="nad-done-copy celebrate-copy">
        <h2 id="nad-title">{created.name} is on the team</h2>
        <p>Mention <code>@{created.handle}</code> anywhere to wake it. Drag the badge around while you're here.</p>
        <div className="nad-actions">
          <button className="btn-solid lg" onClick={() => onSayHi(created)} autoFocus>Say hi to {created.name}</button>
          <button className="btn-soft lg" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- demo */

// Sample agent, shaped exactly like the one AgentDialog's submit() builds.
const SAMPLE: Agent = {
  id: "agent-demo", handle: "researchscout", name: "Research Scout", desc: "Finds and summarises sources",
  hue: tintOf("mint").dot, look: 4, tint: "mint", model: "sonnet", instructions: "",
};

// In app.tsx, "Say hi" closes the dialog, starts a new chat with this agent and pre-fills the composer
// with "@handle hi, ". Here it just shows that draft. Replay remounts the screen so the drop and confetti run again.
function App() {
  const [run, setRun] = useState(1);
  const [open, setOpen] = useState(true);
  const [draft, setDraft] = useState("");
  return (
    <main className="demo">
      {open
        ? <AgentCreated key={run} created={SAMPLE} onClose={() => { setDraft(""); setOpen(false); }}
            onSayHi={a => { setDraft(`@${a.handle} hi, `); setOpen(false); }} />
        : <div className="demo-closed">
            <p>{draft ? <>Composer draft: <code>{draft}</code></> : "Closed."}</p>
            <button className="btn-solid lg" onClick={() => { setRun(n => n + 1); setOpen(true); }} autoFocus>Replay</button>
          </div>}
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
  </script>
  <script>
    (() => {
      try {
        const { code } = Babel.transform(document.getElementById("app-src").textContent, {
          filename: "app.tsx",
          presets: [["typescript", { isTSX: true, allExtensions: true }], ["react", { runtime: "classic" }]],
        });
        new Function("React", "ReactDOM", code)(React, ReactDOM);
      } catch (err) {
        const el = document.createElement("pre");
        el.id = "boot-error";
        el.textContent = String(err && err.stack || err);
        document.body.appendChild(el);
      }
    })();
  </script>
</body>
</html>
```
