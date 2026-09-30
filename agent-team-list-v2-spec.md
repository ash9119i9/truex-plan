# Agent team list v2: design spec

A pinned board of agent cards. Each agent is a tilted card on grid paper with one pushpin. There is no string between the pins (that is the only visual change from `agent-team-list.html`).

- Visual reference: `design/agent-team-list-v2.html`. Its full source is in section 9, so this file stands alone.
- Target: replace `AgentsView` in `app.tsx` (currently the `.polaroids` board, `app.tsx:1251`).
- Everything below is exact: copy the values, markup and code as written.

---

## 1. What changes in app.tsx

| Area | Today (`app.tsx`) | v2 |
|---|---|---|
| Header | `bp-top` brand + arrow button, title "Meet the team: truex style" | Brand left, blue **New agent** button right. Title "What the *team* can help with" with "team" in hand script |
| Subtitle | `4 specialists · 0 built by you` | `{n} specialists · {k} built by you. Pin one to the chat, or build your own.` |
| Filter | Outline pills (`bp-pill`) | Segmented control (`tb-pills`) |
| Card | Square polaroid, whole card tilts on hover | Coloured frame card, 5:4 photo, tilt stays fixed on hover (shadow + robot move only) |
| Built-in marker | Yellow sticky note | "built-in" lock chip in photo, bottom-left |
| Pin | Red pin only on the agent in chat | Pin on **every** card: blue by default, red on the agent in chat |
| String | n/a in app; present in v1 prototype | **None** |
| Card text | Handle uppercase, model only | Handle lowercase mono, description, `model · reasoning`, Chat button |
| Footer | `The team` + filter tags, count | Filter tag, count tag |

Nothing else in the app changes. `AgentDialog`, `Robot`, `tintOf`, `modelOf`, `inkOn`, `TILTS`, `pad2` are reused as they are.

---

## 2. Design tokens

Global tokens already exist in `index.html` and are used as-is: `--bg --surface --surface-3 --line --line-strong --ink --ink-2 --ink-3 --accent --accent-2 --accent-soft --accent-fg --on-accent --success-bg --success-text --shadow-sm --font-sans --font-mono`.

New tokens, scoped to `.tb-root`:

| Token | Light | Dark | Use |
|---|---|---|---|
| `--font-hand` | `"Caveat", "Segoe Print", cursive` | same | Captions, script word, note |
| `--board` | `#FFFFFF` | `#161718` | Board fill |
| `--grid` | `rgb(54 145 205 / 9%)` | `rgb(188 222 232 / 5%)` | 24px minor grid |
| `--grid-major` | `rgb(54 145 205 / 16%)` | `rgb(188 222 232 / 9%)` | 96px major grid |
| `--doodle` | `#3691CD` | `#5AA8DC` | Bolt, squiggle, "build your own" |
| `--shadow-card` | `0 1px 2px rgb(31 42 48 / 6%), 0 14px 28px -12px rgb(31 42 48 / 28%)` | `0 1px 2px rgb(0 0 0 / 35%), 0 14px 28px -12px rgb(0 0 0 / 70%)` | Card at rest |
| `--shadow-lift` | `0 2px 4px rgb(31 42 48 / 6%), 0 22px 40px -14px rgb(31 42 48 / 36%)` | `0 2px 4px rgb(0 0 0 / 35%), 0 22px 40px -14px rgb(0 0 0 / 80%)` | Card on hover |

Per-card CSS variables (set inline on each `<li>`):

| Var | Value |
|---|---|
| `--tint` | `tintOf(a.tint).bg` (photo background) |
| `--frame` | `tintOf(a.tint).dot` (frame colour) |
| `--cap` | `inkOn(tintOf(a.tint).dot)` (caption colour: `#FFFFFF` or `#1F2A30`) |
| `--tilt` | `TILTS[i % 8]` + `deg`, `TILTS = [-4, 3, -2.5, 4.5, -3.5, 2, -1.5, 3.5]` |
| `--i` | index, drives the stagger delay |

Tints (from `app.tsx`):

| id | bg (photo) | dot (frame) | caption ink |
|---|---|---|---|
| ice | `#EAF5F8` | `#3691CD` | `#FFFFFF` |
| mint | `#E7F4ED` | `#A9D5BE` | `#1F2A30` |
| butter | `#FFF3D9` | `#EBCB8B` | `#1F2A30` |
| peach | `#FBE9DD` | `#F0B999` | `#1F2A30` |
| lilac | `#EFEDF8` | `#C4BDE3` | `#1F2A30` |

Pin colours (fixed, same in both themes):

| Pin | Highlight (0) | Mid (.45) | Shadow (1) |
|---|---|---|---|
| Blue (default) | `#8CC8F0` | `#3691CD` | `#1D5A86` |
| Red (in chat) | `#FF8A80` | `#E5322D` | `#9E1712` |

Fonts: already loaded by `index.html` (Figtree 400–800, JetBrains Mono 400/500, Caveat 600/700).

---

## 3. Layout and measurements

Page (`.tb-root`): max-width 1180px, centred, padding `24px 16px 56px`.

| Element | Spec |
|---|---|
| Top bar | flex, space-between, gap 12px. Brand: mono 12px, `--ink-3`, letter-spacing .02em. Button: 36px tall, padding 0 14px, radius 10px, `--accent` fill, white, weight 600, gap 6px, plus icon 14px |
| Hero | margin `28px 0 22px`. H1: Figtree 800, `clamp(30px, 5vw, 48px)`, line-height 1.05, letter-spacing -.035em, balanced wrap. Script word: Caveat 700 at 1.3em, `--accent`, rotate(-4deg) translateY(2px), margin 0 .04em. Subtitle: 15px, `--ink-2`, margin-top 10px |
| Tools | flex-wrap, gap 10px, margin-bottom 16px. Search: flex `1 1 260px`, max 380px, 38px tall, radius 10px, border `--line-strong`, left icon 15px at 12px, text padding-left 36px. Focus: border `--accent` + 3px `--accent-soft` ring |
| Segmented filter | padding 3px, gap 2px, radius 11px, `--surface-3` fill, 1px `--line` border. Option: 30px tall, padding 0 12px, radius 8px, `--ink-2`, weight 500. Selected: `--surface` fill, `--ink`, weight 600, `--shadow-sm` |
| Board | radius 22px, 1px `--line` border, padding `48px 28px 36px`, overflow hidden, grid paper (major 96px, minor 24px lines, 1px, offset -1px) |
| Card grid | `repeat(auto-fill, minmax(220px, 1fr))`, gap 56px row / 32px column |
| Card | rotated `--tilt` around top-centre (`transform-origin: 50% 0`) |
| Frame | `--frame` fill, radius 18px, padding `10px 10px 0`, `--shadow-card` |
| Photo | full width, aspect 5:4, radius 11px, `--tint` fill with white radial highlight (`120% 90% at 30% 20%`, 70% → transparent 60%), 1px inset hairline `rgb(31 42 48 / 8%)` |
| Robot | 62% of photo width, centred |
| Lock chip | photo bottom-left 8px, padding 2px 8px, pill, `rgb(255 255 255 / 80%)`, `#5F6D73`, 11px 600, lock icon 10px |
| Edit hint | photo bottom-right 8px, padding 3px 8px, pill, `rgb(255 255 255 / 92%)`, `#1F2A30`, 12px 600, pencil 12px. Hidden until photo hover/focus |
| Caption | Caveat 700 26px/1.05, `--cap`, centred, padding `8px 4px 12px`, rotate(-2deg), wraps anywhere |
| Pin | 20px head (r=10) centred on card top-centre, 4px below the card's top edge; drawn upright (counter-rotated) |
| Info block | padding `12px 4px 0`, counter-rotated so text is straight |
| Handle row | mono 12px `--ink-3`, gap 8px. "in chat" badge: pill, padding 1px 8px, `--success-bg` / `--success-text`, 11px 600, 6px pulsing dot |
| Description | `--ink-2`, margin `4px 0 10px` |
| Foot | flex space-between, gap 8px. Meta: mono 11px `--ink-3`. Chat button: 30px, padding 0 12px, radius 8px, 1px `--line-strong`, weight 600 |
| New-agent card | frame is a button: transparent, 2px dashed `--line-strong`, padding 10px. Empty photo 5:4 `--surface-3`, 44px round `--accent` plus. Caption "New agent" in `--ink-2`, padding-bottom 4px. Note "build your own" + arrow: Caveat 22px `--doodle`, rotate(-3deg), margin `8px 0 0 12px` |
| Doodles | bolt 54×64 at top 12px / right 18px; squiggle 90×30 at bottom 10px / left 14px; `--doodle`, opacity .8, behind cards |
| Board footer | margin-top 14px, space-between, mono 12px `--ink-3`. Tags: padding 3px 9px, pill, 1px `--line`, `--surface` |

Layering inside the board: doodles (z 0) → cards (z 1) → pins (z 3, above the frame).

---

## 4. States

| State | Behaviour |
|---|---|
| Default | Blue pin, "Chat" button enabled |
| In chat (`a.id === current.id`) | Red pin, "in chat" badge with pulsing dot in handle row, button reads "Chatting" and is disabled (`--ink-3`, `--surface-3` fill) |
| Built-in (`a.builtin`) | Lock chip "built-in" in the photo. Screen readers get " · built-in" after the handle |
| Hover card | Shadow goes to `--shadow-lift`; robot moves up 4px and scales 1.04. Card and pin do not move |
| Hover/focus photo | Edit hint fades in (opacity 0 → 1, translateY 4px → 0, .15s) |
| Chat button hover | Border `--accent`, text `--accent-fg` |
| New-agent hover | Dashed border turns `--accent` |
| Filter "Built-in" | New-agent card hidden |
| Search active | New-agent card hidden |
| Search with no results | Board shows one centred row: **No agents match "{query}"** + "Clear search" button (resets query) |
| Count tag | `pad2(shown)/pad2(total)`, e.g. `04/06`; `aria-label="4 of 6 agents shown"` |

Filter logic (unchanged from app): `kind === "all" || (kind === "builtin") === !!a.builtin`, and `${name} ${handle || id} ${desc}` includes the lowercased trimmed query.

---

## 5. Interactions

| Action | Calls |
|---|---|
| Click photo | `onEdit(agent)` (opens `AgentDialog` in edit mode) |
| Click Chat | `onChat(agent)` |
| Click **New agent** (top) or the new-agent card | `onNew()` |
| Type in search | filters live |
| Click filter option | sets `kind` |
| Clear search | `setQ("")` |

---

## 6. Motion

| Motion | Spec |
|---|---|
| Card entrance | `tb-pin-in`: from opacity 0, translateY(-14px), rotate(2 × tilt) → rest. .5s `cubic-bezier(.2,.9,.3,1.2)`, delay `--i × 60ms`, fill both |
| Frame shadow | .2s ease |
| Robot hover | .3s `cubic-bezier(.2,.9,.3,1.2)` |
| Live dot | opacity 1 → .35 → 1, 1.6s ease-in-out, infinite |
| Reduced motion | no entrance, no pulse, no robot transition |

---

## 7. Responsive (≤ 560px)

- Board padding `40px 14px 28px`.
- Grid: 2 equal columns, gap 44px / 14px.
- Caption 19px, padding `6px 2px 8px`.
- Foot stacks (button full width), meta line hidden, doodles hidden.

---

## 8. Accessibility

- Photo is a `<button>` with `aria-label="Edit {name}"`; the robot, lock chip, edit hint, pins and doodles are `aria-hidden`.
- Filter is `role="radiogroup"` with `role="radio"` + `aria-checked` options.
- Search input has `aria-label="Search agents"`.
- Focus ring: 2px `--accent` outline, 2px offset (the app's global focus style).
- Board is a `<section aria-label="Agent team">`.
- Caption white-on-`#3691CD` is only used at 26px/19px bold (large text).

---

## 9. Implementation for app.tsx

### 9.1 Agent type (optional field)

The card meta line shows reasoning effort. Add it to `interface Agent` (`app.tsx:14`):

```ts
  reasoning?: "Low" | "Medium" | "High";  // shown on the team board; "default" when unset
```

### 9.2 Pin and glyphs

Place these just above `AgentsView`. With no string to connect them, each pin lives inside its own card, so no measuring, `ResizeObserver` or overlay SVG is needed. The pin is counter-rotated, so it renders exactly like the prototype's upright pins.

`Pushpin` (`app.tsx:1225`) is no longer used by the board; delete it if nothing else references it.

```tsx
// Pushpin at the top of every team card: blue by default, red on the agent in the current chat.
const PIN_TONES = { blue: ["#8CC8F0", "#3691CD", "#1D5A86"], red: ["#FF8A80", "#E5322D", "#9E1712"] };
function BoardPin({ live }: { live: boolean }) {
  const id = "bp" + React.useId().replace(/[^a-zA-Z0-9]/g, "");
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
```

### 9.3 AgentsView (replace the whole function)

The props are unchanged, so the call site at `app.tsx:2085` stays the same.

```tsx
// Agents roster: a pinned board. Tilted cards on grid paper, one pushpin per card, no string.
function AgentsView({ agents, current, onEdit, onChat, onNew }: {
  agents: Agent[]; current: Agent; onEdit: (a: Agent) => void; onChat: (a: Agent) => void; onNew: () => void;
}) {
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<"all" | "yours" | "builtin">("all");
  const needle = q.trim().toLowerCase();
  const shown = agents.filter(a => (kind === "all" || (kind === "builtin") === !!a.builtin)
    && `${a.name} ${a.handle || a.id} ${a.desc}`.toLowerCase().includes(needle));
  const yours = agents.filter(a => !a.builtin).length;
  const kinds = [["all", "All"], ["yours", "Yours"], ["builtin", "Built-in"]] as const;
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
          <input value={q} placeholder="Search by name, handle or purpose" aria-label="Search agents" onChange={e => setQ(e.target.value)} />
        </label>
        <div className="tb-pills" role="radiogroup" aria-label="Filter agents">
          {kinds.map(([id, label]) => (
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
                const t = tintOf(a.tint), live = a.id === current.id;
                return (
                  <li key={a.id} className="tb-card"
                    style={{ "--tint": t.bg, "--frame": t.dot, "--cap": inkOn(t.dot), "--tilt": `${TILTS[i % TILTS.length]}deg`, "--i": i } as any}>
                    <BoardPin live={live} />
                    <div className="tb-frame">
                      <button className="tb-photo" onClick={() => onEdit(a)} aria-label={`Edit ${a.name}`}>
                        {a.builtin && <span className="tb-lock" aria-hidden="true"><TbLock />built-in</span>}
                        <span className="tb-robot"><Robot look={a.look ?? 2} size={128} /></span>
                        <span className="tb-hint" aria-hidden="true"><TbPencil />Edit</span>
                      </button>
                      <div className="tb-caption">{a.name}</div>
                    </div>
                    <div className="tb-info">
                      <div className="tb-handle">
                        @{a.handle || a.id}
                        {live && <span className="tb-live"><span className="tb-pulse" aria-hidden="true" />in chat</span>}
                        {a.builtin && <span className="sr-only"> · built-in</span>}
                      </div>
                      <p className="tb-desc">{a.desc}</p>
                      <div className="tb-foot">
                        <span className="tb-meta">{modelOf(a.model).short} · {(a.reasoning || "Default").toLowerCase()}</span>
                        <button className="tb-btn" onClick={() => onChat(a)} disabled={live}>{live ? "Chatting" : "Chat"}</button>
                      </div>
                    </div>
                  </li>
                );
              })}
              {kind !== "builtin" && !needle && (
                <li className="tb-card is-new" style={{ "--tilt": `${TILTS[shown.length % TILTS.length]}deg`, "--i": shown.length } as any}>
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
        <span className="tb-tag">{kinds.find(k => k[0] === kind)![1]}</span>
        <span className="tb-tag" aria-label={`${shown.length} of ${agents.length} agents shown`}>{pad2(shown.length)}/{pad2(agents.length)}</span>
      </div>
    </div>
  );
}
```

### 9.4 CSS

Replace the block that starts at `/* agents roster: a pinned board of polaroids */` (`app.tsx:2621`) and every `.roster`, `.bp-*`, `.pol-*`, `.polaroid*` and `.acard-plus` rule in it, including the matching entries in the `hover: none`, `prefers-reduced-motion` and mobile media queries (`app.tsx:2688–2704`). Check that `.acard-plus` isn't used elsewhere before deleting it. Keep `@keyframes rise`.

```css
/* agents roster: pinned board, one pushpin per card, no string */
.tb-root { --font-hand: "Caveat", "Segoe Print", cursive;
  --board: #FFFFFF; --grid: rgb(54 145 205 / 9%); --grid-major: rgb(54 145 205 / 16%); --doodle: #3691CD;
  --shadow-card: 0 1px 2px rgb(31 42 48 / 6%), 0 14px 28px -12px rgb(31 42 48 / 28%);
  --shadow-lift: 0 2px 4px rgb(31 42 48 / 6%), 0 22px 40px -14px rgb(31 42 48 / 36%);
  max-width: 1180px; margin: 0 auto; padding: 24px 16px 56px; font-size: 14px; line-height: 1.5; animation: rise .3s ease-out; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .tb-root {
  --board: #161718; --grid: rgb(188 222 232 / 5%); --grid-major: rgb(188 222 232 / 9%); --doodle: #5AA8DC;
  --shadow-card: 0 1px 2px rgb(0 0 0 / 35%), 0 14px 28px -12px rgb(0 0 0 / 70%);
  --shadow-lift: 0 2px 4px rgb(0 0 0 / 35%), 0 22px 40px -14px rgb(0 0 0 / 80%); } }
:root[data-theme="dark"] .tb-root {
  --board: #161718; --grid: rgb(188 222 232 / 5%); --grid-major: rgb(188 222 232 / 9%); --doodle: #5AA8DC;
  --shadow-card: 0 1px 2px rgb(0 0 0 / 35%), 0 14px 28px -12px rgb(0 0 0 / 70%);
  --shadow-lift: 0 2px 4px rgb(0 0 0 / 35%), 0 22px 40px -14px rgb(0 0 0 / 80%); }

.tb-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.tb-brand { font-family: var(--font-mono); font-size: 12px; color: var(--ink-3); letter-spacing: .02em; }
.tb-new { display: inline-flex; align-items: center; gap: 6px; height: 36px; padding: 0 14px; border: 0; border-radius: 10px;
  background: var(--accent); color: var(--on-accent); font: 600 14px var(--font-sans); cursor: pointer; }
.tb-new:hover { background: var(--accent-2); }

.tb-hero { margin: 28px 0 22px; }
.tb-hero h1 { margin: 0; font: 800 clamp(30px, 5vw, 48px)/1.05 var(--font-sans); letter-spacing: -.035em; color: var(--ink); text-wrap: balance; }
.tb-script { display: inline-block; margin: 0 .04em; font-family: var(--font-hand); font-weight: 700; font-size: 1.3em; color: var(--accent);
  letter-spacing: 0; transform: rotate(-4deg) translateY(2px); }
.tb-hero p { margin: 10px 0 0; color: var(--ink-2); font-size: 15px; }

.tb-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-bottom: 16px; }
.tb-search { position: relative; flex: 1 1 260px; max-width: 380px; }
.tb-search svg { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: var(--ink-3); }
.tb-search input { width: 100%; height: 38px; padding: 0 12px 0 36px; border-radius: 10px; border: 1px solid var(--line-strong);
  background: var(--surface); color: var(--ink); font: inherit; outline: none; }
.tb-search input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.tb-search input::placeholder { color: var(--ink-3); }
.tb-pills { display: inline-flex; padding: 3px; gap: 2px; border-radius: 11px; background: var(--surface-3); border: 1px solid var(--line); }
.tb-pill { height: 30px; padding: 0 12px; border: 0; border-radius: 8px; background: transparent; color: var(--ink-2); font: 500 14px var(--font-sans); cursor: pointer; }
.tb-pill[aria-checked="true"] { background: var(--surface); color: var(--ink); box-shadow: var(--shadow-sm); font-weight: 600; }

.tb-board { position: relative; border-radius: 22px; border: 1px solid var(--line); padding: 48px 28px 36px; overflow: hidden;
  background-color: var(--board);
  background-image:
    linear-gradient(var(--grid-major) 1px, transparent 1px), linear-gradient(90deg, var(--grid-major) 1px, transparent 1px),
    linear-gradient(var(--grid) 1px, transparent 1px), linear-gradient(90deg, var(--grid) 1px, transparent 1px);
  background-size: 96px 96px, 96px 96px, 24px 24px, 24px 24px; background-position: -1px -1px; }
.tb-team { position: relative; z-index: 1; display: grid; gap: 56px 32px; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  margin: 0; padding: 0; list-style: none; }

.tb-card { position: relative; transform: rotate(var(--tilt)); transform-origin: 50% 0;
  animation: tb-pin-in .5s cubic-bezier(.2,.9,.3,1.2) both; animation-delay: calc(var(--i) * 60ms); }
@keyframes tb-pin-in { from { opacity: 0; transform: translateY(-14px) rotate(calc(var(--tilt) * 2)); } }
/* head centre sits 4px below the card's top-centre; counter-rotated so it reads upright */
.tb-pin { position: absolute; left: calc(50% - 12px); top: -8px; z-index: 3; overflow: visible; pointer-events: none;
  transform: rotate(calc(var(--tilt) * -1)); transform-origin: 12px 12px; }

.tb-frame { background: var(--frame); border-radius: 18px; padding: 10px 10px 0; box-shadow: var(--shadow-card); transition: box-shadow .2s ease; }
.tb-card:hover .tb-frame { box-shadow: var(--shadow-lift); }
.tb-photo { position: relative; display: grid; place-items: center; width: 100%; aspect-ratio: 5 / 4; padding: 0; border: 0; border-radius: 11px; overflow: hidden; cursor: pointer;
  background: radial-gradient(120% 90% at 30% 20%, rgb(255 255 255 / 70%), transparent 60%), var(--tint); }
.tb-photo::after { content: ""; position: absolute; inset: 0; border-radius: inherit; box-shadow: inset 0 0 0 1px rgb(31 42 48 / 8%); pointer-events: none; }
.tb-robot { display: block; width: 62%; transition: transform .3s cubic-bezier(.2,.9,.3,1.2); }
.tb-robot svg { display: block; width: 100%; height: auto; }
.tb-card:hover .tb-robot { transform: translateY(-4px) scale(1.04); }
.tb-hint { position: absolute; right: 8px; bottom: 8px; display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; border-radius: 999px;
  background: rgb(255 255 255 / 92%); color: #1F2A30; font: 600 12px var(--font-sans); opacity: 0; transform: translateY(4px); transition: .15s ease; }
.tb-photo:hover .tb-hint, .tb-photo:focus-visible .tb-hint { opacity: 1; transform: none; }
.tb-lock { position: absolute; left: 8px; bottom: 8px; display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 999px;
  background: rgb(255 255 255 / 80%); color: #5F6D73; font: 600 11px var(--font-sans); }
.tb-caption { display: block; padding: 8px 4px 12px; text-align: center; color: var(--cap); font: 700 26px/1.05 var(--font-hand); transform: rotate(-2deg); overflow-wrap: anywhere; }

.tb-info { padding: 12px 4px 0; transform: rotate(calc(var(--tilt) * -1)); transform-origin: 50% 0; }
.tb-handle { display: flex; align-items: center; gap: 8px; font-family: var(--font-mono); font-size: 12px; color: var(--ink-3); }
.tb-live { display: inline-flex; align-items: center; gap: 5px; padding: 1px 8px; border-radius: 999px; background: var(--success-bg); color: var(--success-text);
  font: 600 11px var(--font-sans); }
.tb-pulse { width: 6px; height: 6px; border-radius: 50%; background: currentColor; animation: tb-pulse 1.6s ease-in-out infinite; }
@keyframes tb-pulse { 50% { opacity: .35; } }
.tb-desc { margin: 4px 0 10px; color: var(--ink-2); }
.tb-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.tb-meta { font-family: var(--font-mono); font-size: 11px; color: var(--ink-3); }
.tb-btn { height: 30px; padding: 0 12px; border-radius: 8px; border: 1px solid var(--line-strong); background: var(--surface); color: var(--ink);
  font: 600 14px var(--font-sans); cursor: pointer; }
.tb-btn:hover:not(:disabled) { border-color: var(--accent); color: var(--accent-fg); }
.tb-btn:disabled { color: var(--ink-3); cursor: default; background: var(--surface-3); }

.tb-card.is-new .tb-frame { display: block; width: 100%; padding: 10px; border: 2px dashed var(--line-strong); background: transparent; box-shadow: none;
  text-align: center; font: inherit; cursor: pointer; }
.tb-card.is-new .tb-frame:hover { border-color: var(--accent); }
.tb-photo-empty { display: grid; place-items: center; aspect-ratio: 5 / 4; border-radius: 11px; background: var(--surface-3); }
.tb-plus { display: grid; place-items: center; width: 44px; height: 44px; border-radius: 50%; background: var(--accent); color: var(--on-accent); }
.tb-card.is-new .tb-caption { color: var(--ink-2); padding-bottom: 4px; }
.tb-note { display: flex; align-items: flex-start; gap: 4px; margin: 8px 0 0 12px; font-family: var(--font-hand); font-size: 22px; color: var(--doodle);
  transform: rotate(-3deg); white-space: nowrap; }

.tb-doodle { position: absolute; z-index: 0; color: var(--doodle); opacity: .8; pointer-events: none; }
.tb-bolt { right: 18px; top: 12px; }
.tb-squig { left: 14px; bottom: 10px; }

.tb-empty { grid-column: 1 / -1; display: grid; justify-items: center; gap: 10px; padding: 56px 16px; color: var(--ink-2); }
.tb-empty strong { color: var(--ink); }

.tb-board-foot { display: flex; justify-content: space-between; align-items: center; margin-top: 14px; font-family: var(--font-mono); font-size: 12px; color: var(--ink-3); }
.tb-tag { padding: 3px 9px; border-radius: 999px; border: 1px solid var(--line); background: var(--surface); }

@media (hover: none) { .tb-hint { display: none; } }
@media (max-width: 560px) {
  .tb-board { padding: 40px 14px 28px; }
  .tb-team { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 44px 14px; }
  .tb-caption { font-size: 19px; padding: 6px 2px 8px; }
  .tb-foot { flex-direction: column; align-items: stretch; }
  .tb-meta, .tb-doodle { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .tb-root, .tb-card, .tb-pulse { animation: none; }
  .tb-robot { transition: none; }
}
```

### 9.5 Assets

Every asset is inline SVG, so there are no image files to add.

| Asset | Source |
|---|---|
| Robots (12 looks) | Existing `Robot` component (`app.tsx:707`), `LOOKS` and `tone()`, unchanged |
| Pushpin blue/red | `BoardPin` (9.2) |
| Plus, search, pencil, lock | `TbPlus`, `TbSearch`, `TbPencil`, `TbLock` (9.2) |
| Bolt, squiggle, arrow doodles | `TbBolt`, `TbSquig`, `TbArrow` (9.2) |
| Fonts | Google Fonts link already in `index.html` |

### 9.6 Acceptance checklist

- [ ] Every card has exactly one pin; there are no lines or strings between pins.
- [ ] Current-chat agent: red pin, "in chat" badge, disabled "Chatting" button. Switching chat moves the red pin.
- [ ] Pins stay upright and centred over each card at all 8 tilts, in both themes and at ≤ 560px.
- [ ] Hover changes only the shadow, the robot and the edit hint; the card and pin stay still.
- [ ] Built-in filter and active search both hide the new-agent card.
- [ ] Empty search shows the full-width message and a working Clear search.
- [ ] Count tag and its aria-label update with filters.
- [ ] Dark mode follows the system and `data-theme` on `<html>`.
- [ ] Reduced motion disables the entrance, pulse and robot transition.

---

## 10. Standalone reference (`design/agent-team-list-v2.html`)

This is the complete prototype. Save it as `.html` and open it in a browser; it needs no build step. The data and toasts are demo stubs. The prototype places pins with a measured overlay SVG. The app port (9.2) puts each pin inside its card instead, which looks the same and needs no measuring.

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Team Pins</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700;800&family=Newsreader:ital,opsz,wght@1,6..72,400..500&family=JetBrains+Mono:wght@400;500&family=Caveat:wght@600;700&display=swap">
<style>
/* Agent team list, "pinned board" direction.
   Reference: pinned photo cards on grid paper (no connecting string), with a script accent in the headline.
   Tokens are the repo's own (index.html); agent data, tints and robots are copied from app.tsx. */
:root {
  --bg: #F6F9FA; --surface: #FFFFFF; --surface-3: #F6F9FA; --line: #E3ECEF; --line-strong: #D8E0E4;
  --ink: #1F2A30; --ink-2: #5F6D73; --ink-3: #849198;
  --accent: #3691CD; --accent-2: #2A7DB4; --accent-soft: #EAF5F8; --accent-fg: #2A72A3; --on-accent: #FFFFFF;
  --success-bg: #E7F4ED; --success-text: #35624E;
  --board: #FFFFFF; --grid: rgb(54 145 205 / 9%); --grid-major: rgb(54 145 205 / 16%);
  --doodle: #3691CD;
  --shadow-sm: 0 1px 2px rgb(31 42 48 / 5%);
  --shadow-card: 0 1px 2px rgb(31 42 48 / 6%), 0 14px 28px -12px rgb(31 42 48 / 28%);
  --shadow-lift: 0 2px 4px rgb(31 42 48 / 6%), 0 22px 40px -14px rgb(31 42 48 / 36%);
  --radius: 16px;
  --font-sans: "Figtree", ui-sans-serif, system-ui, sans-serif;
  --font-accent: "Newsreader", ui-serif, Georgia, serif;
  --font-hand: "Caveat", "Segoe Print", cursive;
  --font-mono: "JetBrains Mono", ui-monospace, monospace;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg: #111213; --surface: #171717; --surface-3: #222324; --line: #2A2A2A; --line-strong: #363636;
  --ink: #EEF4F6; --ink-2: #B7C3C8; --ink-3: #8B999F;
  --accent: #3691CD; --accent-2: #5AA8DC; --accent-soft: #14283A; --accent-fg: #BCDEE8; --on-accent: #FFFFFF;
  --success-bg: #16291F; --success-text: #A8D8BE;
  --board: #161718; --grid: rgb(188 222 232 / 5%); --grid-major: rgb(188 222 232 / 9%);
  --doodle: #5AA8DC;
  --shadow-sm: 0 1px 2px rgb(0 0 0 / 30%);
  --shadow-card: 0 1px 2px rgb(0 0 0 / 35%), 0 14px 28px -12px rgb(0 0 0 / 70%);
  --shadow-lift: 0 2px 4px rgb(0 0 0 / 35%), 0 22px 40px -14px rgb(0 0 0 / 80%);
  color-scheme: dark;
} }
:root[data-theme="dark"] {
  --bg: #111213; --surface: #171717; --surface-3: #222324; --line: #2A2A2A; --line-strong: #363636;
  --ink: #EEF4F6; --ink-2: #B7C3C8; --ink-3: #8B999F;
  --accent: #3691CD; --accent-2: #5AA8DC; --accent-soft: #14283A; --accent-fg: #BCDEE8; --on-accent: #FFFFFF;
  --success-bg: #16291F; --success-text: #A8D8BE;
  --board: #161718; --grid: rgb(188 222 232 / 5%); --grid-major: rgb(188 222 232 / 9%);
  --doodle: #5AA8DC;
  --shadow-sm: 0 1px 2px rgb(0 0 0 / 30%);
  --shadow-card: 0 1px 2px rgb(0 0 0 / 35%), 0 14px 28px -12px rgb(0 0 0 / 70%);
  --shadow-lift: 0 2px 4px rgb(0 0 0 / 35%), 0 22px 40px -14px rgb(0 0 0 / 80%);
  color-scheme: dark;
}

* { box-sizing: border-box; }
html, body { margin: 0; }
body { background: var(--bg); color: var(--ink); font-family: var(--font-sans); font-size: 14px; line-height: 1.5; -webkit-font-smoothing: antialiased; }
button, input { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 8px; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.page { max-width: 1180px; margin: 0 auto; padding: 24px 16px 56px; }

/* ---------- header */
.top { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.brand { font-family: var(--font-mono); font-size: 12px; color: var(--ink-3); letter-spacing: .02em; }
.top-actions { display: flex; gap: 8px; }
.icon-btn { display: inline-grid; place-items: center; width: 36px; height: 36px; border-radius: 10px;
  border: 1px solid var(--line-strong); background: var(--surface); cursor: pointer; color: var(--ink-2); }
.icon-btn:hover { color: var(--ink); border-color: var(--ink-3); }
.btn-primary { display: inline-flex; align-items: center; gap: 6px; height: 36px; padding: 0 14px; border: 0; border-radius: 10px;
  background: var(--accent); color: var(--on-accent); font-weight: 600; cursor: pointer; }
.btn-primary:hover { background: var(--accent-2); }

.hero { margin: 28px 0 22px; }
.hero h1 { margin: 0; font-size: clamp(30px, 5vw, 48px); line-height: 1.05; font-weight: 800; letter-spacing: -.035em; text-wrap: balance; }
.hero h1 .script { font-family: var(--font-hand); font-weight: 700; font-size: 1.3em; color: var(--accent); letter-spacing: 0;
  display: inline-block; transform: rotate(-4deg) translateY(2px); margin: 0 .04em; }
.hero p { margin: 10px 0 0; color: var(--ink-2); font-size: 15px; }

/* ---------- tools */
.tools { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-bottom: 16px; }
.search { position: relative; flex: 1 1 260px; max-width: 380px; }
.search svg { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: var(--ink-3); }
.search input { width: 100%; height: 38px; padding: 0 12px 0 36px; border-radius: 10px; border: 1px solid var(--line-strong);
  background: var(--surface); outline: none; }
.search input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.search input::placeholder { color: var(--ink-3); }
.pills { display: inline-flex; padding: 3px; gap: 2px; border-radius: 11px; background: var(--surface-3); border: 1px solid var(--line); }
.pill { height: 30px; padding: 0 12px; border: 0; border-radius: 8px; background: transparent; color: var(--ink-2); font-weight: 500; cursor: pointer; }
.pill[aria-checked="true"] { background: var(--surface); color: var(--ink); box-shadow: var(--shadow-sm); font-weight: 600; }

/* ---------- board: grid paper, cards, pins */
.board { position: relative; border-radius: 22px; border: 1px solid var(--line); padding: 48px 28px 36px; overflow: hidden;
  background-color: var(--board);
  background-image:
    linear-gradient(var(--grid-major) 1px, transparent 1px), linear-gradient(90deg, var(--grid-major) 1px, transparent 1px),
    linear-gradient(var(--grid) 1px, transparent 1px), linear-gradient(90deg, var(--grid) 1px, transparent 1px);
  background-size: 96px 96px, 96px 96px, 24px 24px, 24px 24px; background-position: -1px -1px; }
.team { list-style: none; margin: 0; padding: 0; display: grid; gap: 56px 32px;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); position: relative; z-index: 1; }

.card { position: relative; transform: rotate(var(--tilt)); transform-origin: 50% 0;
  animation: pin-in .5s cubic-bezier(.2,.9,.3,1.2) both; animation-delay: calc(var(--i) * 60ms); }
@keyframes pin-in { from { opacity: 0; transform: translateY(-14px) rotate(calc(var(--tilt) * 2)); } }
/* anchor for the pin; the overlay reads its position */
.pin-anchor { position: absolute; left: 50%; top: 4px; width: 1px; height: 1px; }

.frame { background: var(--frame); border-radius: 18px; padding: 10px 10px 0; box-shadow: var(--shadow-card);
  transition: box-shadow .2s ease; }
.card:hover .frame { box-shadow: var(--shadow-lift); }
.photo { position: relative; display: grid; place-items: center; width: 100%; aspect-ratio: 5 / 4; border: 0; padding: 0; border-radius: 11px;
  background: radial-gradient(120% 90% at 30% 20%, rgb(255 255 255 / 70%), transparent 60%), var(--tint); cursor: pointer; overflow: hidden; }
.photo::after { content: ""; position: absolute; inset: 0; border-radius: inherit; box-shadow: inset 0 0 0 1px rgb(31 42 48 / 8%); pointer-events: none; }
.photo svg.robot { width: 62%; height: auto; transition: transform .3s cubic-bezier(.2,.9,.3,1.2); }
.card:hover .photo svg.robot { transform: translateY(-4px) scale(1.04); }
.edit-hint { position: absolute; right: 8px; bottom: 8px; display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; border-radius: 999px;
  background: rgb(255 255 255 / 92%); color: #1F2A30; font-size: 12px; font-weight: 600; opacity: 0; transform: translateY(4px); transition: .15s ease; }
.photo:hover .edit-hint, .photo:focus-visible .edit-hint { opacity: 1; transform: none; }
.lock { position: absolute; left: 8px; bottom: 8px; display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 999px;
  background: rgb(255 255 255 / 80%); color: #5F6D73; font-size: 11px; font-weight: 600; }
/* same caption as app.tsx .pol-caption: Caveat 700, slight counter-tilt */
.caption { padding: 8px 4px 12px; text-align: center; color: var(--cap); font: 700 26px/1.05 var(--font-hand); transform: rotate(-2deg); overflow-wrap: anywhere; }

.info { padding: 12px 4px 0; transform: rotate(calc(var(--tilt) * -1)); transform-origin: 50% 0; }
.handle { display: flex; align-items: center; gap: 8px; font-family: var(--font-mono); font-size: 12px; color: var(--ink-3); }
.live { display: inline-flex; align-items: center; gap: 5px; padding: 1px 8px; border-radius: 999px; background: var(--success-bg); color: var(--success-text);
  font-family: var(--font-sans); font-size: 11px; font-weight: 600; }
.pulse { width: 6px; height: 6px; border-radius: 50%; background: currentColor; animation: pulse 1.6s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: .35; } }
.desc { margin: 4px 0 10px; color: var(--ink-2); }
.foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.meta { font-family: var(--font-mono); font-size: 11px; color: var(--ink-3); }
.btn-soft { height: 30px; padding: 0 12px; border-radius: 8px; border: 1px solid var(--line-strong); background: var(--surface); font-weight: 600; cursor: pointer; }
.btn-soft:hover:not(:disabled) { border-color: var(--accent); color: var(--accent-fg); }
.btn-soft:disabled { color: var(--ink-3); cursor: default; background: var(--surface-3); }

/* new-agent slot: dashed empty frame + hand-drawn note */
.card.is-new .frame { background: transparent; box-shadow: none; border: 2px dashed var(--line-strong); padding: 10px; cursor: pointer; width: 100%; display: block; text-align: center; }
.card.is-new .frame:hover { border-color: var(--accent); }
.card.is-new .photo-empty { display: grid; place-items: center; aspect-ratio: 5 / 4; border-radius: 11px; background: var(--surface-3); }
.plus { display: grid; place-items: center; width: 44px; height: 44px; border-radius: 50%; background: var(--accent); color: var(--on-accent); }
.card.is-new .caption { color: var(--ink-2); padding-bottom: 4px; }
.note { display: flex; align-items: flex-start; gap: 4px; margin: 8px 0 0 12px; font-family: var(--font-hand); font-size: 22px; color: var(--doodle); transform: rotate(-3deg); white-space: nowrap; }

/* pins sit above the cards */
.pins { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible; z-index: 3; }

.doodle { position: absolute; color: var(--doodle); pointer-events: none; z-index: 0; opacity: .8; }
.doodle.bolt { right: 18px; top: 12px; }
.doodle.squig { left: 14px; bottom: 10px; }

.empty { display: grid; justify-items: center; gap: 10px; padding: 56px 16px; color: var(--ink-2); position: relative; z-index: 1; }
.empty strong { color: var(--ink); }

.board-foot { display: flex; justify-content: space-between; align-items: center; margin-top: 14px; font-family: var(--font-mono); font-size: 12px; color: var(--ink-3); }
.tag { padding: 3px 9px; border-radius: 999px; border: 1px solid var(--line); background: var(--surface); }

/* ---------- spec */
.spec { margin-top: 36px; padding-top: 20px; border-top: 1px solid var(--line); color: var(--ink-2); max-width: 78ch; }
.spec h2 { margin: 0 0 8px; font-size: 16px; color: var(--ink); }
.spec li { margin: 4px 0; }
.spec code { font-family: var(--font-mono); font-size: 12px; background: var(--surface-3); padding: 1px 5px; border-radius: 5px; border: 1px solid var(--line); }

.toast { position: fixed; left: 50%; bottom: 20px; transform: translate(-50%, 20px); opacity: 0; padding: 10px 14px; border-radius: 10px;
  background: #1F2A30; color: #fff; font-weight: 500; box-shadow: var(--shadow-lift); transition: .2s ease; z-index: 10; }
.toast.show { opacity: 1; transform: translate(-50%, 0); }

@media (max-width: 560px) {
  .board { padding: 40px 14px 28px; }
  .team { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 44px 14px; }
  .caption { font-size: 19px; padding: 6px 2px 8px; }
  .foot { flex-direction: column; align-items: stretch; }
  .meta { display: none; }
  .doodle { display: none; }
}
@media (prefers-reduced-motion: reduce) { .card, .pulse { animation: none; } .photo svg.robot { transition: none; } }
</style>
</head>
<body>
<main class="page">
  <div class="top">
    <span class="brand">truex / agents</span>
    <div class="top-actions">
      <button class="icon-btn" id="theme" aria-label="Toggle theme">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
      </button>
      <button class="btn-primary" data-new>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
        New agent
      </button>
    </div>
  </div>

  <header class="hero">
    <h1>What the <span class="script">team</span> can help with</h1>
    <p id="sub"></p>
  </header>

  <div class="tools">
    <label class="search">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      <input id="q" placeholder="Search by name, handle or purpose" aria-label="Search agents">
    </label>
    <div class="pills" role="radiogroup" aria-label="Filter agents" id="pills"></div>
  </div>

  <section class="board" id="board" aria-label="Agent team">
    <svg class="doodle bolt" width="54" height="64" viewBox="0 0 54 64" aria-hidden="true"><path d="M30 2 10 34h16l-6 28 26-38H30z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M4 18l6 3M46 44l6 2M40 8l4-5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
    <svg class="doodle squig" width="90" height="30" viewBox="0 0 90 30" aria-hidden="true"><path d="M2 20c8-14 14-14 20 0s12 14 20 0 14-14 20 0 12 14 26-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
    <ul class="team" id="team"></ul>
    <svg class="pins" id="pins" aria-hidden="true"></svg>
  </section>
  <div class="board-foot"><span class="tag" id="filter-tag">All</span><span class="tag" id="count"></span></div>

  <section class="spec">
    <h2>Porting into app.tsx</h2>
    <ul>
      <li>Replaces the <code>.polaroids</code> list inside <code>AgentsView</code>; header, search and filter pills keep their current behaviour.</li>
      <li>Frame colour is the agent tint's <code>dot</code>, photo background is the tint's <code>bg</code>, caption ink comes from the existing <code>inkOn()</code>.</li>
      <li>Every card gets a blue pin; the agent in the current chat gets the red pin and the "in chat" badge (replaces today's pin-only marker).</li>
      <li>Pins are one absolutely positioned SVG over the list (no string between them). A small <code>TeamPins</code> component reads each <code>.pin-anchor</code> with <code>getBoundingClientRect</code> in a <code>useLayoutEffect</code>, re-run by a <code>ResizeObserver</code> on the board and after <code>document.fonts.ready</code>.</li>
      <li>Tilts reuse <code>TILTS</code>; the info block counter-rotates so text reads straight.</li>
      <li>Hover never moves the card (only shadow and robot), so the pins stay put without re-measuring.</li>
    </ul>
  </section>
</main>
<div class="toast" id="toast" role="status" aria-live="polite"></div>

<script>
/* ---- data, copied from app.tsx (plus two custom agents to show "Yours") */
const AGENTS = [
  { id: "qlik", handle: "qlik", name: "Qlik Analyst", desc: "Dashboards, metrics, BI queries", look: 3, tint: "ice", builtin: true, model: "opus", reasoning: "High" },
  { id: "research", handle: "research", name: "Researcher", desc: "Web research with citations", look: 4, tint: "mint", builtin: true },
  { id: "writer", handle: "writer", name: "Writer", desc: "Docs, release notes, briefs", look: 1, tint: "butter", builtin: true, model: "sonnet" },
  { id: "ops", handle: "ops", name: "Ops", desc: "Runbooks, tickets, on-call", look: 6, tint: "lilac", builtin: true },
  { id: "agent-1", handle: "designer", name: "Designer", desc: "UI reviews, specs, copy tweaks", look: 9, tint: "peach", model: "sonnet", reasoning: "Medium" },
  { id: "agent-2", handle: "support", name: "Support", desc: "Triage inbox, draft replies", look: 5, tint: "ice", model: "haiku", reasoning: "Low" },
];
const LOOKS = [
  { body: "#3A4750", visor: "#1F2A30", glow: "#BCDEE8", face: "line" },
  { body: "#F4F7F8", visor: "#2B3F6B", glow: "#BCDEE8", face: "eyes", acc: "antenna" },
  { body: "#2E4470", visor: "#16213A", glow: "#BCDEE8", face: "line" },
  { body: "#D5DDE1", visor: "#2B3F6B", glow: "#BCDEE8", face: "happy", acc: "headphones", accColor: "#3691CD" },
  { body: "#D8C3A0", visor: "#3A4750", glow: "#EBCB8B", face: "line", acc: "cap", accColor: "#E07B6E" },
  { body: "#F4F7F8", visor: "#2B3F6B", glow: "#BCDEE8", face: "eyes", acc: "chef" },
  { body: "#F4F7F8", visor: "#3A4750", glow: "#EBCB8B", face: "eyes", acc: "hardhat", accColor: "#F2C94C" },
  { body: "#3A4750", visor: "#1F2A30", glow: "#F0B999", face: "happy", acc: "scarf", accColor: "#E07B6E" },
  { body: "#BFE3CF", visor: "#1F2A30", glow: "#A9D5BE", face: "eyes", acc: "antenna" },
  { body: "#CFC8EC", visor: "#2B3F6B", glow: "#C4BDE3", face: "happy", acc: "bow", accColor: "#F0A3B5" },
];
const TINTS = [
  { id: "ice", bg: "#EAF5F8", dot: "#3691CD" }, { id: "mint", bg: "#E7F4ED", dot: "#A9D5BE" },
  { id: "butter", bg: "#FFF3D9", dot: "#EBCB8B" }, { id: "peach", bg: "#FBE9DD", dot: "#F0B999" },
  { id: "lilac", bg: "#EFEDF8", dot: "#C4BDE3" },
];
const MODELS = { default: "default model", opus: "opus 5.5", sonnet: "sonnet 5.5", haiku: "haiku 4.5" };
const TILTS = [-4, 3, -2.5, 4.5, -3.5, 2, -1.5, 3.5];
const tintOf = id => TINTS.find(t => t.id === id) || TINTS[0];
const tone = (hex, amt) => {
  const n = parseInt(hex.slice(1), 16), t = amt < 0 ? 0 : 255, k = Math.abs(amt);
  const ch = sh => Math.round(((n >> sh) & 255) + (t - ((n >> sh) & 255)) * k).toString(16).padStart(2, "0");
  return "#" + ch(16) + ch(8) + ch(0);
};
const inkOn = hex => {
  const n = parseInt(hex.slice(1), 16), c = s => ((n >> s) & 255) / 255;
  return .2126 * c(16) + .7152 * c(8) + .0722 * c(0) < .45 ? "#FFFFFF" : "#1F2A30";
};
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad2 = n => String(n).padStart(2, "0");

/* ---- Robot, a string port of app.tsx's <Robot> */
let uid = 0;
function robot(look) {
  const L = LOOKS[look] || LOOKS[0], id = "rb" + (++uid), u = n => `url(#${id}-${n})`;
  const edge = tone(L.body, -.45), acc = L.accColor || L.body, accEdge = tone(acc, -.4);
  const limb = `fill="${u("limb")}" stroke="${edge}" stroke-width="1.5"`;
  const accL = (fill = u("acc")) => `fill="${fill}" stroke="${accEdge}" stroke-width="1.4" stroke-linejoin="round"`;
  const face = { line: `<rect x="51" y="50" width="22" height="5.6" rx="2.8" fill="${L.glow}"/>`,
    eyes: `<circle cx="52" cy="53" r="4.1" fill="${L.glow}"/><circle cx="72" cy="53" r="4.1" fill="${L.glow}"/>`,
    happy: `<path d="M47 55.5q5-6.2 10 0M67 55.5q5-6.2 10 0" fill="none" stroke="${L.glow}" stroke-width="3.2" stroke-linecap="round"/>` }[L.face];
  const accs = {
    antenna: `<path d="M60 23V10" stroke="${edge}" stroke-width="3" stroke-linecap="round"/><rect x="54.5" y="20" width="11" height="4.5" rx="2.25" fill="${tone(L.body, -.2)}" stroke="${edge}" stroke-width="1.2"/><circle cx="60" cy="8.5" r="9" fill="${L.glow}" opacity=".28"/><circle cx="60" cy="8.5" r="5.2" fill="${L.glow}" stroke="${tone(L.glow, -.4)}" stroke-width="1.2"/><circle cx="58.3" cy="6.8" r="1.6" fill="#fff" opacity=".85"/>`,
    cap: `<path d="M80 33.5c10-1 21 0 27 3 2 1.2 1 4-1.5 4-8 0-17-1-26-2.5z" ${accL(tone(acc, -.1))}/><path d="M26 38C26 10 94 10 94 38c-10-3-58-3-68 0z" ${accL()}/><path d="M60 15v21" stroke="${accEdge}" stroke-opacity=".45" stroke-width="1.2"/><path d="M36 28c5-7 12-10 19-11" fill="none" stroke="#fff" stroke-opacity=".4" stroke-width="2.2" stroke-linecap="round"/><circle cx="60" cy="14.5" r="2.6" fill="${tone(acc, -.15)}" stroke="${accEdge}" stroke-width="1"/>`,
    hardhat: `<path d="M26 33C26 4 94 4 94 33z" ${accL()}/><rect x="55" y="7.5" width="10" height="25" rx="4" fill="${tone(acc, .3)}" stroke="${accEdge}" stroke-width="1.2"/><rect x="17" y="30" width="86" height="7" rx="3.5" ${accL(tone(acc, -.08))}/><path d="M34 24c3-7 9-11 16-13" fill="none" stroke="#fff" stroke-opacity=".45" stroke-width="2.2" stroke-linecap="round"/>`,
    chef: `<g fill="${u("chef")}"><circle cx="44" cy="18" r="10.5"/><circle cx="76" cy="18" r="10.5"/><circle cx="60" cy="13" r="12.5"/></g><path d="M41 11c2-2 5-3 8-3M56 5c2-1 5-1.4 7-1" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"/><rect x="36" y="18" width="48" height="15" rx="5" fill="${u("chef")}" stroke="#B9C4CA" stroke-width="1.2"/><path d="M48 21v9M60 21v9M72 21v9" stroke="#B9C4CA" stroke-opacity=".7" stroke-width="1" stroke-linecap="round"/>`,
    headphones: `<path d="M22 54C22 10 98 10 98 54" fill="none" stroke="${tone(acc, -.4)}" stroke-width="7" stroke-linecap="round"/><path d="M22 54C22 10 98 10 98 54" fill="none" stroke="${tone(acc, .25)}" stroke-opacity=".6" stroke-width="2" stroke-linecap="round"/><rect x="13" y="43" width="17" height="27" rx="7.5" ${accL()}/><rect x="90" y="43" width="17" height="27" rx="7.5" ${accL()}/><path d="M17 49v10M94 49v10" stroke="#fff" stroke-opacity=".45" stroke-width="2" stroke-linecap="round"/>`,
    bow: `<path d="M78 20l-11-7c-2-1.2-4 .4-4 2.6v9c0 2.2 2.2 3.4 4 2.4z" ${accL()}/><path d="M78 20l11-7c2-1.2 4 .4 4 2.6v9c0 2.2-2.2 3.4-4 2.4z" ${accL()}/><circle cx="78" cy="20" r="3.6" ${accL(tone(acc, -.12))}/><path d="M66.5 16.5l3 1.8M89.5 16.5l-3 1.8" stroke="#fff" stroke-opacity=".5" stroke-width="1.6" stroke-linecap="round"/>`,
  };
  const scarf = L.acc === "scarf" ? `<path d="M72 79l3.5 21c.4 2.2 3.2 2.8 4.6 1.1L87 93l-5.5-15z" ${accL()}/><path d="M77 97l1.2 4M81 95.5l1.6 3.6" stroke="${accEdge}" stroke-width="1.2" stroke-linecap="round"/><path d="M25 71c20 8.5 50 8.5 70 0v9c-20 8.5-50 8.5-70 0z" ${accL()}/><path d="M31 75c16 5.5 42 5.5 58 0" fill="none" stroke="#fff" stroke-opacity=".35" stroke-width="1.6" stroke-linecap="round"/>` : "";
  return `<svg class="robot" viewBox="0 0 120 120" aria-hidden="true">
<defs>
<linearGradient id="${id}-body" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${tone(L.body, .38)}"/><stop offset=".55" stop-color="${L.body}"/><stop offset="1" stop-color="${tone(L.body, -.3)}"/></linearGradient>
<linearGradient id="${id}-limb" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${tone(L.body, -.06)}"/><stop offset="1" stop-color="${tone(L.body, -.34)}"/></linearGradient>
<radialGradient id="${id}-sheen" cx=".3" cy=".2" r=".6"><stop offset="0" stop-color="#fff" stop-opacity=".6"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
<linearGradient id="${id}-visor" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${tone(L.visor, .24)}"/><stop offset="1" stop-color="${tone(L.visor, -.38)}"/></linearGradient>
<radialGradient id="${id}-screen" cx=".5" cy=".55" r=".6"><stop offset="0" stop-color="${L.glow}" stop-opacity=".3"/><stop offset="1" stop-color="${L.glow}" stop-opacity="0"/></radialGradient>
<linearGradient id="${id}-acc" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${tone(acc, .32)}"/><stop offset="1" stop-color="${tone(acc, -.22)}"/></linearGradient>
<linearGradient id="${id}-chef" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#D6DEE2"/></linearGradient>
<radialGradient id="${id}-shadow"><stop offset="0" stop-color="#101820" stop-opacity=".3"/><stop offset="1" stop-color="#101820" stop-opacity="0"/></radialGradient>
<filter id="${id}-glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1.8" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
</defs>
<ellipse cx="60" cy="109" rx="36" ry="6.5" fill="${u("shadow")}"/>
<rect x="13" y="50" width="20" height="38" rx="9" ${limb}/><rect x="37" y="82" width="19" height="25" rx="8.5" ${limb}/><rect x="64" y="82" width="19" height="25" rx="8.5" ${limb}/>
<path d="M41 101.5h11M68 101.5h11" stroke="#fff" stroke-opacity=".18" stroke-width="2" stroke-linecap="round"/>
<rect x="24" y="22" width="72" height="72" rx="31" fill="${u("body")}" stroke="${edge}" stroke-width="1.5"/>
<rect x="24" y="22" width="72" height="72" rx="31" fill="${u("sheen")}"/>
<path d="M90 46c3.6 10 3.4 24-2 34" fill="none" stroke="#fff" stroke-opacity=".24" stroke-width="3" stroke-linecap="round"/>
${L.acc !== "scarf" ? `<circle cx="73" cy="81" r="2.2" fill="${L.glow}" filter="${u("glow")}"/>` : ""}${scarf}
<rect x="35" y="36" width="54" height="33" rx="15" fill="${tone(L.visor, -.55)}"/>
<rect x="37.5" y="38.5" width="49" height="28" rx="12.5" fill="${u("visor")}"/>
<rect x="37.5" y="38.5" width="49" height="28" rx="12.5" fill="${u("screen")}"/>
<g filter="${u("glow")}">${face}</g>
${L.face === "eyes" ? `<circle cx="53.4" cy="51.6" r="1.2" fill="#fff"/><circle cx="73.4" cy="51.6" r="1.2" fill="#fff"/>` : ""}
<path d="M43.5 45c3-2.8 8-3.8 13-3.6" fill="none" stroke="#fff" stroke-opacity=".6" stroke-width="2.6" stroke-linecap="round"/>
<circle cx="80.5" cy="61" r="1.5" fill="#fff" fill-opacity=".35"/>
${accs[L.acc] || ""}
</svg>`;
}

/* ---- state + render */
const state = { q: "", kind: "all", current: "qlik" };
const KINDS = [["all", "All"], ["yours", "Yours"], ["builtin", "Built-in"]];
const $ = id => document.getElementById(id);
const pencil = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>`;
const lock = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`;

function render() {
  const needle = state.q.trim().toLowerCase();
  const shown = AGENTS.filter(a => (state.kind === "all" || (state.kind === "builtin") === !!a.builtin)
    && `${a.name} ${a.handle} ${a.desc}`.toLowerCase().includes(needle));
  const yours = AGENTS.filter(a => !a.builtin).length;
  $("sub").textContent = `${AGENTS.length} specialists · ${yours} built by you. Pin one to the chat, or build your own.`;
  $("pills").innerHTML = KINDS.map(([id, label]) =>
    `<button class="pill" role="radio" aria-checked="${state.kind === id}" data-kind="${id}">${label}</button>`).join("");
  $("filter-tag").textContent = KINDS.find(k => k[0] === state.kind)[1];
  $("count").textContent = `${pad2(shown.length)}/${pad2(AGENTS.length)}`;
  $("count").setAttribute("aria-label", `${shown.length} of ${AGENTS.length} agents shown`);

  if (needle && !shown.length) {
    $("team").innerHTML = `<li class="empty"><strong>No agents match "${esc(state.q.trim())}"</strong><button class="btn-soft" data-clear>Clear search</button></li>`;
    drawPins(); return;
  }
  const cards = shown.map((a, i) => {
    const t = tintOf(a.tint), live = a.id === state.current;
    return `<li class="card" data-id="${a.id}" data-live="${live}" style="--tint:${t.bg};--frame:${t.dot};--cap:${inkOn(t.dot)};--tilt:${TILTS[i % TILTS.length]}deg;--i:${i}">
      <span class="pin-anchor"></span>
      <div class="frame">
        <button class="photo" data-edit="${a.id}" aria-label="Edit ${esc(a.name)}">
          ${a.builtin ? `<span class="lock" aria-hidden="true">${lock}built-in</span>` : ""}
          ${robot(a.look)}
          <span class="edit-hint" aria-hidden="true">${pencil}Edit</span>
        </button>
        <div class="caption">${esc(a.name)}</div>
      </div>
      <div class="info">
        <div class="handle">@${esc(a.handle)}${live ? `<span class="live"><span class="pulse" aria-hidden="true"></span>in chat</span>` : ""}${a.builtin ? `<span class="sr-only"> · built-in</span>` : ""}</div>
        <p class="desc">${esc(a.desc)}</p>
        <div class="foot">
          <span class="meta">${MODELS[a.model || "default"]} · ${(a.reasoning || "Default").toLowerCase()}</span>
          <button class="btn-soft" data-chat="${a.id}" ${live ? "disabled" : ""}>${live ? "Chatting" : "Chat"}</button>
        </div>
      </div>
    </li>`;
  });
  if (state.kind !== "builtin" && !needle) {
    cards.push(`<li class="card is-new" style="--tilt:${TILTS[shown.length % TILTS.length]}deg;--i:${shown.length}">
      <button class="frame" data-new>
        <span class="photo-empty"><span class="plus"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></span></span>
        <span class="caption" style="display:block">New agent</span>
      </button>
      <span class="note" aria-hidden="true">build your own
        <svg width="40" height="28" viewBox="0 0 46 30"><path d="M4 26c4-16 18-22 36-16M34 4l6 6-8 3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </span>
    </li>`);
  }
  $("team").innerHTML = cards.join("");
  drawPins();
}

/* A pin head drawn at the top of every card. */
function drawPins() {
  const board = $("board").getBoundingClientRect();
  const pts = [...document.querySelectorAll(".card:not(.is-new)")].map(li => {
    const r = li.querySelector(".pin-anchor").getBoundingClientRect();
    return { x: r.left - board.left, y: r.top - board.top, live: li.dataset.live === "true" };
  });
  const pin = p => `<g transform="translate(${p.x} ${p.y})">
    <ellipse cx="4" cy="15" rx="5" ry="2" fill="rgb(16 24 32 / 22%)"/>
    <path d="M1 2l2 12" stroke="#8A969D" stroke-width="2" stroke-linecap="round"/>
    <circle cx="0" cy="0" r="10" fill="url(#pin-${p.live ? "red" : "blue"})"/>
    <circle cx="0" cy="0" r="10" fill="none" stroke="rgb(16 24 32 / 25%)"/>
    <ellipse cx="-3.5" cy="-3.5" rx="3.4" ry="2.2" fill="#fff" fill-opacity=".7" transform="rotate(-35 -3.5 -3.5)"/>
  </g>`;
  $("pins").innerHTML = `<defs>
    <radialGradient id="pin-blue" cx=".35" cy=".3" r=".75"><stop offset="0" stop-color="#8CC8F0"/><stop offset=".45" stop-color="#3691CD"/><stop offset="1" stop-color="#1D5A86"/></radialGradient>
    <radialGradient id="pin-red" cx=".35" cy=".3" r=".75"><stop offset="0" stop-color="#FF8A80"/><stop offset=".45" stop-color="#E5322D"/><stop offset="1" stop-color="#9E1712"/></radialGradient>
  </defs>${pts.map(pin).join("")}`;
}

/* ---- events */
let toastT;
const toast = msg => { const t = $("toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 1800); };
$("q").addEventListener("input", e => { state.q = e.target.value; render(); });
document.addEventListener("click", e => {
  const el = e.target.closest("[data-kind],[data-chat],[data-edit],[data-new],[data-clear]");
  if (!el) return;
  if (el.dataset.kind) { state.kind = el.dataset.kind; render(); }
  else if (el.dataset.chat) { state.current = el.dataset.chat; render(); toast(`Now chatting with @${AGENTS.find(a => a.id === el.dataset.chat).handle}`); }
  else if (el.dataset.edit) toast(`Opens AgentDialog for ${AGENTS.find(a => a.id === el.dataset.edit).name}`);
  else if (el.hasAttribute("data-new")) toast("Opens AgentDialog in create mode");
  else if (el.hasAttribute("data-clear")) { state.q = ""; $("q").value = ""; render(); }
});
$("theme").addEventListener("click", () => {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  root.dataset.theme = dark ? "light" : "dark";
});
new ResizeObserver(() => drawPins()).observe($("board"));
// entrance animation moves cards; redraw once it settles, and again when fonts change line heights
$("team").addEventListener("animationend", () => requestAnimationFrame(drawPins));
document.fonts && document.fonts.ready.then(drawPins);
render();
</script>
</body>
</html>
```
