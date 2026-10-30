# truex · Application design specification

Version 2.2 · 28 Oct 2026 · applies to every surface of the truex application (`app.tsx` and anything that replaces it).

This document is the contract the application follows. It is written from the design system in `system/` and states every value, rule and behaviour that system defines. When this document and a study file disagree, this document wins; when this document and a foundation CSS file (`type.css`, `color.css`, `space.css`, `corner.css`, `primitives.css`, `patterns.css`) disagree on a value, the CSS file wins and this document is corrected.

Rule words: **must** = required, a review blocks without it. **must not** = forbidden. **should** = default; deviate only with a written reason in the PR.

---

## Contents

0. [Status, sources and precedence](#0-status-sources-and-precedence)
1. [The ten system laws](#1-the-ten-system-laws)
2. [Setup: files, fonts, theme resolver](#2-setup-files-fonts-theme-resolver)
3. [Typography](#3-typography)
4. [Colour and themes](#4-colour-and-themes)
5. [Space, layout and elevation](#5-space-layout-and-elevation)
6. [Corners](#6-corners)
7. [Icons](#7-icons)
8. [Motion](#8-motion)
9. [Primitives (`tx-`)](#9-primitives-tx-)
10. [Patterns (`pt-`)](#10-patterns-pt-)
11. [Application shell and chat screen](#11-application-shell-and-chat-screen)
12. [Stream components (inside a reply)](#12-stream-components-inside-a-reply)
13. [Blocking requests (approvals and questions)](#13-blocking-requests-approvals-and-questions)
14. [Activity Panel](#14-activity-panel)
15. [Agents: team board and Agent ID desk](#15-agents-team-board-and-agent-id-desk)
16. [Data visualisation](#16-data-visualisation)
17. [Content, voice and formats](#17-content-voice-and-formats)
18. [Accessibility contract](#18-accessibility-contract)
19. [Decisions, deviations and migration](#19-decisions-deviations-and-migration)
20. [Review checklist](#20-review-checklist)
21. [Changing the system](#21-changing-the-system)

---

## 0. Status, sources and precedence

### 0.1 Chapter status

| Chapter | File (code) | Study page | Status |
|---|---|---|---|
| 01 Typography | `system/type.css` | `system/index.html` | **Locked** 25 Oct 2026 |
| 02 Colour & themes | `system/color.css` | `system/02-color.html` | **Locked** 26 Oct 2026 |
| 03 Space, radius, elevation, layout | `system/space.css` | `system/03-space.html` | **Locked** 26 Oct 2026 |
| 04 Corners | `system/corner.css` | `system/04-corners.html` | Proposal, ready for sign-off; ships as the default |
| 05 Primitives | `system/primitives.css` | `system/05-primitives.html` | Proposal, ready for sign-off; ships as the control layer |
| 06 Patterns | `system/patterns.css` | `system/06-patterns.html` | Proposal, ready for sign-off; ships as the composition layer |
| Icons | sprite in each screen | `system/icon-foundations.html` (rev 02) | Direction set: the rev-02 continuous hand is the approved drawing; 5 of 34 glyphs drawn, full set awaiting sign-off. The five chat-sprite glyphs (`i-run i-agent i-trace i-tool i-search`) are **pre-rev-02 geometry** and must be redrawn to rev 02 before shipping (section 7.3). |
| Charts | — | `system/chart-studies.html` | Applied study: forms on trial, colour and type locked |
| Screens | `system/screens/*` | each `.html` | Working designs; the components the app ports |

Proposal chapters are used as written. Until they are locked, a change to them is still a system change (section 21), not a local edit.

### 0.2 Layering

```
type.css · color.css · space.css     foundations: every value lives here
corner.css                           curvature (loaded after page styles in studies; after foundations in the app)
primitives.css   (.tx-*)             every control
patterns.css     (.pt-*)             arrangements of controls
screen / product CSS                 layout of one surface; no new values
```

Each layer may only consume the layers above it. A pattern must not invent a control; a screen must not invent a colour, size, radius, shadow or font.

Conflicts between layers that already exist are resolved in section 19 (Decisions, deviations and migration). Where a screen is newer than the pattern it implements, the screen's behaviour is ratified there.

### 0.3 Superseded and retired material (do not use)

- `design/.ds2-parts/` — retired draft with a cobalt `#2B3AF0` signal. Inlining its tokens produced a purple UI. Never pull palette from it.
- `design/activity-panel-instrument.html` — rejected look (dials, big charts, metal chips).
- `design/activity-panel-turn-clean.html` and its port `system/screens/activity-panel.*` — superseded by `system/screens/business-activity.*`.
- `system/truex-design-spec.md` — an earlier partial draft (chapters 0–11); merged into this document in 2.0 and removed.
- `system/icon-study.html` — the 45° cut hand; replaced by the continuous hand in `icon-foundations.html` rev 02.
- `Charts-v2-hig.html` and other root-level HTML — reference for chart *forms* only; their type and colour are a different system.

### 0.4 What a change must do

Every PR that touches UI must pass the review checklist in section 20. Anything the system does not cover yet (section 19.4) is built from existing tokens, primitives and patterns only; adding a new token, primitive or pattern is a design-system change (section 21), not a product change.

---

## 1. The ten system laws

These summarise the contracts below. Every review starts here.

1. **Tokens only.** Product CSS contains no raw hex, no raw `px`/`rem` spacing, no raw `box-shadow`, no raw `font-size`, no new radius. A missing value is a missing role: request a token (section 21). The only exceptions are listed in 19.1.
2. **Colour has three jobs.** Signal = interaction, selection, focus, live work. Status (ok / warn / bad) = outcomes, always with a glyph and a word. Identity = agents only. Everything else is ink on chassis.
3. **One primary per surface**, and one per request card. A second signal-filled control cancels the first.
4. **Never colour alone.** Every state carries a glyph and a word; charts carry labels, values and position.
5. **Use the role, not a size.** Thirteen type roles, ten spacing steps, seven radii, three shadow tiers. Nothing in between.
6. **Answer first.** In a turn the answer comes before its evidence; the work log is a fold under it, never between the question and the answer.
7. **Nothing blocking moves.** A request that pauses the turn docks above the composer and cannot scroll away; the composer never leaves the viewport.
8. **Report vs decide.** Decisions (approve, decline, retry, edit, stop, steer) happen in the main chat. The Activity Panel only reports; its most active verb is "Show in chat".
9. **Every motion has a static twin.** Reduced motion removes the movement and keeps every fact.
10. **The narrow twin is part of the design.** Every surface ships its 390 px, 200 % text, keyboard and reduced-motion form. Containers fold by their own width.

---

## 2. Setup: files, fonts, theme resolver

### 2.1 Load order

```html
<!-- 1 · fonts -->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wdth,wght@12..96,75..100,300..800&family=Instrument+Serif:ital@0;1&family=Geist+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<!-- 2 · foundations -->
<link rel="stylesheet" href="type.css">
<link rel="stylesheet" href="color.css">
<link rel="stylesheet" href="space.css">
<link rel="stylesheet" href="corner.css">
<!-- 3 · layers -->
<link rel="stylesheet" href="primitives.css">
<link rel="stylesheet" href="patterns.css">
<!-- 4 · product / screen CSS last -->
```

- All three families are SIL OFL 1.1. Air-gapped deployments must self-host them with the same axes (`opsz 12–96`, `wdth 75–100`, `wght 300–800`; Instrument Serif roman + italic; Geist Mono 400/500/600).
- Fonts load with `display=swap`; every stack falls back to the platform (section 3.1).

### 2.2 Root attributes

| Attribute | Values | Meaning |
|---|---|---|
| `data-theme` | `auto` · `light` · `dark` | the user's choice |
| `data-eff-theme` | `light` · `dark` | the resolved theme; colour and elevation read this |
| `data-contrast` | `system` · `normal` · `more` | the user's contrast choice |
| `data-eff-contrast` | `normal` · `more` | the resolved contrast |
| `data-eff-motion` | `full` · `reduce` | resolved from `prefers-reduced-motion` |
| `data-textsize` | absent · `150` · `200` | text-size override; absent = 100 % |
| `data-ctx` (any subtree) | `light` · `dark` · `light+` · `dark+` | pins a subtree to one full palette (previews, docs) |

### 2.3 Resolver (must run in `<head>`, before first paint)

```js
(function () {
  var r = document.documentElement, pref = "auto", size = "100", contrast = "system";
  try {
    pref = localStorage.getItem("tx-sys-theme") || "auto";
    size = localStorage.getItem("tx-sys-size") || "100";
    contrast = localStorage.getItem("tx-sys-contrast") || "system";
  } catch (e) {}
  r.dataset.theme = pref;
  r.dataset.contrast = contrast;
  if (size !== "100") r.dataset.textsize = size;
  var dark = pref === "dark" || (pref === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
  var more = contrast === "more" || (contrast === "system" && matchMedia("(prefers-contrast: more)").matches);
  r.dataset.effTheme = dark ? "dark" : "light";
  r.dataset.effContrast = more ? "more" : "normal";
  r.dataset.effMotion = matchMedia("(prefers-reduced-motion: reduce)").matches ? "reduce" : "full";
})();
```

- Storage keys are `tx-sys-theme`, `tx-sys-size`, `tx-sys-contrast`. The product follows the OS by default; a choice is stored per device.
- After load, listen to `prefers-color-scheme` (re-resolve only while `theme === "auto"`), `prefers-contrast` and `prefers-reduced-motion`.
- Study pages also accept `?theme=`, `?textsize=`, `?contrast=` URL overrides. The app may keep them for QA.
- `forced-colors` is a manual review item: glyphs and borders must carry meaning on their own.

### 2.4 Brand mark

- Wordmark: lowercase `truex`, `.pt-brand-word` (Bricolage 800, `--cut-brand`, tracking −0.045em). In the application sidebar it is one step up the scale (`--t-h3`). Source: `patterns.css` and `chat.css`.
- Favicon / application mark: a rounded rectangle filled with `--signal` (`#3691CD`) holding two white eyes. It is the only place signal appears as a brand fill, and it is not a control. Source: `.app-mark` / `.cs-app-mark`.

---

## 3. Typography

*Set like an instrument.* One grotesque carries the interface, one serif signs it, one mono measures it. Source: `type.css`.

### 3.1 Families

| Token | Stack | Job | Never |
|---|---|---|---|
| `--f-ui` | `"Bricolage Grotesque", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif` | interface copy, labels, headings, display, agent names, controls, titles | tabular data, code, editorial accents, all-caps prose |
| `--f-serif` | `"Instrument Serif", ui-serif, Georgia, serif` | the one editorial accent: italic phrase at headline size, one hero numeral, a pull quote | UI, body, tables, controls, caps |
| `--f-mono` | `"Geist Mono", ui-monospace, "SF Mono", Menlo, monospace` | micro labels, values, time, receipts, code, columns of figures | prose, headings |

The order of voices never reverses: Bricolage sets the claim, Instrument Serif signs it, Geist Mono records it.

### 3.2 Variable cuts (assigned by role, never by eye)

| Token | Value | Used by |
|---|---|---|
| `--cut-text` | `"opsz" 14, "wdth" 100` | body, lede, ui, meta |
| `--cut-heading` | `"opsz" 48, "wdth" 90` | h3, h4, card titles |
| `--cut-h2` | `"opsz" 96, "wdth" 82` | h2 |
| `--cut-display` | `"opsz" 96, "wdth" 82` | display (h1) |
| `--cut-hero` | `"opsz" 96, "wdth" 80` | hero |
| `--cut-brand` | `"opsz" 48, "wdth" 85` | the `truex` wordmark |

Every role sets `font-optical-sizing: none` so the declared `opsz` renders instead of the browser's guess. `font-synthesis: none` is global: no fake bold, no fake italic.

### 3.3 The thirteen roles

There is no fourteenth size. If a job has no role, it does not ship.

| Role | Class | Family · weight | Size | Line height | Tracking | Cut | Notes |
|---|---|---|---|---|---|---|---|
| Hero | `.t-hero` | UI · 800 | `clamp(3.25rem, 7vw, 6.75rem)` (52–108) | 0.9 | −0.04em | hero | word-spacing 0.06em; one per page |
| Display | `.t-display`, `h1` | UI · 780 | 3.5rem (56) | 0.95 | −0.045em | display | page-defining title |
| Section | `.t-h2`, `h2` | UI · 760 | `clamp(2.25rem, 4.6vw, 3.75rem)` (36–60) | 0.98 | −0.045em | h2 | section/chapter titles |
| Sub-head | `.t-h3`, `h3` | UI · 700 | 1.5rem (24) | 1.15 | −0.03em | heading | answer headline in a turn |
| Card title | `.t-h4`, `h4` | UI · 700 | 1.0625rem (17) | 1.25 | −0.02em | heading | card, panel, state titles |
| Lede | `.t-lede` | UI · 400 | 1.0625rem (17) | 1.55 | 0 | text | max-width 46rem |
| Body | `.t-body`, `body` | UI · 400 | 0.9375rem (15) | 1.55 | 0 | text | all reading copy; max-width 42rem |
| Control | `.t-ui` | UI · 600 | 0.875rem (14) | 1.4 | −0.005em | text | buttons, names, rows |
| Meta | `.t-meta` | UI · 500 | 0.8125rem (13) | 1.4 | 0 | text | secondary lines |
| Micro | `.t-micro` | Mono · 600 | 0.6875rem (11) | 1.3 | +0.12em | — | UPPERCASE, slashed zero; metadata only |
| Editorial | `.t-editorial` | Serif · 400 italic | 2.25rem (36) | 1 | −0.02em | — | one accent phrase |
| Numeral | `.t-num` | Mono · 500 | 2.25rem (36) | 1.1 | 0 | — | tabular, slashed zero; headline figures |
| Code | `.t-code`, `code kbd samp pre` | Mono · 400 | 0.86em (13.8 at 15) | 1.55 | 0 | — | slashed zero |

Tokens: `--t-hero --t-display --t-h2 --t-h3 --t-h4 --t-lede --t-body --t-ui --t-meta --t-micro --t-editorial --t-num --t-code`, matching `--lh-*` and `--tr-*` (`--tr-hero −.04em`, `--tr-display −.045em`, `--tr-h2 −.045em`, `--tr-h3 −.03em`, `--tr-h4 −.02em`, `--tr-ui −.005em`, `--tr-micro .12em`, `--tr-editorial −.02em`).

Heading tags map to roles by default (`h1`→display, `h2`→section, `h3`→sub-head, `h4`→card title) with `margin: 0` and `text-wrap: balance`. Paragraphs: `margin: 0 0 .75em`, last child 0, `text-wrap: pretty`.

Weights in use: 400, 500, 550, 600, 650, 700, 760, 780, 800 (Bricolage); 400 (Serif); 400, 500, 600 (Mono). Body never exceeds 500; controls sit at 600; 760+ is display and headings only. Names and titles in UI sit at 600–650.

### 3.4 Utilities

| Class | Effect |
|---|---|
| `.mono` | mono family, slashed zero |
| `.num` | mono, `tabular-nums`, `"tnum" 1, "zero" 1`, letter-spacing 0 — use for every inline figure |
| `.measure` | `max-width: var(--measure-body)` (42rem) |
| `.measure-lede` | `max-width: var(--measure-lede)` (46rem) |

Other measure: `--measure-meta: 52rem` caps wide metadata and secondary tables that may run past the 46rem lede measure. Rhythm: `--baseline: 1.453125rem` (15 × 1.55 = 23.25 px).

`::selection` = `--signal-soft-2` behind `--ink`.

### 3.5 Numerals

- Every figure is Geist Mono with tabular numerals and a slashed zero (`.num` or `.t-num`). Changing a digit must never move a column.
- Group thousands, fix decimals, right-align columns of figures.
- Timestamps hold their width (`00:04:38`).
- Direction is arithmetic, not judgement: a rising expense and a rising revenue carry the same glyph (↑ / ↓). Colour never travels without the glyph.
- Instrument Serif gets exactly one numeral per surface, and only when that figure is the headline. Figures in tables, receipts and comparisons go back to mono.
- Inline figures inside body copy step into mono (`.num`) at ≈ 0.92em so the column rhythm holds without dwarfing the prose.

### 3.6 Editorial accent (Instrument Serif)

- One italic phrase per surface, at headline size (≥ 1.5rem), inside a Bricolage heading. A second accent is a hierarchy problem.
- Markup: `<h3 class="t-h3">September closes <em>with two exceptions.</em></h3>`. Inside `.t-hero / .t-display / .t-h2 / .t-h3 / .t-h4`, `em` becomes serif italic 400 at 1.04em (hero 1.02em, −0.03em), line-height 0.9, tracking −0.02em, `padding-right: .04em`.
- Permitted: a headline clause; one headline numeral; a pull quote at headline scale.
- Forbidden: buttons, tabs, menus, body copy, table labels, uppercase, over photos, roman (upright) serif, synthetic bold.
- Product uses today: the chat hero heading ("What should we *work on* today?", the `em` in `--signal-ink`), agent captions on the team board and the purpose line on the Agent ID card (printed artwork), the reasoning quote rule in the work log (`.pt-think p`), the context-jar percentage in the trace card.

### 3.7 Micro labels

- `.t-micro`: Geist Mono 600, 11 px, UPPERCASE, +0.12em, `--ink-3`, slashed zero.
- Metadata only, never instructions, never prose, never headings.
- Separate tokens with a middot `·`, never a dash: `TURN 04 · STREAM · 00:04:38`.
- Category first, then the name: `TOOL · STRIPE`. A count always pairs with a state word: `OPEN 02`. Units stay lowercase: `38.2k tokens`. Relative time is never combined with a date: `Updated 4m ago`.
- On inverse surfaces the label keeps its rank; only colour changes.
- Dense panel eyebrows may tighten to +0.1em where +0.12em is too wide for the space.

### 3.8 Measure and alignment

- Body stops at 42rem; ledes at 46rem.
- Left align. Never justify. Never centre more than two lines.
- Headings `text-wrap: balance`; paragraphs `text-wrap: pretty`.
- No text baked into images; `lang` is always declared; line heights are unitless.

### 3.9 Floors and scaling

- 11 px is the metadata floor; 13 px is the floor for anything essential. Body is 15 px at 100 %.
- Everything is `rem`. `html[data-textsize="150"]` sets `font-size: 150%`, `"200"` sets `200%`. At 200 % the page is a larger view of the same page, not a broken one; 200 % is the test, not an edge case.
- Print resets text size to 100 % and lets display roles wrap normally.

### 3.10 Typography rules (reviewer list)

1. Use the role, not a size.
2. One serif phrase per surface.
3. Mono never sets prose.
4. Numbers are tabular.
5. Body lines stop at 42rem.
6. Uppercase lives in mono micro labels; headings are sentence case; caps are never emphasis.
7. Heavy (760+) is display-only.
8. Optical size is a token.
9. No fake styles: no letterspacing on lowercase, no synthetic bold or italic.
10. Small has a floor (11 / 13 / 15).

---

## 4. Colour and themes

*One meaning, four contexts.* One signal hue for everything live and interactive, three glyphed statuses, six reserved identities. Everything else is quiet chassis, authored separately for light, dark and an increased-contrast variant of each. Source: `color.css`. Raw hex lives in that file and nowhere else.

### 4.1 The model

| Job | Tokens | Use | Never |
|---|---|---|---|
| Signal | `--signal*` | primary action, links, selection, focus, live work, progress | data series, decoration, status |
| Status | `--ok* --warn* --bad*` | outcomes, checks, failures, needs-a-decision | identity, selection, data series |
| Identity | `--id-main*`, `--id-1*`…`--id-5*` | agent marks, lanes, receipts, avatars | buttons, status, charts, links |
| Chassis & ink | `--page --surface* --well* --line* --ink*` | everything else | — |
| Chart roles | `--cx-*` | quantitative marks | semantic meaning |

If something is not one of the three jobs, it does not get a hue.

### 4.2 Chassis and ink — what each token is for

| Token | Role |
|---|---|
| `--page` | app background behind every surface |
| `--page-dot` | the 1 px dot texture on page backgrounds (decorative, the only texture with `--hatch`) |
| `--surface` | cards, panels, the chat stage, menus, inputs |
| `--surface-2` | quieter surface: rails, inner panels, folded logs, resolved records |
| `--well` / `--well-2` | recessed areas: segmented track, code, tiles, hover fill on ghost controls |
| `--inv` / `--on-inv` / `--inv-2` | inverse: user bubble, tooltips, dark button, toast in agents board; never long reading |
| `--line` | hairlines and dividers |
| `--line-strong` | structural borders, button borders, dashed planned items |
| `--ctl` | control stems: input border, chevrons, hover border on buttons |
| `--ink` | headings, values, primary copy |
| `--ink-2` | body, secondary copy |
| `--ink-3` | micro labels, hints, captions, timestamps |
| `--hatch` | diagonal hatch for estimated / blocked (waiting) areas |

Dark is a second authoring, never an inversion, opacity recipe or filter.

### 4.3 Signal

| Token | Role |
|---|---|
| `--signal` | marks: focus border, live dot, selected underline, progress fill, switch on |
| `--signal-fill` | the primary button fill (carries `--on-signal` text at AA) |
| `--signal-hover` | primary hover |
| `--signal-ink` | signal-coloured text: links, selected text, live labels |
| `--on-signal` | text on `--signal-fill` |
| `--signal-soft` | selection tint, live pill background, pressed chip |
| `--signal-soft-2` | text selection, stronger selected tint |
| `--signal-glow` | the only translucent tone; the focus halo and live halo |

Signal in use: (1) the one primary action, (2) the selected tab — signal-ink text plus a 2 px signal underline, never a filled block, (3) links in signal-ink, (4) focus — one soft halo plus a signal border, no stacked rings, (5) live — a signal dot with a halo, motion has a static twin, (6) progress — signal fill on a neutral track, always labelled.

Signal is a budget: one primary action, one selected state and one live thing per surface. Selection uses one tint (`--signal-soft`). The light signal is **sky blue `#3691CD`**, never cobalt or indigo.

Focus and selection:
- Focus is a signal border (where the control has one) plus one soft outer halo (`box-shadow: var(--focus)`). No stacked rings, no `outline` rings; the halo follows the corner shape.
- Inside a clipped scroll region (`overflow: clip`), use an inset halo: `box-shadow: inset var(--focus)`.
- Text selection is `--signal-soft-2` behind `--ink` (set in `type.css`).
- A selected item (chip, menu row, current conversation) must use `--signal-soft` + `--signal-ink`, or `--well` for a neutral menu — never a solid signal block.

### 4.4 Status

Each status has three tokens: the base is the mark (dot, border, icon fill), `-ink` is the words, `-soft` is the tint behind them.

| Status | Glyph | Word examples | Tokens |
|---|---|---|---|
| ok | ✓ | Ready, Done, Balanced, Allowed | `--ok --ok-ink --ok-soft` |
| warn | ! | Needs you, Review, Flagged, Waiting for you | `--warn --warn-ink --warn-soft` |
| bad | ✕ | Failed, Refused, Not allowed | `--bad --bad-ink --bad-soft` |

Rules: glyph + word always; ink on soft ≥ 4.5:1; never identity, never a data series, never hue alone. A status that cannot be read in greyscale is not a status. Neutral outcomes the person chose (stopped, declined, skipped) are **not** bad; they use ink and line tokens (`--ink-3`, `--line-strong`, `--well`).

### 4.5 Identity

| Slot | Default name in studies | Light | Dark | Tokens |
|---|---|---|---|---|
| main | the lead / main agent | `#1F2A30` | `#D5DEE2` | `--id-main --id-main-ink --id-main-soft` |
| 1 | first helper | `#6A5E9B` | `#B2A8E0` | `--id-1 --id-1-ink --id-1-soft` |
| 2 | second | `#1E7A5E` | `#7DC2A7` | `--id-2*` |
| 3 | third | `#945069` | `#DC9CB1` | `--id-3*` |
| 4 | fourth | `#64702A` | `#ACB87E` | `--id-4*` |
| 5 | fifth | `#955735` | `#DCA285` | `--id-5*` |

- Assigned in order of first appearance in the conversation and kept for the whole conversation; never reused for another agent.
- There is no seventh hue: the sixth and later helpers take the neutral `main` shape.
- Shape carries identity when hue cannot: avatar initials, the agent silhouette, the lane position.
- Identity colours only the agent's own mark (tile, avatar, dot, lifetime bar, lane, crew hairline, share bar). The agent's *work* (bars, steps) uses status or neutral ink.
- `--eye` / `--eye-hi`: the robot-eye fill on agent marks (`#FFFFFF` light, `#121212` dark).

### 4.6 Chart roles

| Token | Role |
|---|---|
| `--cx-grid` | gridlines |
| `--cx-axis` | axis lines, threshold ticks, "usual" median tick |
| `--cx-track` | empty track |
| `--cx-track-edge` | track edge ring |
| `--cx-data` | single series |
| `--cx-data-hi` | selected / highlighted series, "this turn" dot |
| `--cx-data-mute` | muted series |
| `--cx-r1 … --cx-r4` | ordered ramp, dark → light; an order, not a palette |

### 4.7 Complete token matrix (all four contexts)

Values not restated by an increased context inherit the base of their theme. "=" means same as the column to its left in the same theme.

| Token | Light | Dark | Light + | Dark + |
|---|---|---|---|---|
| `--page` | `#F6F9FA` | `#111111` | = | `#000000` |
| `--page-dot` | `rgb(31 42 48 / 6%)` | `rgb(238 244 246 / 5%)` | = | = |
| `--surface` | `#FFFFFF` | `#171717` | = | `#111111` |
| `--surface-2` | `#FAFCFD` | `#1C1C1C` | = | `#181818` |
| `--well` | `#EEF3F5` | `#242424` | = | `#222222` |
| `--well-2` | `#E3EAED` | `#2C2C2C` | = | `#2C2C2C` |
| `--inv` | `#1F2A30` | `#EEF4F6` | = | = |
| `--on-inv` | `#F6F9FA` | `#171717` | = | = |
| `--inv-2` | `#34434B` | `#B7C3C8` | = | = |
| `--line` | `#E3ECEF` | `#2A2A2A` | `#B4C1C7` | `#474747` |
| `--line-strong` | `#D0DADF` | `#363636` | `#84939A` | `#6E6E6E` |
| `--ctl` | `#849198` | `#5C666B` | `#5F6D73` | `#9AA5AA` |
| `--ink` | `#1F2A30` | `#EEF4F6` | = | = |
| `--ink-2` | `#5F6D73` | `#B7C3C8` | `#3E4A50` | `#D3DDE1` |
| `--ink-3` | `#637077` | `#8B999F` | `#4E5C62` | `#B7C3C8` |
| `--signal` | `#3691CD` | `#5AA8DC` | `#226A9B` | `#7DBDE8` |
| `--signal-fill` | `#2A7AB1` | `#5AA8DC` | `#1F5F8C` | `#7DBDE8` |
| `--signal-hover` | `#226A9B` | `#7BBCE6` | `#184C70` | `#A3D2F0` |
| `--signal-ink` | `#2A72A3` | `#8DC9EF` | `#1C5884` | `#B3DAF3` |
| `--on-signal` | `#FFFFFF` | `#0B1A24` | = | = |
| `--signal-soft` | `#EAF5F8` | `#14283A` | = | = |
| `--signal-soft-2` | `#BCDEE8` | `#1F4461` | `#9CCBE0` | `#24507A` |
| `--signal-glow` | `rgb(54 145 205 / 20%)` | `rgb(90 168 220 / 24%)` | = | = |
| `--ok` | `#0A7344` | `#3FD18A` | `#075C36` | `#6BE0A6` |
| `--ok-ink` | `#0A6A3F` | `#6BE0A6` | `#075C36` | `#8BEBBB` |
| `--ok-soft` | `#E3F4EA` | `#0F2A1D` | = | = |
| `--warn` | `#B87300` | `#F2B64A` | `#9A5F00` | `#FFCB6B` |
| `--warn-ink` | `#8F5300` | `#F6C870` | `#6E3F00` | `#FFD98F` |
| `--warn-soft` | `#FDF3DE` | `#2E2410` | = | = |
| `--bad` | `#C4122F` | `#FF6B7F` | `#9E0B24` | `#FF95A3` |
| `--bad-ink` | `#B0102A` | `#FF8E9D` | `#9E0B24` | `#FFB0BA` |
| `--bad-soft` | `#FCEBED` | `#33141A` | = | = |
| `--id-main` / `-ink` / `-soft` | `#1F2A30` / `#1F2A30` / `#E9EFF2` | `#D5DEE2` / `#E3ECEF` / `#262626` | = | = |
| `--id-1` / `-ink` / `-soft` | `#6A5E9B` / `#594F81` / `#F3F2FE` | `#B2A8E0` / `#CBC5EC` / `#221F2E` | `#544880` / `#443969` / = | `#CBC4F2` / `#DED9FA` / = |
| `--id-2` / `-ink` / `-soft` | `#1E7A5E` / `#1E664F` / `#EAF7F1` | `#7DC2A7` / `#A8D7C4` / `#14261F` | `#006249` / `#00503A` / = | `#A1D9C2` / `#C2E8D8` / = |
| `--id-3` / `-ink` / `-soft` | `#945069` / `#7C4458` / `#FDEFF3` | `#DC9CB1` / `#EABCCA` / `#2D1C21` | `#793B52` / `#632E42` / = | `#EFBACA` / `#F8D2DE` / = |
| `--id-4` / `-ink` / `-soft` | `#64702A` / `#545E26` / `#F2F5E9` | `#ACB87E` / `#C7D0A8` / `#202414` | `#4E5916` / `#3F480D` / = | `#C6D1A1` / `#DBE3C1` / = |
| `--id-5` / `-ink` / `-soft` | `#955735` / `#7C492E` / `#FDF1EA` | `#DCA285` / `#EAC1AC` / `#2D1E16` | `#7A4122` / `#643318` / = | `#EFBFA6` / `#F8D6C5` / = |
| `--eye` / `--eye-hi` | `#FFFFFF` / transparent | `#121212` / transparent | = | = |
| `--cx-grid` | `#E8EEF1` | `#262626` | `#CBD6DB` | `#363636` |
| `--cx-axis` | `#AEBBC1` | `#4A5054` | `#66737A` | `#6E6E6E` |
| `--cx-track` | `#EEF3F5` | `#222222` | = | = |
| `--cx-track-edge` | `#D0DADF` | `#363636` | `#84939A` | `#5A5A5A` |
| `--cx-data` | `#5F6D73` | `#A9B6BC` | `#3E4A50` | `#D3DDE1` |
| `--cx-data-hi` | `#1F2A30` | `#EEF4F6` | = | = |
| `--cx-data-mute` | `#A7B3B9` | `#626C71` | `#66737A` | `#858F94` |
| `--cx-r1 … r4` | `#1F2A30 #5F6D73 #A7B3B9 #D0DADF` | `#E3ECEF #A9B6BC #6E7A80 #3E4549` | = | = |
| `--hatch` | `rgb(31 42 48 / 9%)` | `rgb(238 244 246 / 9%)` | `rgb(31 42 48 / 18%)` | `rgb(238 244 246 / 18%)` |
| `--focus` | `0 0 0 4px var(--signal-glow)` | same | same | same |

Shadows (`--sh-*`, `--key`) live in `space.css` (section 5.7).

### 4.8 Contrast ledger (measured; must stay passing)

Text needs ≥ 4.5:1, marks need ≥ 3:1, in all four contexts.

| Pair | Light | Dark | Light + | Dark + |
|---|---|---|---|---|
| `--ink` / `--page` | 13.86 | 17.00 | 13.86 | 18.91 |
| `--ink-2` / `--surface` | 5.35 | 9.95 | 9.13 | 13.67 |
| `--ink-3` / `--surface` | 5.10 | 6.11 | 6.93 | 10.48 |
| `--signal-ink` / `--page` | 4.92 | 10.55 | 7.14 | 14.24 |
| `--on-signal` / `--signal-fill` | 4.65 | 6.80 | 6.83 | 8.69 |
| `--on-inv` / `--inv` | 13.86 | 16.14 | 13.86 | 16.14 |
| `--ok-ink` / `--ok-soft` | 5.85 | 9.38 | 7.09 | 10.73 |
| `--warn-ink` / `--warn-soft` | 5.59 | 9.75 | 8.03 | 11.32 |
| `--bad-ink` / `--bad-soft` | 6.18 | 7.65 | 7.22 | 9.69 |
| `--signal` / `--surface` (mark) | 3.45 | 6.89 | 5.83 | 9.28 |
| `--ok` / `--surface` (mark) | 5.92 | 9.13 | 8.10 | 11.54 |
| `--warn` / `--surface` (mark) | 3.82 | 9.87 | 5.24 | 12.59 |
| `--bad` / `--surface` (mark) | 6.04 | 6.54 | 8.31 | 9.06 |
| identity, worst of five / `--surface` | 5.25 | 8.05 | 7.39 | 11.28 |
| `--cx-data` / `--surface` | 5.35 | 8.63 | 9.13 | 13.67 |

Also measured: signal-ink on signal-soft 4.69 (light) / 8.42 (dark). The thinnest margin is the primary keycap label in light (4.65), which is why its label is weight 600; do not lighten it.

### 4.9 Colour rules (reviewer list)

1. One signal, one job.
2. One primary per surface.
3. Status keeps its glyph and word.
4. Identity is reserved: agents only, first-appearance order, never reused, no seventh hue.
5. Data is neutral: chart roles only; signal and status stay out of series.
6. Text 4.5, marks 3, in all four contexts; increased contrast is an authored set, never a filter.
7. Dark is authored; never derive it.
8. No decorative colour: soft colours are state surfaces; the only textures are the page dot and the hatch.
9. One glow: `--signal-glow` is the only translucent tone. No coloured shadows, no gradients or glows as ornament.
10. No raw hex in components.

Derived tints with `color-mix(in srgb, <token> N%, <token>)` are allowed in component CSS only for state borders and washes built from existing tokens (for example a request card's `color-mix(in srgb, var(--signal) 32%, var(--line))` border). They must not introduce a new hue.

---

## 5. Space, layout and elevation

*Air is a material.* One 4 px lattice, one continuous corner, one light. Source: `space.css`.

### 5.1 The lattice

| Token | rem | px | Lane | Job |
|---|---|---|---|---|
| `--sp-h` | 0.125 | 2 | optical | nudge inside chips only |
| `--sp-1` | 0.25 | 4 | control | icon ↔ label, label ↔ control inside a field |
| `--sp-2` | 0.5 | 8 | control | control interior, row gap |
| `--sp-3` | 0.75 | 12 | control | compact padding, control groups |
| `--sp-4` | 1 | 16 | control | card padding, default stack, between fields |
| `--sp-5` | 1.5 | 24 | composition | group gap, panel padding, thread gap |
| `--sp-6` | 2 | 32 | composition | block gap, dialog padding |
| `--sp-7` | 3 | 48 | composition | section gap (compact page) |
| `--sp-8` | 4 | 64 | composition | section gap (desktop page) |
| `--sp-9` | 6 | 96 | composition | chapter break, hero air |

Values that do not exist and must not be used: 10, 14, 18, 20, 28, 36, 40, 56, 72.

Rules:
1. Only these ten. A new gap is a token request.
2. Two lanes: control spacing (2–16) inside a component, composition spacing (24–96) between components. Never swap them.
3. Space groups; lines separate. Reach for the next step before reaching for a border; one divider per group at most.
4. Vertical rhythm uses the same ten steps.
5. Use `gap`, not margins. Margins are reserved for type defaults in `type.css`.
6. Optical beats mathematical: a 4 px icon gap or a 2 px pill inset can be right. The lattice guides, the eye signs off.

### 5.2 Proximity

- 4 — label to value, inside one row (and label → control → hint inside a field).
- 8 — row to row, inside one group.
- 16 — field to field (the 1 : 4 ratio does the grouping; no box or rule needed).
- 24 — group to group, inside one block.
- 48 — block to block, inside one section.

Page rhythm: eyebrow → title 8; title → copy 12; copy → actions 24; block → block 48; section → section 96.

### 5.3 Density

Density is a property of the zone, not the screen.

| Zone | Examples | Steps |
|---|---|---|
| Instrument | rail, inspector, tables, turn rows, work log | 4–12 |
| Reading | thread, lede, prose, empty states | 24–32 |
| Composition | page sections, chapter breaks | 64–96 |

One group keeps one tempo. Line, radius and type never change with density; if the type moves it is a different component.

### 5.4 Layout metrics

| Token | Value | Use |
|---|---|---|
| `--wrap` | 80rem (1280) | document and stage content width |
| `--gutter` | `clamp(1.25rem, 4vw, 3rem)` (20–48) | fluid page inset |
| `--topbar` | 3.5rem (56) | application header, sticky offset |
| `--rail` | 14.5rem (232) | navigation rail / sidebar |
| `--rail-collapsed` | 4rem (64) | icon rail; inspector rail |
| `--thread` | 46.25rem (740) | conversation measure; composer and dock width |
| `--inspector` | 22.5rem (360) | Activity Panel width |
| `--inspector-sm` | 20rem (320) | narrow Activity Panel width at ≤ 1220 px (applies to the business-activity panel, not the retired rail) *(new in 2.0)* |
| `--av-xs` | 1.25rem (20) | extra-small avatar *(new in 2.0)* |
| `--av-sm` | 1.5rem (24) | small avatar (1.375rem folds into it) *(new in 2.0)* |
| `--av-md` | 2rem (32) | medium avatar *(new in 2.0)* |
| `--av-lg` | 3rem (48) | large avatar (agents screens) *(new in 2.0)* |
| `--dot` | 0.4375rem (7) | state dot *(new in 2.0)* |
| `--overlay` | 57.5rem (920) | work dialog |
| `--palette` | 33.75rem (540) | command palette |
| `--section-y` | `clamp(3.5rem, 8vh, 6rem)` | page section padding |

Width must reference the token, never a literal (for example, the Activity Panel is `width: var(--inspector)`).

### 5.5 Grid

| State | Columns | Gap | Applies when |
|---|---|---|---|
| Wide | 12 | `--sp-5` (24) | > 72rem |
| Medium | 8 | `--sp-4` (16) | ≤ 72rem |
| Compact | 4 | `--sp-3` (12) | ≤ 40rem |

Tokens: `--grid-cols`, `--grid-gap`. Defaults: `--grid-cols: 12`, `--grid-gap: var(--sp-5)` (24); the two media queries in `space.css` step them to 8 / `--sp-4` (16) and 4 / `--sp-3` (12). Breakpoints are in `rem`, so the grid steps with the text size, not the device. Breakpoints change structure, never spacing values. A component that only works at a breakpoint is conditional, not responsive.

### 5.6 Composition rules

1. Hairline first: structure with 1 px lines and tonal surfaces.
2. One focal point per screen: one claim, one live object, one action.
3. No boxes inside boxes: two levels of container at most; the third becomes a well, a line or nothing.
4. One idea per stanza; if a section needs two focal points it is two sections.
5. Section gaps are not component gaps.
6. The first viewport carries one complete thought.
7. Nothing decorates without meaning: a dot is live, a hatch is estimated or blocked, a grid is a canvas.

### 5.7 Elevation

One light, above and slightly in front. If a surface does not overlap the page, it does not cast.

| Tier | Token | Use |
|---|---|---|
| T0 | `--line` only | page, table, in-flow panel |
| T1 | `--sh-1` | resting card, topbar, current nav item, chat stage |
| T2 | `--sh-2` | popover, menu, hover lift, request card, user bubble |
| T3 | `--sh-3` | dialog, sheet, command palette, toast, inspector drawer, Activity Panel shell |
| Press | `--key` | keycap edge on buttons; 1 px of travel on press |
| Focus | `--focus` | one 4 px signal halo, never stacked |

Values (light): `--sh-1: 0 1px 0 rgb(255 255 255/70%) inset, 0 1px 2px rgb(31 42 48/5%)`; `--sh-2: 0 1px 0 rgb(255 255 255/80%) inset, 0 1px 2px rgb(31 42 48/5%), 0 10px 24px -12px rgb(31 42 48/14%)`; `--sh-3: 0 1px 2px rgb(31 42 48/6%), 0 24px 48px -18px rgb(31 42 48/22%)`; `--key: inset 0 -1.5px 0 rgb(31 42 48/10%), 0 1px 2px rgb(31 42 48/8%)`. Dark overrides live in the same file (`:root[data-eff-theme="dark"]`).

Rules: border and shadow travel together (a shadow never replaces the hairline); two raised levels at most; only the signal may glow (focus, live, primary).

---

## 6. Corners

*The edge, without the snap.* Radius sets the footprint; corner shape sets the curvature. Source: `space.css` (radii) and `corner.css` (shape).

### 6.1 Radius ladder

| Token | px | Surface |
|---|---|---|
| `--r-mark` | 3 | data marks, bars, ticks (round by charter) |
| `--r-xs` | 6 | badges, swatches, checkbox, kbd, reference chips, small tiles |
| `--r-sm` | 10 | inputs, buttons-as-rows, menu rows, nav rows, tiles |
| `--r` | 14 | cards, wells, popovers, menus, composer, toasts |
| `--r-lg` | 22 | panels, boards, sheets, chat stage, Activity Panel, request cards |
| `--r-xl` | 30 | stage surfaces, large overlays, the shell frame |
| `--r-pill` | 999 | buttons, status pills, chips, switches, segmented controls |

### 6.2 Shape

- Rectangular surfaces use the continuous superellipse: `corner-shape: squircle` (K = 2, exponent 4, G2 continuous). `corner.css` applies `:where(html *) { corner-shape: var(--corner-mode) }` inside `@supports (corner-shape: squircle)`, so any component can override at zero specificity.
- The universal rule reads `var(--corner-mode)` (default `var(--corner-surface)`); set `--corner-mode: round` on a subtree to flatten all surfaces to circular arcs without touching the round charter.
- Chromium (139+) renders it natively. Safari and Firefox ignore the property and draw the same radius as a circular arc: same box, same hit area, 0 px layout shift. No masks, clip paths or extra nodes, ever.

### 6.3 The round charter

These keep the circular arc in every mode because their shape carries meaning:

- live state (live dot, pulse) — a process happening now
- people and agents (avatars) — identity is circular
- status glyph circles
- capsules (buttons, chips, pills, segmented controls, switches) — the round end is the affordance
- data marks (`--r-mark`)
- the brand mark

Registered in `corner.css` by class (`.tx-btn .tx-pill .tx-chip .tx-seg .tx-seg button .tx-switch .tx-meter .tx-bar .tx-ring .tx-spin .tx-pulse .tx-dot .pt-user .agent-avatar .live-dot …`). New round components opt out with `data-corner="round"` (or by registering the class). A component that must stay continuous while sharing a round class uses `data-corner="continuous"`.

Shape grammar (from chapter 05): **capsule = press, squircle = hold, circle = state, 3 px mark = measure.**

### 6.4 Nesting

`r_inner = max(0, R_outer − p)` where `p` is the inset. Example: a 30 panel with 16 padding holds a 14 card; 22 with 8 holds 14. Never repeat the outer radius inside an inset (it pinches the gap). Correct the radius, not the padding.

```css
.panel__inner { border-radius: max(0px, calc(var(--r-lg) - var(--sp-4))); }
```

### 6.5 Corner rules

1. Use the ladder; never a raw number.
2. One radius per component; never mix a 22 shell with a 10 row and a 6 chip inside it without nesting math.
3. Top-only radius for anchored tabs; their bottom corners belong to the panel.
4. Do not inflate the radius to fake softness.
5. Do not use a mask for a corner the engine can draw.

---

## 7. Icons

Status: icons follow the continuous hand (`icon-foundations.html`, revision 02), the approved direction for drawing; 5 of 34 glyphs are drawn; the full set awaits sign-off. Until then, screens use the 24 × 24 line sprite already in `system/screens/chat.html` — and that sprite's five glyphs are still the pre-rev-02 geometry, so the screens do not yet ship the rev-02 hand even for those ids. The five chat-sprite glyphs (i-run, i-agent, i-trace, i-tool, i-search) must be redrawn to the rev-02 continuous hand before shipping (section 7.3).

### 7.1 Geometry

| Property | Value |
|---|---|
| Canvas | 24 × 24, 2 u safe area, 20 u keyline |
| Stroke | 1.75, round caps and joins, `fill: none` |
| Container corner | 6 u K2 squircle (same curve as surfaces) |
| Fillets | 1.5–2 u (2 u bends, 1.5 u tool vertices) |
| Semantic dot | 2.7 u, filled, only where it means something (agent eyes, trace node, tool socket) |
| Bevels / 45° cuts | none (removed in rev 02) |
| Lenses and dots | stay round (round charter) |

At 16 px: 1.17 px stroke, 1.8 px dot, 1.0–1.33 px fillet. Draw at 24, approve at 16; if a detail dies at 16 it was not needed. One drawing serves 16 / 20 / 24 / 32 / 48 — no small redraws.

### 7.2 Use

- `.tx-ic` (1rem), `.tx-ic-sm` (0.8125rem), `.tx-ic-lg` (1.25rem); `vertical-align: -0.18em`; `stroke: currentColor`.
- Icons inherit colour. States: default `--ink-2`, hover `--ink`, active/selected `--signal` (or `--signal-ink`), disabled `--ctl`. The shape never changes between states. No identity hue in UI icons.
- Decorative icons are `aria-hidden="true"`; an icon-only button must have an `aria-label`.
- Sprite: one hidden `<svg aria-hidden="true" focusable="false">` of `<symbol>`s, referenced with `<use href="#i-…">`.
- Connector logos (Google, Slack, Figma, Notion, GitHub, HubSpot, Stripe …) are brand marks, not system icons: show each in a 2rem tile with an inset hairline. An unknown connector falls back to a mono first-letter mark.

### 7.3 Current sprite (ids)

`i-run i-agent i-trace i-tool i-search` — the sprite shipped in `system/screens/chat.html`; these are the **pre-revision-02 geometry** (equivalent to the `o-*` symbols in `icon-foundations.html`), not the rev-02 continuous hand. The five continuous rev-02 samples (`n-run n-agent n-trace n-tool n-search`) exist only in `icon-foundations.html` and have not yet been ported into the screen sprite. When rev 02 is signed off, the chat sprite's five glyphs must be replaced with the `n-*` geometry. · `i-dock-sidebar i-dock-search i-dock-plus i-dock-bot i-dock-activity i-dock-user` · `i-book i-chev i-chev-down i-chev-updown i-check i-x i-share i-moon i-sun i-sunrise i-sunset i-copy i-activity i-list i-sigma i-layers i-clock i-shield i-file i-lock i-sheet i-slides i-code i-text i-discuss i-download i-retry i-pen i-help i-compact i-plug i-paperclip i-globe i-alert i-ban i-stop i-spark`. The Activity Panel adds `i-chev-l i-eye i-db i-chart i-hand i-chat i-out i-back`.

Duplicated aliases in the screens (`chevd`/`chev-down`, `chevl`/`chev-l`, `chevr`/`chev`, `warn`/`alert`) should collapse to one id each when the full set is drawn, so swapping in the drawn set is a sprite change only.

### 7.4 Planned full set (34)

Execution 5: run, stop, pause, retry, clock · Agents 4: agent, crew, fork, handoff · Tools 5: tool, command, link, plugin, key · Data 5: chart, table, receipt, trace, pulse · Files 5: file, folder, upload, download, copy · System 10: search, settings, help, lock, close, plus, check, warning, error, chevron. The set stays deliberately small; a new glyph is a system request.

---

## 8. Motion

Motion is physics or it is noise. Tokens are local to `primitives.css` until a motion chapter locks them.

### 8.1 Tokens

| Token | Value | Use |
|---|---|---|
| `--tx-d-1` | 120 ms | press and hover; reads as instant |
| `--tx-d-2` | 200 ms | state change: switch, selection, fold, chevron |
| `--tx-d-3` | 320 ms | arrival: toast, meter, drawer, request rise |
| `--tx-ease` | `cubic-bezier(0.2, 0.8, 0.2, 1)` | default easing |
| `--tx-spring` | `cubic-bezier(0.34, 1.4, 0.64, 1)` | toggles and arrivals that may overshoot |
| `--tx-tap` | 1px | press travel |

### 8.2 Three springs

**Three springs (design intent — not yet tokenised).** The motion study describes three damped responses; today the code expresses only one spring curve (`--tx-spring: cubic-bezier(0.34, 1.4, 0.64, 1)`) applied at `--tx-d-2` / `--tx-d-3`. The 400 ms (Arrive) and 480 ms (Toggle) durations and the per-spring ζ values below are provisional and will be locked with the motion chapter (section 19.4). Until then, treat the table as the target, not a contract. Only `--tx-d-1` / `--tx-d-2` / `--tx-d-3` (120 / 200 / 320 ms) and `--tx-spring` exist as tokens.

| Spring | ζ | Duration | Overshoot | For |
|---|---|---|---|---|
| Confirm | 1.00 | 320 ms | 0 % | dialogs, sheets, Approve; arrives once, no bounce on a decision |
| Arrive | 0.82 | 400 ms | 0.6 % | toasts, menus, meters filling |
| Toggle | 0.62 | 480 ms | 8.3 % | switch thumbs, chips, segments; overshoot says "this can go back" |

A confirmation never bounces. Press is the only 0 ms frame: the cap moves the instant the finger does.

### 8.3 Rules

1. Animate only `transform`, `opacity` and `background-position`. No `width`, `height` or `filter` animation (meters may transition `width` at `--tx-d-3`; the fold uses `grid-template-rows: 0fr → 1fr`).
2. Transitions only on properties that change.
3. No JavaScript is required for any control state; JS moves data and focus.
4. Every moving thing has a static twin, applied under both `@media (prefers-reduced-motion: reduce)` and `:root[data-eff-motion="reduce"]`:

| Live cue | Static twin |
|---|---|
| `.tx-spin` spinner | arc holds at 2 o'clock; still "running" |
| `.tx-pulse` ping | halo held at 35 % opacity, scale 1.25 |
| `.tx-shimmer` text | solid `--ink-2`; still "thinking" |
| `.tx-caret` | steady block; still "typing" |
| `.tx-stripes` | static hatch; still "in flight" |
| `.tx-skel` | flat `--well` |
| toast in/out | no animation |
| control transitions | 0.01 ms |
| entry animations (`cs-msg-in`, menus) | none |
| scroll-into-view | `behavior: auto` |
| page scroll | `scroll-behavior: auto` under `prefers-reduced-motion` (`type.css`, `chat.css`) |
| Dock magnification | off; the dock stays visible |
| streaming answer text | whole paragraphs at once |

5. User-driven motion (a drag, a flip the person asked for) may remain under reduced motion; idle and decorative motion must stop.

---

## 9. Primitives (`tx-`)

*The hand knows before the eye.* Every control in the application is one of these. Prefix `.tx-` on every class and keyframe. Source: `primitives.css`. The layer declares no font, no hex, no radius and no colour of its own; it adds geometry and motion only. It ships without JavaScript.

### 9.1 Laws behind the sizes

| Law | Formula | Applied as |
|---|---|---|
| Fitts (hand) | MT = a + b·log₂(2D/W) | default cap 36, confirm cap 44, nothing under 24 |
| Hick–Hyman (choice) | RT = a + b·log₂(n+1) | show 2–4 options; hide the long tail in a menu |
| Damped spring (motion) | x″ + 2ζωx′ + ω²x = 0 | three springs (8.2) |
| Isolation, von Restorff (eye) | the one that differs is found | one primary per surface |
| Proximity, Wertheimer | gap in : gap out = 1 : 4 | 4 inside a field, 16 between |
| Reading rate | t = words ÷ 3.33 + 0.9 s | toast lifetime 4.5 s for ~12 words |
| Peak–end, Kahneman | memory ≈ (peak + end)/2 | every error has an exit |

Grammar rules for every control: one primary; verb + object labels ("Approve & run", never "Submit"); no hover-only actions (every action is visible and reachable by keyboard and touch); never colour alone.

### 9.2 Control geometry

| Token | rem | px | Use |
|---|---|---|---|
| `--tx-h-xs` | 1.5 | 24 | minimum target, dense rails |
| `--tx-h-sm` | 1.75 | 28 | toolbars |
| `--tx-h` | 2.25 | 36 | default |
| `--tx-h-lg` | 2.75 | 44 | focused confirm, touch |
| `--tx-h-field` | 2.5 | 40 | text entry |

24 px is the WCAG target floor; 44 is the comfort target. Small caps are for dense rails, never for the decision.

### 9.3 Index (16 primitives by silhouette)

| Class | Silhouette | Job |
|---|---|---|
| `.tx-btn` | capsule | keycap action |
| `.tx-kbd` | squircle 6 | a key named |
| `.tx-pill` | capsule | state (glyph + word) |
| `.tx-chip` | capsule / squircle 6 (ref) | pick or reference |
| `.tx-tile` | squircle | a glyph held |
| `.tx-seg` | capsule | 2–4 exclusive options |
| `.tx-tabs` | — (underline) | views of one object |
| `.tx-input` (+ `.tx-field`) | squircle 10 | text entry |
| `.tx-switch` | capsule | instant on/off |
| `.tx-menu` | squircle 14 | list of actions |
| `.tx-tip` | squircle 10 | hint on hover/focus |
| `.tx-toast` | squircle 14 | transient confirmation |
| `.tx-meter` / `.tx-bar` | capsule | linear proportion |
| `.tx-ring` | circle | compact proportion / countdown |
| `.tx-spin` (+ live cues) | circle | in flight |
| `.tx-card` (+ `.tx-state`) | squircle 22 | surface and non-happy states |

Plus `.tx-ic` (icons, 7.2) and utilities `.tx-sr`, `.tx-row`, `.tx-stack`.

Silhouette census: 6 capsule (btn, pill, chip, seg, switch, meter) · 7 squircle (kbd, tile, tabs, input, menu, tip, toast/card) · 2 circle (ring, spin) · 1 mark (bar / meter fill).

### 9.4 Button `.tx-btn`

Anatomy: optional leading icon (`.tx-ic`/`.tx-ic-sm`, `aria-hidden`) · label · optional trailing `.tx-kbd`. Gap `--sp-1`.

Base: height `--tx-h` (36); inline padding `--sp-3`; `1px solid --line-strong`; `--r-pill`; `--surface` bg; `--ink`; `--f-ui` `--t-ui` 600, line-height 1, tracking −0.005em; `box-shadow: var(--key)`; `white-space: nowrap`; `touch-action: manipulation`; `user-select: none`.

| Variant | Class | Look | Use |
|---|---|---|---|
| Default | — | surface, line-strong border, key edge | secondary actions |
| Primary | `.tx-primary` | `--signal-fill`, `--on-signal`; resting shadow `inset 0 -1.5px 0 color-mix(--ink 18%, transparent)` (the keycap edge) + `0 4px 12px -6px --signal-glow`; hover `--signal-hover`; active edge flips to `inset 0 2px 0 color-mix(--ink 20%, transparent)` with `0 2px 8px -6px --signal-glow` | the one primary on the surface |
| Dark | `.tx-dark` | `--inv` / `--on-inv`; edge `inset 0 -2px 0 color-mix(--ink 30%, transparent)` (replaces `--key`); hover `--inv-2` | a strong neutral action that is not the primary (e.g. "New conversation" in the sidebar) |
| Ghost | `.tx-ghost` | transparent, `--ink-2`, no shadow; hover `--well` + `--ink` | toolbar, rows, low-emphasis exits |
| Danger | `.tx-danger` | `--bad-ink`, border `color-mix(--bad 55%, --line)`; hover `--bad-soft` | destructive; never the default selection |

| Size | Class | Height | Padding | Gap | Text |
|---|---|---|---|---|---|
| XS | `.tx-xs` | 24 | `--sp-2` | `--sp-h` | `--t-meta` |
| Small | `.tx-sm` | 28 | `--sp-2` | `--sp-1` | `--t-meta` |
| Medium | — | 36 | `--sp-3` | `--sp-1` | `--t-ui` |
| Large | `.tx-lg` | 44 | `--sp-4` | `--sp-2` | `--t-body` |
| Icon-only | `.tx-icon` | square at the current height | 0 | — | needs `aria-label` |

States (frame by frame):

| Frame | Trigger | Change | Time |
|---|---|---|---|
| Rest | — | surface, line-strong, key edge | — |
| Hover | pointer enters | `--surface-2`, `--ctl` border, no travel | 120 ms |
| Press | pointer down | `translateY(var(--tx-tap))` (1px); shadow becomes `inset 0 1px 0 color-mix(--ink 8%, transparent)` (default) / `inset 0 2px 0 color-mix(--ink 20%, transparent)` (primary) | 0 ms |
| Focus | keyboard | `box-shadow: var(--focus)` (one halo) | 120 ms |
| Disabled | `disabled` or `aria-disabled="true"` | opacity 0.45, `not-allowed`, no travel; the UI must say why | — |
| Working | action in flight | label `Working…` / `Sending…` with `.tx-spin` (`--tx-spin-c: currentColor`) | — |

A `.tx-kbd` inside a primary takes `color-mix(--on-signal 18%)` bg and `30%` border.

```html
<button class="tx-btn tx-primary" type="button">
  <svg class="tx-ic tx-ic-sm" aria-hidden="true"><use href="#i-run"/></svg>
  Approve &amp; run <span class="tx-kbd">⌘↵</span>
</button>
<button class="tx-btn" type="button">Review</button>
```

### 9.5 Keycap `.tx-kbd`, `.tx-keys`

`min-width` and height 1.25rem; padding `--sp-h`; `1px --line-strong` with a 2 px bottom lip plus a `0 1px 0 color-mix(--ink 8%, transparent)` under-shadow; `--r-xs`; `--surface`; `--ink-3`; mono `--t-micro` 500. One key is a cap; a shortcut is a row of caps (`.tx-keys`, gap `--sp-1`). A sequence uses the word "then", never a plus. Show `⌘` on Mac and `Ctrl` elsewhere. The platform `⌘`/`Ctrl` swap and the "then" word are a consumer contract — the primitive layer does not implement them.

### 9.6 Pill `.tx-pill`

Height 1.5rem; padding `--sp-2`; `--r-pill`; `--well` / `--ink-2`; `--t-meta` 600. Icon inside at 0.8125rem.

| Class | Meaning |
|---|---|
| `.tx-pill-ok` | good outcome (ok-soft / ok-ink) |
| `.tx-pill-warn` | needs attention (warn-soft / warn-ink) |
| `.tx-pill-bad` | failure (bad-soft / bad-ink) |
| `.tx-pill-live` | running now (signal-soft / signal-ink), usually with `.tx-spin` or `.tx-pulse` |
| `.tx-pill-inv` | inverse emphasis |
| `.tx-pill-line` | neutral outline (Idle, Soon, Built-in, Stopped) |
| `.tx-pill-sm` | 1.25rem, `--t-micro` |

A pill always has a glyph or a word; a status pill has both (✓ Ready · ! Needs auth · × Failed). Glyph names the state, word confirms it, tint only repeats it.

### 9.7 Chip `.tx-chip`, `.tx-chip-ref`

- Pick chip: height 2rem; padding `--sp-3`; `1px --line-strong`; `--r-pill`; `--surface`; `--t-meta` 550. Hover (`button.tx-chip` only) `--surface-2` + `--ctl`. Pressed `aria-pressed="true"` → `--signal-soft` bg, `--signal` border, `--signal-ink`.
- Reference chip `.tx-chip-ref`: height 1.5rem; `--r-xs`; `--well` / `--ink-2`; mono `--t-micro` 500; copies its value on press (e.g. a trace or request id); `.is-copied` → ok-soft / ok-ink for the confirmation.

### 9.8 Tile `.tx-tile`

2rem square (`.tx-tile-sm` 1.5rem `--r-xs`; `.tx-tile-lg` 2.5rem `--r`), `--r-sm`, `--well` / `--ink-2`. Tones: `-signal -ok -warn -bad -inv`. Tiles tint the glyph, not the label; the tone mirrors the pill beside it.

### 9.9 Segmented `.tx-seg`

Track `--well`, padding `--sp-1`, gap `--sp-h`, `--r-pill`, inset 1 px shadow. Buttons 1.75rem high, `--sp-2` padding, `--t-meta` 600, `--ink-2`; hover `--ink`. Selected (`aria-pressed="true"`, `aria-selected="true"` or, as a radiogroup, `aria-checked="true"`) → `--surface`, `--ink`, `var(--sh-1), inset 0 0 0 1px var(--line)`. `.tx-seg-sm`: padding `--sp-h`, buttons 1.5rem. Overflows horizontally without a visible scrollbar.

Use for 2–4 exclusive options, all visible (Plain / Technical; This turn / Session / Project). Five or more is a menu.

When a segmented control is used as a radiogroup (`role="radiogroup"` with `role="radio"` buttons, or `aria-pressed` exclusivity), it must implement arrow-key roving: ←/→/↑/↓ move the selection, Home/End jump to the first/last option, one option is in tab order (`tabindex="0"` on the selected, `-1` on the others), and selection follows the move.

### 9.10 Tabs `.tx-tabs`

Row with a bottom `1px --line`; items `--sp-2 --sp-3` padding, `--t-meta` 600, `--ink-3`; hover `--ink`; selected `aria-selected="true"` → `--ink` and `inset 0 -2px 0 var(--signal)`. Tabs are views of one object, never separate tasks. Must implement `role="tablist"` / `tab` / `tabpanel` with `aria-selected`, `aria-controls`, roving `tabindex` and ←/→/Home/End. The tablist must use roving focus: ←/→ move, Home/End jump to first/last, one tab in tab order (`tabindex="0"` on the selected tab, `-1` on the others), and activation follows the focus move (automatic activation). A count rides in the tab label as `.num` in `--ink-3` ("Files 3").

`.tx-tabs` provides styling only; the `role`/`aria-selected`/roving-`tabindex`/arrow-key behaviour must be wired by the consuming screen (the study wires it per page in `primitives.js`). The primitive itself ships no JS.

### 9.11 Field `.tx-field`, `.tx-input`, `.tx-select`, `.tx-secret`

Anatomy: label (`--t-meta` 600 `--ink`) → control → hint (`.tx-hint`, `--t-meta` 400 `--ink-3`) or error (`.tx-errmsg`). Gap `--sp-1` inside, `--sp-4` between fields. Required marker `.tx-req` (`--bad`, 700). The field label may be a `<label>` or any element with `.tx-label` (same `--t-meta` 600 `--ink` styling).

Input: height `--tx-h-field` (40); padding `--sp-3`; `1px --ctl`; `--r-sm`; `--surface`; `--t-body`; inset 1 px shadow. Hover border `--ink-3`. Focus border `--signal` + `--focus`. Invalid `aria-invalid="true"` → `--bad` border (focus keeps the halo). Disabled `--well` / `--ink-3`. `textarea.tx-input`: min-height 5rem, vertical resize, `--lh-body`. `.tx-input-num`: mono tabular with slashed zero (`"tnum" 1, "zero" 1`). `.tx-select`: native select with a drawn chevron, extra end padding `--sp-7`. `.tx-secret` + `.tx-reveal`: a 2rem reveal toggle inside the field; `aria-pressed` and its label both flip ("Show" / "Hide").

Rules: label above, always (placeholders vanish on the first keystroke and must never name the field). The error names the fix ("Keys are 2–6 uppercase letters, e.g. ONB.") and is tied with `aria-describedby`. Validate on submit; re-check a field live once it is already in error.

### 9.12 Switch `.tx-switch`

`<input type="checkbox" class="tx-switch">`: 2.5 × 1.5rem capsule, `--well-2` track with a `inset 0 0 0 1px --line-strong` line; thumb `1.125rem` inset `3px` from the track, `--surface`, shadow `0 1px 3px color-mix(--ink 28%, transparent)`; checked → `--signal` track (inset line removed), thumb `translateX(1rem)` on `--tx-spring`. Instant on/off, never a save, always reversible. Disabled 0.45.

### 9.13 Menu `.tx-menu`

Panel: min-width `min(15rem, 100%)`, padding `--sp-1`, `1px --line`, `--r`, `--surface`, `--sh-3`. Group header `.tx-menu-h` (mono micro uppercase `--ink-3`). Item `.tx-menu-item`: grid label + trailing (kbd / check), padding `--sp-2 --sp-3`, `--r-sm`, `--t-ui`; optional leading `.tx-ic` in `--ink-2`; `<small>` second line `--t-meta --ink-3`. Hover / selected / pressed → `--well`; selected trailing check in `--signal`. `.tx-menu-danger` → `--bad-ink`, icon `--bad`, hover `--bad-soft`. Separator `.tx-menu-sep` 1 px `--line`.

Behaviour: items are real buttons (`role="menuitem"`, `menuitemradio` with `aria-checked` for single choice); ↑/↓/Home/End move with wraparound; Esc closes and returns focus to the trigger; Tab closes; outside pointer-down closes. Destructive items are never the first selection.

Entry: the `.tx-menu` panel itself ships no entry animation (only `.tx-menu-item` has a background/colour transition). A screen that animates a menu in uses opacity + 4 px translate + scale 0.98 over ≈ 220 ms (the chat account/agent menus do this with `cs-menu-in`), and none of it plays under reduced motion.

### 9.14 Tooltip `.tx-tip`

`.tx-tip` wraps the trigger; `.tx-tip-pop` (inverse, `--r-sm`, `--t-meta` 500, `--sh-2`, max `min(22rem, 100vw − var(--sp-6))`) appears on hover and keyboard focus, below by default, `.tx-tip-up` above; arrow is a rotated 8 px square. Esc dismisses (`data-hidden="true"`) while the trigger keeps focus. Tooltips never carry essential content.

### 9.15 Toast `.tx-toast`

Host `.tx-toast-host`: fixed bottom-right (`--sp-4`), `width: min(22rem, 100vw − var(--sp-6))`, gap `--sp-2`, `aria-live="polite"`. Toast: grid icon / text / close, padding `--sp-3`, `1px --line`, `--r`, `--surface`, `--sh-3`; title `h5` `--t-ui` 650; body `--t-meta --ink-2`; close `.tx-toast-x` 1.5rem. Arrives with `tx-toast-in` (`--tx-d-3`, spring), leaves with `.tx-toast-out`. Lifetime 4.5 s by default; for longer copy it scales to at least words ÷ 3.33 + 0.9 s (9.1). At most three at once; never takes focus. The 4.5 s lifetime and the 3-toast cap are enforced in `primitives.js`, not CSS.

### 9.16 Meter `.tx-meter`, bar `.tx-bar`, ring `.tx-ring`

- Meter: 6 px track (`.tx-meter-lg` 10 px), `--r-pill`, `--cx-track` with inset `--line`; fill `<i>` width `calc(var(--tx-p) * 1%)`, transition `--tx-d-3`. Default fill `--cx-data-hi`; tones `-signal -ok -warn -bad`. Must have `role="meter"` (or `progressbar`) with `aria-valuemin/max/now` and a label; the value is also written as text nearby.
- Bar: 8 px track with a `--signal` fill child; for inline progress.
- Ring: `--tx-sz` (2.5rem) conic fill `--tx-c` (default `--signal`) at `--tx-p` % on `--cx-track`, core `--tx-ring-core` (`--surface`), centre text mono micro tabular. Rim thickness is a fixed `inset: 4px` on the core; default `--tx-p` is `60`. Set `--tx-p` from data or a page clock (countdowns).

### 9.17 Live cues

| Class | Look | Meaning |
|---|---|---|
| `.tx-spin` | 0.875rem ring, top arc `--tx-spin-c` (default `--signal`), 0.8 s | in flight |
| `.tx-pulse` | 8 px `--tx-c` dot + 1.6 s ping ring | live now |
| `.tx-dot` | 8 px dot; `-ok -warn -bad -live -off` | state mark beside a word |
| `.tx-shimmer` | ink-2 text with a signal highlight sweep, 2.2 s | thinking / working label |
| `.tx-stripes` | moving 45° stripes (stripe colour `color-mix(--on-signal 30%)`, 5px/10px −45° repeat, 0.9 s loop) | in flight on a fill |
| `.tx-caret` | blinking signal block after text — the primitive is 0.5em × 1.05em `--signal`, `steps(1)` 1 s blink (the chat screen 11.7 overrides to 0.45em × 1em) | typing |
| `.tx-skel` | `--well` → `--well-2` sweep, 1.6 s | loading placeholder that holds the shape |
| `.tx-hatch` | static `--hatch` diagonals | estimated / blocked |
| `.tx-tape` | warn-soft mono uppercase tag with a dot; letter-spacing `0.08em` (not the `--tr-micro` .12em), height `1.25rem`, `--r-xs`, a `color-mix(--warn 32%)` 1px inset ring and a 5px leading dot | caution tape ("NEEDS AUTH") |

Static twins: section 8.3.

### 9.18 Card and states `.tx-card`, `.tx-state`

`.tx-card`: `1px --line`, `--r-lg`, `--surface`, `--sh-2`; `.tx-card-pad` adds `--sp-4`. `.tx-state`: grid, `--sp-3` gap, title `h4` (card title role), copy `--t-ui --ink-2` at 42rem; `.tx-state-error` borders with `color-mix(--bad 35%, --line)`.

Every list and panel needs three states besides the happy one:

| State | Anatomy | Example |
|---|---|---|
| Empty — an invitation | icon tile · title (≤ 5 words) · one sentence · one action | "No sessions yet" · "Start a session to see turns, plans and files here." · New session |
| Loading — a held shape | skeleton or spinner · title ending in "…" · no action (it already is one) | "Loading activity…" |
| Error — a named failure with an exit | bad tile · title · one sentence of cause with a reference chip · the smallest step forward | "Drive search failed" · "Token expired." `err_7f3a21` · Reconnect / Retry |

A dead end is a design error.

### 9.19 Utilities

`.tx-sr` (visually hidden, kept for assistive tech) · `.tx-row` (wrap row, gap `--sp-2`) · `.tx-stack` (grid, gap `--sp-4`).

---

## 10. Patterns (`pt-`)

*The room knows where you are.* Patterns arrange primitives; they never invent a control, colour, type size or corner. Prefix `.pt-`. Source: `patterns.css`.

Four rules: (1) arrange, never restyle; (2) every control is a `tx-` part — if a pattern needs a new control, the primitive is missing; (3) the narrow twin is part of the pattern; (4) one recurring decision per pattern.

### 10.1 Shell `.pt-shell` (frame that never moves)

- Wrapper `.pt-shell-wrap` sets `container-type: inline-size; container-name: ptshell`. The shell folds by its own width, so the same markup works in a page, a drawer or a preview.
- Grid: `var(--pt-rail-w) minmax(0,1fr) var(--pt-irail-w)` = rail 232 · main · inspector rail 64. Frame `1px --line`, `--r-xl`, `--page`, `--sh-3`.
- Rail `.pt-rail` (`--surface-2`, padding `--sp-3`, gap `--sp-3`): brand (`.pt-brand-mark` 1.5rem `--r-xs` signal tile, `.pt-brand-word` 1.125rem 800 `--cut-brand`, `.pt-brand-sub` mono micro), new-session button, mono micro group labels, `.pt-nav-item` rows (1.5rem icon · label · kbd; min-height 2.25rem; current = `--surface` + `--sh-1`, its kbd in `--signal-ink`), sessions `.pt-session` (title ellipsis · mono time; current `--signal-soft` / `--signal-ink`), crew rows `.pt-crew-row`, user foot `.pt-user` (1.75rem inverse circle). The rows live in `.pt-rail-group` containers inside `.pt-rail-scroll`. When the rail collapses (Docked fold) the new-session button swaps its `.pt-new-label` for `.pt-new-short`, and the user foot's `.pt-user-text` is hidden.
- Topbar `.pt-topbar`: min-height `--topbar`, padding `--sp-1 --sp-4`, `--surface`, bottom `--line`; crumb `.pt-crumb` (mono micro uppercase project / sep `--line-strong` / `.pt-title` in `--t-ui` 600 sentence case); actions `.pt-top-actions` at the end. Topbar fold helpers: `.pt-status` / `.pt-turn-chip` / `.pt-cmd-label` (hidden from the Focus fold down) and `.pt-narrow-action` (shown only at Focus), plus `.pt-optional` (dropped at Compact). The crumb separator that hides at Compact is `.pt-crumb-sep` (the general separator is `.pt-sep`).
- Goal strip `.pt-goal`: min-height 2.5rem; mono micro key, goal text ellipsis, 5rem meter, mono figure.
- Inspector rail `.pt-irail`: 64 wide icon column with `.pt-irail-btn` (1.75rem tile + 9 px mono label). The `.pt-irail-lbl` is `.5625rem` (9px) — below the 11px metadata floor; it **must** use `--t-micro` (19.3, migration 19.5).
- Inspector drawer `.pt-inspector`: absolute, width `min(var(--inspector), 100%)`, `--surface`, `--sh-3`, slides in with `translateX` over `--tx-d-3`; scrim `color-mix(--page 52%, transparent)`. Cards `.pt-insp-card` (`--r`, `--surface-2`) with mono key/value rows `.pt-insp-row`; `:target` card gets signal border + focus halo.

Folds (container queries on `ptshell`):

| Frame width | State | Changes |
|---|---|---|
| > 68rem (1088) | Full | rail 232 · thread · inspector rail 64 |
| ≤ 68rem | Docked | rail 64, labels / session list / user text hidden, nav icons centred |
| ≤ 52rem (832) | Compact | inspector rail hidden (drawer stays one gesture away); topbar/goal/dock inset to `--sp-3`; thread padding `--sp-4 --sp-3`; project crumb (`.pt-project` + `.pt-crumb-sep`) and `.pt-optional` actions hidden |
| ≤ 40rem (640) | Focus | rail hidden; `.pt-status`/`.pt-turn-chip`/`.pt-cmd-label` hidden, `.pt-narrow-action` shown; goal text wraps full width and the goal meter shrinks to 3.5rem; command `pre` wraps; thread padding `--sp-3 --sp-2`, dock `--sp-2`; request padding `--sp-2`, actions full-width (min-height `--tx-h`) with their `tx-kbd` hints and the clock hidden; risk pills wrap; evidence rows keep a 26rem min-width and scroll; inspector 100 % wide; metrics one column |
| ≤ 18rem | Extreme | the hero inspector-open narrow action (`.pt-narrow-action[id="hero-inspector-open"]`) is also hidden |

Invariants at every fold: the composer never leaves the viewport; the dock never scrolls; the thread stops at 740 and is fluid below it; inspector and palette are one layer deep and Esc returns focus to the trigger. 232 + 740 + 360 = 1332 exceeds the 80rem page, so the inspector docks as a drawer; the shell decides by its own width.

> The brand word `.pt-brand-word` **must** use `--t-h3` with `--cut-brand`, as the chat sidebar brand already does (`.cs-brand .pt-brand-word`, 11.2). `patterns.css` still sets a raw `1.125rem` (between `--t-h4` 17px and `--t-h3` 24px); that is migration item M15 (19.2 D16, 19.5).

### 10.2 Turn `.pt-turn` (answer first, evidence under it)

Reading order, fixed: **1 question → 2 answer → 3 evidence → 4 work (folded) → 5 receipt → 6 follow-ups.** The work log never sits between the question and the answer; live and complete share one layout (only the caret, the running row and the receipt differ; nothing jumps when the turn settles).

- Thread `.pt-thread` (scroll, padding `--sp-5`) → `.pt-thread-in` (max `--thread`, gap `--sp-5`) → `.pt-turn` (gap `--sp-4`).
- User: `.pt-user-row` right-aligned; `.pt-bubble` max `min(84%, 30rem)`, padding `--sp-2 --sp-3`, radius `--r --r --r-xs --r` (the tail corner is bottom-right), `--inv` / `--on-inv`, `--t-body`, `--sh-2`; meta `.pt-meta` mono micro `--ink-3` ("You · 10:31 ✓ Delivered"; ok part in `.pt-meta-ok`).
- Agent head `.pt-agent-head`: avatar · `.pt-agent-name` (`--t-ui` 650) · `.pt-agent-meta` (mono micro "Main · T4 · 1m 22s").
- Answer `.pt-answer` (gap `--sp-3`): `.pt-answer-h` (h3 role, max 36rem, balance, one serif `em` allowed) · `.pt-answer-body` (body at 42rem; inline figures in `.num` at .92em; links 550).
- Metrics `.pt-metrics`: 3 columns between top/bottom hairlines; key mono micro uppercase, value mono `--t-h4` 500 tabular, sub mono micro.
- Evidence `.pt-evidence`: bordered `--r` table; head row on `--surface-2`; rows `minmax(0,1.6fr) .8fr .7fr .8fr`, `--t-meta`; header row mono micro uppercase; numbers right-aligned mono tabular; `.is-warn` figures in `--warn-ink`; state as a pill. Cells use `.pt-line` (the label cell: `--ink` 550 with an optional mono `small` sub-line) and `.pt-num` (right-aligned mono tabular; `.is-warn` → `--warn-ink`).
- Receipt `.pt-receipt`: mono micro "14 tools · 38.2k tokens · 1m 22s" + "Receipt" link. Follow-ups `.pt-followups`: mono micro key "NEXT" + chips.

### 10.3 Work log `.pt-work` (evidence, folded)

- `<details class="pt-work">` (`--r`, `--surface-2`); summary row: `.pt-work-sq` 1.5rem tile (ok by default; `.is-run` signal, `.is-warn`, `.is-bad`) · `.pt-work-sum` (`<b>` "Worked · 7 steps", `<small>` "Paused before the ledger write") · chevron (rotates 180° open). Open summary gets `--surface` and a bottom hairline.
- Log `.pt-log` → `.pt-step` rows: grid `1.5rem 1fr auto`; node `.pt-step-node` (1.5rem `--r-xs`, mono micro glyph; default `--well` / `--ink-3`, modifiers `.is-sig` → signal, `.is-ok`, `.is-warn`, `.is-bad`); body `<b>` + `.pt-step-sub` (micro `--ink-3`); time `.pt-step-t` mono micro, right column.
- Row types: thought (`.pt-think` — summary "Thought for 6s", body in serif italic `--t-ui` with a 2 px `--signal-soft-2` rule, max 38rem), command (`.pt-command` — `--well` block, mono bar with cwd, `pre` with `.pt-prompt` `$` in `--ink-3`), file edit (`.pt-diff` — head on `--surface-2`, `.pt-diff-del` bad-soft/bad-ink, `.pt-diff-add` ok-soft/ok-ink), tool call, approval resolved (`.pt-audit` — ok-ink micro with `<b>` actor and `code` ref), warning.
- Node tones: thought = signal, command = neutral, done = ok, attention = warn, failure = bad, live = signal.
- Grammar: one fold (the summary is the only always-visible line); one row per event; the node tone and the verb carry the meaning, no prose; time on the right in the same mono column. The answer is never repeated in the log.

### 10.4 Request dock `.pt-dock` (it cannot scroll away)

The product request card is the contract and the pattern follows it. The request-card classes are `.rq-*` (the shell renames approval.css's `.ap` / `.ap-*` → `.rq` / `.rq-*`, e.g. `.ap-time` → `.rq-time`, `.ap-ic` → `.rq-ic`; the part prefixes `.aq-` question, `.at-` tool, `.ar` record, `.el-` elicitation, `.pl-` plan stay). The ring clock, the resolved strip in the dock, and the stacked queue of `.pt-req` are retired and removed from `patterns.css`. The pattern card `.pt-req` follows the product: `--r-lg`, a `.pt-req-step` "n of m" badge and a `.pt-req-time` text countdown (`.is-warn` near expiry).

- `.pt-dock` (flex none, top hairline, gradient wash to `--surface-2`) → `.pt-dock-in` (max `--thread`, gap `--sp-2`).
- Exactly **one** request card is docked at a time, in `.cs-pinned`; there is no stacked queue. Queue position shows **inside** the card as an "n of m" step badge (`.aq-step`, mono micro pill), oldest first. Cards are answered one at a time.
- Request card `.rq` (padding `--sp-3`, `--r-lg`, `1px color-mix(--signal 32%, --line)`, `--surface`, `--sh-2`; scrolls within `max-height: min(48vh, 26rem)`; rises with `rq-in` `--tx-d-3`): head = `.rq-ic` (1.5rem `--r-sm` signal tile; warn tile for a tool request) + `.rq-title` (650 `--t-ui`) + `.aq-step` ("n of m" badge) + `.rq-time` (a **text countdown** pill, `--r-pill`, `--well` / `--ink-2`; `.is-warn` → warn-soft / warn-ink) — the countdown is text, **not** a `.tx-ring`; `.pt-risks` (pills: "Reads 412 lines · Writes 2 entries · No network · Reversible 24h"); decision row `.rq-btns` (one primary, others default/ghost or the tinted `.rq-soft`, `.pt-spacer`, kbd hints "1", "2", "Esc").
- Decision buttons use the **default height** (36 px) — never `tx-sm`. `tx-sm` (28 px) is only for secondary in-card controls (e.g. show details, copy).
- Methods on one card: tool approval (`.at`), question / clarification (`.aq`), secret, plan (`.pl` / `.pt-plan` numbered list; `.is-new` rows tinted `color-mix(--signal-soft 70%, transparent)` with a `--signal-ink` mono "New" label), secret note.
- Rules: spatial constancy (above the composer at every width); one primary decision per request; secrets and plans **always ask** regardless of approval mode — a silent yes is never inferred; after resolution an **ApprovalRecord** (`.ar`) is written into the stream (`.cs-msg-asks` slot) with the decision, actor, badge and reference — there is no resolved strip left in the dock. The expiry is part of the decision.
- Composer `.pt-composer` (`--r`, padding `--sp-2 --sp-2 --sp-1 --sp-3`; `:focus-within` signal border + focus halo); input `.pt-composer-input` borderless body text, min 2.25rem; bar `.pt-composer-bar` (chips, spacer, send `.pt-send`). Held `.pt-composer.is-held` (`--surface-2`, `--sh-1`): input and send hidden, `.pt-held-note` shown ("Held until the request is answered."). `.pt-composer` declares a base `1px solid --line` border (the same as `.tx-card`, which it is always paired with), so its `:focus-within` `--signal` border renders without help from the screen.

The application realises this pattern with the `.rq` request cards (section 13). Section 19 lists where they currently differ.

### 10.5 Inspector (receipt, crew, checks)

One layer deep. Turn receipt rows (Route, Tools, Tokens, Wall, Reference, Crew, Checks), crew list, checks list with dots. Focus returns to the trigger on close. At the focus fold it is 100 % wide with the same close and return. In the application the inspector role is filled by the Activity Panel (section 14).

Cards are `.pt-insp-card` (`--r`, `--surface-2`) with a head (`.pt-insp-head`, `.pt-insp-label`) and key/value rows `.pt-insp-row` (`.pt-insp-k` `--ink-3` key, `.pt-insp-v` mono value). The crew list uses `.pt-insp-crew` rows and the checks list uses `.pt-insp-check` rows, each with a `.tx-dot`.

### 10.6 Palette `.pt-palette` (recognition over recall)

- Overlay `.pt-palette-overlay` (scrim `color-mix(--page 58%)`, top padding `max(2rem, 11%)`); panel width `min(var(--palette), 100%)`, max-height 84 %, `--r-lg`, `--sh-3`, enters with `pt-palette-in` (`--tx-d-2`).
- Input row: mono `›` prompt in `--signal-ink`, borderless 2.25rem input. List: groups (`.pt-palette-group` mono micro — "Go to", "Actions", "Agents"), `tx-menu-item` rows (≥ 2.25rem; label + small description + a trailing kbd hint laid out in `.pt-pal-keys`). Foot: mono micro "↑↓ navigate · ↵ run · Esc close". Empty: "No command matches. Try “receipt” or “session”."
- Keyboard contract: ⌘K / Ctrl+K **toggles** the palette (opens when closed, closes when open); one input filters label and keywords; groups, not a long list; destructive actions live in a danger group and are never the first selection; Enter runs the active option; Esc, scrim click and Enter all return focus to the trigger; no palette inside a palette. This contract is implemented in `patterns.js`, not the CSS.

### 10.7 Pattern states

Each pattern ships empty / loading / error: "A quiet room" (no turn yet) · "Opening the thread…" · "The run lost its connection — The transcript is safe. Reconnect to continue. err_7f3a21 · Reconnect / Retry".

What survives every fold: the answer and its reading order; the request dock and its one primary; the composer (held or free); the audit reference and the ApprovalRecord in the stream; focus return; the static twin. What folds: rail labels → marks → nothing; session and crew lists; inspector rail → drawer → full-width drawer; palette width; request action wrapping; measures and secondary metadata. Never the primary decision. There is no separate mobile design.

---

## 11. Application shell and chat screen

Reference implementation: `system/screens/chat.html`, `chat.css`, `chat.js`. Screen classes use the `cs-` prefix and compose `tx-` and `pt-` parts. This section is the layout and behaviour the application ships.

### 11.1 Regions

```
┌ .cs-shell (flex, padding --sp-2, gap --sp-2, bg --page; dark: --well) ───────────────┐
│ ┌ sidebar ─┐ ┌ .cs-stage (fluid) ─────────────────────────┐ ┌ activity panel ─┐ │
│ │ --rail   │ │ topbar --topbar                             │ │ --inspector     │ │
│ │ 232      │ │ .cs-scroll: hero (new) or thread (≤ 740)    │ │ 360             │ │
│ │          │ │ .cs-bottom: pinned request + composer (740) │ │                 │ │
│ │          │ │ floating dock (bottom centre)               │ │                 │ │
│ └──────────┘ └─────────────────────────────────────────────┘ └─────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────────┘
```

- Stage `.cs-stage`: `--surface`, `1px --line`, `--r-lg`, `--sh-1`, `overflow: clip` (not `hidden`, so focus and `scrollIntoView` cannot scroll a clipped box).
- Scroll container `.cs-scroll` (`overscroll-behavior: contain`) holds the hero or the thread; `.cs-bottom` holds the pinned request region and composer, padding `0 --sp-5 --sp-3`, with a gradient from transparent to `--surface` at 30 %.
- Shell state classes: `is-new` (no conversation yet), `is-rail-off` (sidebar hidden), `is-act-off` (Activity Panel hidden).
- The Activity Panel region is the locked four-tab panel of section 14 (Business Activity & Traces · Agent info · Files · Insights), built from `business-activity.*`. The inline rail still shipped in the current `chat.html` — an `<aside class="cs-activity" aria-label="Session activity">` with a "Session activity" title, a "Wide" button, and an older Activity/Agents/Files/Plan tablist — is a stale scaffold; it **must** be removed and replaced by the section 14 panel, not restyled (see 19.2).

### 11.2 Sidebar `.cs-sidebar`

Width `--rail`; padding `--sp-4 --sp-3 --sp-3`; `aria-label="Conversations and workspace"`. Top to bottom:

1. **Brand** `.cs-brand` — the `truex` wordmark (`.pt-brand-word` at `--t-h3`, 800, `--cut-brand`), links to top; focus = `--r-xs` + `--focus`.
2. **New conversation** — `tx-btn tx-dark` full width, height `--tx-h`, `--t-meta`, "+ New conversation" with trailing kbd `⌘J` pushed to the end.
3. **Workspace nav** `.cs-side-nav` (`aria-label="Workspace"`, bottom hairline): ghost rows 2rem high, `--t-meta` 500, icon `--ink-3` → `--ink-2` on hover. Items: Agents · Knowledge base (**Soon**).
   - Not-yet-built items stay in place so the map is honest: `aria-disabled="true"`, `aria-label="Knowledge base, coming soon"`, `--ink-3`, no hover, icon at 0.7 opacity, trailing `tx-pill tx-pill-line tx-pill-sm` "Soon". Use `aria-disabled`, not `disabled`, so the item stays focusable and announced.
4. **History** `.cs-side-scroll` (scrolls, gap `--sp-4`): groups **Today · Previous · Last 30 days · ‹Month›**, labels `--t-micro` 600 `--ink-3`. Rows `.pt-session.cs-session`: ghost, min-height 2rem, `--t-meta` 500; title ellipsis; time mono micro (relative within today — "12m", "1h"; weekday within the week — "Sun"; date beyond — "Oct 18", "Sep 26"). Current row `aria-current="page"` → `--signal-soft` / `--signal-ink`. Older groups start hidden behind **View all conversations** (`tx-btn tx-ghost tx-xs`, `aria-expanded`, `aria-controls`); it toggles to "Show less" and scrolls the first revealed row into view (reveal animates 0.5 s, none under reduced motion).
5. **Account** `.cs-side-foot` (top hairline, pinned to bottom): ghost row min-height 2.75rem — `--av-md` (2rem) round avatar (initials, `--well-2` / `--ink-2`, micro 650) (`--av-md` new in 2.0), name (`--t-meta` 600) and role (`--t-micro` `--ink-3`), up/down chevron. Opens an upward menu of the row's width (`--sh-2` + 1 px line ring): **Settings `⌘,` · Keyboard shortcuts `?` · Help and feedback · — · Sign out**. Menu keyboard per 9.13.

### 11.3 Topbar `.cs-topbar`

Height `--topbar` (56); becomes `.is-slim` (2.75rem) after the first message is sent (0.45 s ease). Padding `0 --sp-3`, `--surface`, bottom hairline, gap `--sp-3`.

- **Left — agent tag** (hidden while `is-new`; a new conversation has no agent yet, the picker sits in the composer): `--av-sm` (1.5rem; the study's 1.375rem folds into this token) round avatar with a `--dot` (0.4375rem / 7 px) state dot on its corner (`--av-sm` and `--dot` new in 2.0) + agent name (`--t-meta` 600) + a visually hidden state word. Dot states: Ready = `--ink-3`; Working = `--ink`, breathing to 35 % opacity every 2.4 s (static under reduced motion); Waiting = the rest dot, with the state word announced. The tag's `data-state` is `ready | working | waiting`. A 1 px × 1rem `--line-strong` divider follows.
- **Centre — title** `.cs-title`: `--t-ui` 500 `--ink-2`, ellipsis. "New conversation" until the first send, then the first prompt truncated to 64 characters + "…". (Other truncations on this screen are independent and must not be confused with the title rule: the reasoning preview cuts at 60 characters, the reply-topic quote at 72, the plan-revise feedback echo at 90, and the ApprovalRecord question/answer at 140/180 — each at a word boundary.)
- **Right — actions**: Share (`tx-ghost tx-sm`, share icon + "Share"; copies the link; label becomes "Link copied" for 1.8 s and the accessible label follows) · theme toggle (icon-only `--tx-h-sm`, moon in light / sun in dark, `aria-label="Switch to dark theme"` / "light").

### 11.4 New-conversation hero `.cs-hero` (shown only while `is-new`)

Centred column, max `--thread`, padding `--sp-6 --sp-5 --sp-5`.

1. **Greeting chip** `.cs-greet`: min-height 1.75rem pill, `1px --line`, `--surface`, `--sh-1`, `--t-meta` 550 `--ink-2`, icon `--ink-3`. Copy by local hour: < 5 "Working late" (moon) · < 12 "Good morning" (sunrise) · < 18 "Good afternoon" (sun) · < 22 "Good evening" (sunset) · else "Working late" (moon); followed by ", ‹user name›".
2. **Heading** `.cs-hero-h` (h1): "What should we *work on* today?" — it **must** use the locked `.t-h2` type role (no new type role is introduced): `--t-h2` (`clamp(2.25rem, 4.6vw, 3.75rem)`), weight 760, `--lh-h2`, `--tr-h2`, `--cut-h2`; balance, max 40rem; the `em` is the surface's one serif accent, in `--signal-ink`. The study still sets a screen-level `clamp(2.125rem, 4.5vw, 2.75rem)`, weight 780, line-height 1.02, −0.045em, `--cut-hero`; that is migration item M17 (19.3, 19.5).
3. **Hero composer** (margin-top `--sp-5`): `tx-card pt-composer` with roomier padding (`--sp-3 --sp-3 --sp-2 --sp-4`), no shadow, input min-height 4.75rem, placeholder "Ask anything, or type / for commands". Bar: agent picker (11.6) · mode chip "Ask" · spacer · `tx-btn tx-primary tx-sm` "Send ↵" (disabled until there is text).

### 11.5 Composer (follow-up)

Inside `.cs-bottom`, max `--thread`. `tx-card pt-composer cs-composer` → visually hidden label "Message ‹agent›" → `textarea.tx-input.pt-composer-input` (placeholder "Ask a follow-up or assign a step") → bar: paperclip (12.4) · "Ask" chip (1.75rem, `--t-meta`) · spacer · Stop (`tx-ghost tx-sm`, stop icon, hidden unless the turn is live) · Send (`tx-primary tx-sm`, "Send ↵").

States:

| State | When | Look / behaviour |
|---|---|---|
| Slim | not new, not focused, empty, no files | padding-block `--sp-1`, input min-height 1.75rem (open: 2.25rem), chip 1.5rem micro |
| Open | focused, has text or has files | full padding; grows with content up to 224 px, then scrolls |
| Focus | `:focus-within` | signal border + `--focus` |
| Live | a turn is running or a request is pinned | Stop visible; placeholder changes (below); Send steers if steering is on |
| Drop | files dragged over | dashed 2 px signal overlay "Drop files to attach" (12.4) |

Placeholder by state:

| Situation | Steering on | Steering off |
|---|---|---|
| idle | "Ask a follow-up or assign a step" | same |
| turn working | "Steer this turn: add a note, or press Stop" | "Wait for this reply, or press Stop" |
| paused on a request | "Add a note to this turn, or answer above" | "Answer the request above, or press Stop" |

Send rules: enabled when there is text, or (when not steering) at least one ready attachment; disabled while uploads are in progress or any upload failed, while busy and not steering, or when steering is off during a live turn. When steering, Send's title is "Send. It joins the turn in progress".

Keys: Enter sends; Shift+Enter is a newline; Enter during IME composition is ignored.

Pinned request region `.cs-pinned` (`role="region"`, `aria-label="Waiting for your answer"`) sits directly above the composer with `--sp-2` below it; it holds one request card at a time (section 13).

### 11.6 Agent picker

Chip `tx-chip cs-agent-pick` (`aria-haspopup="menu"`, `aria-expanded`, `aria-label="Agent: ‹name›. Change agent"`): `--av-xs` (1.25rem) avatar (`--av-xs` new in 2.0) · name · chevron (rotates 180° open; open chip `--well` + `--line-strong`). Menu `tx-menu` 17rem (`--sh-2` + 1 px line ring), opens downward or flips up by available room: header "Agents" · `menuitemradio` rows (avatar initials · name · `<small>` purpose · check when selected; selected row `--well`) · separator · "Browse all agents". Choosing an agent updates the chip, the topbar tag, and every composer's hidden label ("Message ‹name›").

### 11.7 Turn anatomy in the thread

Thread `.cs-thread` gap `--sp-5`. Each message enters with `cs-msg-in` (0.28 s, 6 px rise; none under reduced motion).

**User message** (right-aligned, gap `--sp-1`): attached files (DocumentCards, 12.3) → `.pt-bubble` (`white-space: pre-wrap`) → meta "You · HH:MM" (+ " · ‹meta›").

**Agent message** `article` — slots in this fixed order (empty slots collapse):

| # | Slot | Content |
|---|---|---|
| 1 | head | avatar (`--av-sm`, 1.5rem) · name (`--t-ui` 650) · time (mono micro) |
| 2 | think | ThinkingBlock (12.1) |
| 3 | plan | Plan card (12.7) |
| 4 | helpers | HelperGroup (12.6) |
| 5 | tools | ToolActivityRows (12.2) |
| 6 | asks | ApprovalRecords (13.6), steer notes, stopped notice |
| 7 | working | Working indicator until the first words of the answer |
| 8 | body | the answer (`.pt-answer-body`, `pre-wrap`) |
| 9 | error | TurnError, inline where the answer would be (12.5) |
| 10 | files | DocumentCards (12.3) |
| 11 | next | follow-ups, on the latest settled turn only |
| 12 | obs | receipt line + trace card (12.8), stamped once settled |

- Every slot from 2 down is indented `calc(var(--av-sm) + var(--sp-2))` so it aligns under the name; the indent is removed at ≤ 640 px.
- Runtime order: think → (plan / request) → helpers → tools → stream the answer → settle (files, trace, follow-ups).
- `aria-busy="true"` on the agent message while it thinks or works; removed on settle or stop.
- **Streaming caret**: a 0.45em × 1em `--signal` block after the last paragraph while streaming (`steps(2)` blink, static under reduced motion). The answer streams by words; under reduced motion each paragraph appears whole.
- **Follow-ups** `.cs-next`: list of three text rows "↳ ‹question›", `--t-meta` 500 `--ink-2`; hover → `--ink`, underline in `--line-strong`, the arrow moves 2 px and turns `--signal-ink`; staggered entry 60 ms; a row click sends its text. Cleared when a new turn starts.
- **Compaction divider** `.cs-compact` (`role="note"`): dashed `--line-strong` rules either side of "Earlier messages were summarised to free up context." with the compact icon, `--ink-3`. Notices: busy → "Wait for the reply to finish, then compact."; already → "Already compacted. Nothing new to summarise."; empty → "Nothing to compact yet."

### 11.8 Stop and Steer

- **Stop** ends the turn. If a request is pinned, Stop closes it as `stopped`; otherwise it stops the active turn: pending timers are cancelled, thinking and streaming stop, running helpers and tools are marked stopped with their elapsed time, a running plan settles as halted, and a neutral notice is appended in the asks slot: "Stopped by you mid-reply · nothing after this ran · HH:MM" (or "…before it replied…"). The notice is `--ink-3` `--t-meta`, **never an error colour**. Announcement: "Stopped. Nothing else runs in this turn." The turn's outcome is `interrupted`.
- **Steer** is a note typed while a turn is working or paused on a request (policy `steer`). It is placed inside the current reply's asks slot as a user bubble marked "added to this turn" (`.is-steer`, margin-block `--sp-3`) and is read at the agent's next step. Announcements: paused → "Added to this turn. Answer the request above to continue."; working → "Added to this turn. The agent reads it at its next step."; failure → "Couldn’t add that to the turn. Your text is back in the message box." (the text is restored).
- **Nudge**: sending while blocked (steering off or a slash command) announces "Answer the request above, or press Stop." / "This turn is still running. Wait for it, or press Stop.", plays the card's 0.9 s signal ring (`.rq.is-nudge`, none under reduced motion) and focuses the card's first control.
- The Activity Panel only records Stop and Steer (14.7); it never offers them.

### 11.9 Floating dock `.cs-dock`

A workspace dock centred at the bottom of the stage (`aria-label="Workspace"`), six circular 40 px keys with tooltips: **Sidebar ⌘B** (toggle, `aria-pressed`) · **Search ⌘K** · **New chat ⌘J** · **Agent** · **Activity ⌘.** (toggle, `aria-pressed`) · **Account**. Glass background `color-mix(--surface 72%)` with `backdrop-filter: blur(20px) saturate(1.6)`, `--r-lg`. Keys use `corner-shape: round` (true circles).

- Stowed by default (slid down, transparent, inert); rises when the pointer comes within 10 px of the viewport bottom or when a key takes focus; stows again when the pointer leaves its reach — rise when within 10 px of the bottom; stow when the pointer rises more than 24 px above the dock's top edge (a deliberate hysteresis so the dock does not flicker). `.cs-bottom.is-dock-up` reserves 92 px so the composer is never covered.
- Magnification on fine pointers only (two critically damped springs — a pointer spring at ω ≈ 11 rad/s and a presence spring at ω ≈ 7 rad/s, integrated in fixed 0.008 s sub-steps with a cosine falloff over the 140 px reach; base 40, peak 52, reach 140 px, icon scale 60 % of the key growth); off under reduced motion and on touch.
- On `hover: none` devices the dock is static and always visible, without tooltips.
- A key whose region is hidden by a fold is hidden too ("a key for a hidden region is a dead instrument").
- The dock is the one sanctioned raw-pixel component (19.1).

### 11.10 Keyboard map (application-wide)

| Keys | Action |
|---|---|
| ⌘J / Ctrl+J | New conversation |
| ⌘K / Ctrl+K | Command palette / search |
| ⌘B / Ctrl+B | Toggle sidebar |
| ⌘. / Ctrl+. | Toggle Activity Panel |
| ⌘, | Settings |
| ? | Keyboard shortcuts |
| Enter / Shift+Enter | Send / newline (composer) |
| ⌘↵ / Ctrl+↵ | Send feedback (plan revise box) |
| 1, 2, Esc | Request shortcuts where shown on the card (`tx-kbd`) |
| ↑ ↓ Home End | Move inside menus (wraps) |
| ← → Home End | Move between tabs (roving tabindex) |
| Esc | Close menu / tooltip / palette / panel / trace and return focus to the trigger |

Global shortcuts ignore key-repeat. Toggle keys expose `aria-keyshortcuts` (for example `"Meta+B Control+B"`). The application **must** bind every chord in this table, and `aria-keyshortcuts` **must** only advertise chords that are actually bound. (In the current study ⌘J/Ctrl+J, ⌘B/Ctrl+B and ⌘./Ctrl+. are bound in `chat.js`; ⌘K, ⌘, and ? are labelled only and not yet wired — see 19.4 and migration M10 in 19.5.)

### 11.11 Responsive behaviour of the chat screen

| Width | Change |
|---|---|
| ≤ 1220 px | Activity Panel narrows to `--inspector-sm` (20rem) — the token is applied to the Business Activity panel (14), not to the retired inline rail |
| ≤ 1080 px | Activity Panel hidden; its dock key hidden |
| ≤ 880 px | sidebar hidden; its dock key hidden; Share collapses to icon-only |
| ≤ 640 px | shell padding and gap 0; stage loses border and radius; thread padding `--sp-4 --sp-3 --sp-3`; reply indent removed; bottom padding `0 --sp-3 --sp-2` |
| ≤ 520 px | agent name in the topbar hidden (avatar stays); dock tooltips hidden |
| ≤ 400 px | dock gap and padding `--sp-2` |
| text 150 % / 200 % | Activity Panel hidden; at 200 % the topbar agent name and Share label are hidden |

Rule for the application: these media queries are the chat study's; the shipped shell should express them as `ptshell` container folds (10.1) so the shell decides by its own width.

### 11.12 Live announcements

One polite live region (`<p class="tx-sr" role="status" aria-live="polite">`) carries every status sentence: Stop, Steer, compaction, upload results, helper and request changes. Components must route announcements there rather than creating their own live regions (except `role="alert"` for errors that need immediate attention).

---

## 12. Stream components (inside a reply)

Shared conventions for everything in this section:

- **Indent** under the agent name (11.7), removed at ≤ 640 px; cards are capped at 32–36rem so they never outgrow a comfortable read, and go full width at ≤ 640 px.
- **Fold**: header `button[aria-expanded][aria-controls]` → body using `grid-template-rows: 0fr → 1fr` over `--tx-d-2`, with the clip's `visibility` delayed so closed content is not focusable. A fold auto-opens while something is running or failed, and auto-closes when done, **until the reader touches it**; after that it stays where the reader put it.
- **Colour**: signal only for what is live right now; ok / warn / bad for outcomes; identity only on helper tiles; neutral for stopped, declined and skipped.
- **Durations**: `< 10 s` → "6.3s"; `< 60 s` → "12s"; otherwise "1m 5s". Live timers tick on one shared clock (100 ms for tools, 250 ms for helpers).
- **Masking**: masking **must** be one shared function used by every surface — the stream, tool-argument disclosures, WebSearchRow, ToolActivityRow, TurnError and ApprovalRecords. The single rule is: URLs and file paths → "•••"; e-mail → first letter + "•••@domain"; key-like tokens — `sk-`, `pk-`, `rk-`, `api_`, `key_`, `tok_`, or any run of 32+ characters — → "•••". Masking **must** be applied before anything is rendered, including argument disclosures. (The study's `error.js` scrubber already applies the key-token rule to TurnError copy; `activity.js`'s stream/argument masker does not yet carry the key-token rule and must gain it — see 19.)
- **Entry**: cards enter with `cs-msg-in` (0.22–0.28 s); none under reduced motion.

### 12.1 ThinkingBlock

Sits above the answer.

- Head (1.75rem pill-shaped ghost button pulled `--sp-2` into the gutter, `550 --t-meta`, `--ink-2`; hover `--well` / `--ink`): icon (spinner while streaming, `--ok-ink` check when done) · label · word count (mono micro) · chevron (rotates 180° open).
- Body: `--t-meta` / 1.6 `--ink-2` text with a 2 px left rule (`--line`; while streaming tinted `color-mix(--signal 45%, --line)`).

| State | Label | Meta | Body |
|---|---|---|---|
| streaming | "Thinking…" (shimmer) | — | opens automatically; a 7.25rem live window that follows the newest line, with a top fade mask when it overflows |
| done | "Reasoning" | "N words" / "1 word" / "Complete" | folds closed; when reopened scrolls up to 22rem |
| empty | hidden | — | head disabled |

### 12.2 Working indicator, ToolActivityRow, WebSearchRow

**Working indicator** `.wk` (`role="status"`): spinner + shimmer label, min-height 1.75rem; shown while the turn is active, thinking is done and no answer text exists yet. Label follows the latest activity: "Searching the web", "Reading the handbook", "Waiting on 2 helpers", "Waiting for you", "Running ‹tool›", and "Working" between tools and the answer.

**Tool group** `.tg`: one group per reply. Head: icon · label · total time · flag · chevron (rotates 90°). With one call the head is hidden and the row shows directly (`.is-solo`).

| Group state | Icon | Label | Flag |
|---|---|---|---|
| running | spinner | "Using tools" / "Searching the web" | — (live timer) |
| done | check / alert (any failed) / stop (any stopped) | "Used 4 tools" · "Searched the web · 6 steps" · "Used 3 tools and the web" | "1 failed · 1 not allowed · 1 stopped" (only non-zero parts) |

**Row** `.ta` (business-safe: friendly connector + tool name, never the raw command; arguments only behind Details):

| Status | Icon | Name | Extra line |
|---|---|---|---|
| running | spinner | `--ink` | live time |
| done | check (`--ok-ink`) | ‹Connector› · ‹Tool› | summary of the result, ≤ 160 chars at a word boundary + "…"; "Also returned 2 resources."; fallback "Returned structured data." / "Done, no output." |
| failed | alert (`--bad-ink`) | `--bad-ink` | the masked error, or "The tool call failed." |
| declined | ban, muted | struck through in `--line-strong` | "Not allowed · View approval" (links to the ApprovalRecord) |
| stopped | stop, `--ink-3` | muted | "Stopped by you before it finished" |

Optional `tx-pill-line tx-pill-sm` "Read-only" (hidden ≤ 640 px). Details toggle (pill button, chevron 180°) reveals summary + mono uppercase "ARGUMENTS" label + masked JSON `pre` (mono 11 px, `--r-sm`, max 12rem, scrolls). A visually hidden sentence carries the status for screen readers ("Done in 6.3s, 4 sources"); the visible time and icon are `aria-hidden`.

**WebSearchRow**: globe icon (`--ink-3`; `--signal-ink` when done). Labels: "Searching / Searched “‹query›”" (+ "+N" more queries) · "Opening / Opened ‹host›" · "Looking / Looked for “‹pattern›” in ‹host›" · "Using / Used the web". Only the URL host is ever shown. Sources: up to 6 favicon chips (1.375rem pill, letter fallback when the favicon fails, max 12rem, opens in a new tab with `rel="noopener noreferrer"` and a hidden "(opens in a new tab)"); each chip shows the page title (clipped to 90 characters) + host, and only the host when there is no title; a "+N" chip lists the rest in its title. Details lists all queries.

Data the row needs: `id, type (mcpToolCall | dynamicToolCall | webSearch), server, tool, toolTitle?, connectorName?, status (inProgress | completed | failed | declined | stopped), arguments, result?, error?, readOnlyHint?, durationMs?, startedAt?, approvalId?`.

### 12.3 DocumentCard (files in a reply or on a sent message)

One quiet row per file: `article` (`--surface`, `1px --line` → `--line-strong` on hover, `--r`, `--sh-1`, padding `--sp-2`, gap `--sp-3`, max 32rem; stacked with `--sp-1`).

- Kind tile 2.25rem (`--well`, `--r-sm`, `--ink-2`): document · sheet · slides · code · text — chosen by extension first, then media type.
- Name `600 --t-ui` `--ink`: the base truncates, the extension stays pinned (when ≤ 11 characters).
- Meta `--ink-3`: "‹Type› · ‹size›" (+ " · Revised version" link in `--signal-ink` that scrolls to and flashes the earlier card). Created date in the title and a hidden sentence ("5 Mar 14:03").
- Actions: **Discuss** (ghost sm; raises a `tx:discuss` event — the chat decides what it means) and **Download** (ghost icon; disabled with "Not available to download yet" when there is no safe URL or content).
- Size format: ≥ 1 MB → "2.4 MB" (no ".0"); < 10 KB → "4.2 KB" (min 0.1); else "480 KB" with grouping.
- Types: PDF, Word, Excel, PowerPoint, CSV, TSV, Markdown, Text, ABAP, CDS, JavaScript, TypeScript, JSON, XML, YAML, SQL, HTML, Properties, Java, Python, Shell; unknown → uppercase extension (≤ 5 chars) or "File".
- Only `https`, `http` and `blob` URLs are allowed.
- Revision flash: 1.4 s signal border + 3 px `--signal-soft` ring; under reduced motion a static signal border.
- ≤ 400 px: Discuss becomes icon-only.

### 12.4 Attachments

Paperclip (`aria-label="Attach files"`, title "Attach files · up to 10, 25 MB each") at the start of the composer bar; picker, paste and drag-and-drop all attach.

- Limits: **10 files per message, 25 MB each, no empty files, no executables** (`exe dll msi dmg pkg app bat cmd com scr vbs ps1 apk iso`). Images (`png jpg jpeg gif webp`) show a thumbnail.
- Tray `role="list"` (max 8.75rem, scrolls) of chips (`role="listitem"`, `--r-sm`, up to 14rem; full width ≤ 640 px): 2rem tile · name (extension pinned) · meta · Retry / Remove (1.75rem round) · a 2 px progress line along the bottom.

| Chip state | Meta | Look |
|---|---|---|
| uploading | "Uploading 42%" | tile `--signal-ink`, progress `--signal` |
| ready | "PDF · 2.4 MB" | neutral |
| failed | "Upload failed" | border `color-mix(--bad 45%, --line)`, wash `color-mix(--bad-soft 55%, --surface)`, Retry in `--bad-ink` |

- Rejections appear in one `role="alert"` note: single — "Couldn't attach “‹name›” (over 25 MB)."; several — "3 files weren't attached: “a” (.exe files aren't allowed), “b” (it's empty) and 1 more."; limit — "You can attach up to 10 files, so 2 weren't added." Reasons: "over 25 MB", "it's empty", "already attached", ".‹ext› files aren't allowed".
- Announcements: "‹name› added. Uploading." · "‹name› is ready to send." · "3 files ready to send." · "‹name› didn't upload. Retry or remove it." · "Removed ‹name›."
- Removing a chip moves focus to the next (or previous) chip's Remove, else to the textarea. A page-level drop never navigates away.
- On send, ready files render as DocumentCards above the user bubble, right-aligned.

### 12.5 TurnError

Inline where the answer would be (never a page banner). Card max 36rem, padding `--sp-3`, `--r`.

| Reason | Title | Action | Code |
|---|---|---|---|
| rateLimited | "Too many requests right now" | Try again | `rate_limited` |
| quota | "Usage limit reached" | tip: "Ask your workspace admin to raise the limit, or try again after it resets." | `quota_exceeded` |
| credentials | "The model connection needs attention" | tip: "Ask your workspace admin to reconnect the model provider in Settings." | `invalid_credentials` |
| providerDown | "The model service is unavailable" | Try again | `provider_unavailable` |
| contextWindow | "This conversation is too long" | Compact conversation → then Try again | `context_length_exceeded` |
| other | "Something went wrong" | Try again | `internal_error` |

- Failed (`role="alert"`): border `color-mix(--bad 32%, --line)`, wash `color-mix(--bad-soft 60%, --surface)`, alert icon and title in `--bad-ink`; optional HTTP status chip (mono micro, `title="HTTP status"`).
- Retrying (`role="status"`): neutral `--line` / `--surface-2`, spinner, title "Retrying…", no buttons.
- After a successful compact: an `--ok-ink` note "Earlier messages were summarised. Try again now." and focus moves to Try again.
- Footer: action button (`tx-btn tx-sm`) + reference chip "Ref ‹turnId›" → copies "‹turnId› · ‹code› · ‹status›", label "Copied" for 1.6 s.
- Messages shown to the person are user-safe and scrubbed (masking rules above).

### 12.6 HelperGroup (sub-agents inside a reply)

A compact board on the turn's own clock: one lane per helper.

- Head: icon · "Running 3 helpers" / "Used 1 helper" · elapsed or final span · flag ("2 need you · 1 failed · 1 stopped") · chevron.
- Board grid: who (10.5rem) · track (fluid) · time (3rem), column gap `--sp-3`; an axis row "0s … now" (live, the end shown as a signal pill) or the total.
- Lane (min-height 2.75rem, top hairline): tile 1.75rem with the helper glyph (search, write, review, ops, data, code, mail, bot) in its **identity** colours (`--id-n-soft` / `--id-n-ink`, slots 1–5 in order of first appearance, then neutral) · name (`650 --t-meta`) with a state badge · model (11 px) · track with the task bar · time.

| Lane state | Bar | Label | Extra |
|---|---|---|---|
| running | gradient `--signal-soft` → `color-mix(--signal 24%, --surface)` with a 3 px `--signal` edge at the live end; 2.4 s sheen | `--signal-ink` | live time |
| needs | `--warn-soft` with a 3 px `--warn` edge | `--warn-ink` | ask box under the lane: "!" mark + the ask (fallback "Needs your go-ahead to continue.") + Allow / Don't allow; badge "! Needs you" |
| done | `--id-main-soft` with a 1 px line | `--ink-2` | — |
| failed | `--bad-soft` with a bad edge | `--bad-ink` | error line (fallback "The helper stopped before finishing."); badge "✕ Failed" |
| stopped | transparent with a `--line-strong` edge | `--ink-3` | badge "Stopped" — neutral, never a failure |

- Bar geometry: left = start ÷ span, width = duration ÷ span (min 1.5 %), span ≥ 1 s. Label placement: inside the bar if it fits; else without tool chips inside; else just after the bar; else truncated on the side with more room. A label never sits before its bar; tool chips go before the label does.
- "↳" marks a helper that picked up another helper's output ("Picked up ‹name›'s output").
- Each lane has a full accessible sentence (name, role · model, state, task, "took 12s" / "running for 6.3s", picked-up source, tools, ask, error).
- ≤ 640 px and at 150 / 200 % text: the who column moves above the lane, the tile shrinks to 1.375rem, tool chips hide.
- Note on decisions: the Allow / Don't allow in a helper's ask box is the main-chat decision point for that helper; the Activity Panel shows the same ask read-only.

### 12.7 Plan card

Long tasks call `update_plan`, then ask `plan_approval`; the person never toggles a "plan mode".

- Card max 36rem, `--r`, `--sh-1`, padding `--sp-3`. Head: icon (list in `--signal-ink`; check in `--ok-ink` when done) · title (`650 --t-ui`) · progress "‹done› of ‹total› done" (mono micro). A 4 px meter (`tx-meter-signal` while asking/running, `tx-meter-ok` when done, `role="meter"`). Optional intro (`--t-meta`). Steps `ol`: number (mono micro) · mark (1.25rem circle) · text · label; marks are joined by a hairline.

| Step | Mark | Text | Label |
|---|---|---|---|
| pending | 4 px dot on `--well` | `--ink-2` | "Pending" |
| inProgress | spinner on `--signal-soft`, `aria-current="step"` | `--ink`, bold | "In progress" (`--signal-ink`) |
| completed | check on `--ok-soft` | `--ink-3` | "Done" (`--ok-ink`) |

| Phase | Title | Note |
|---|---|---|
| asking | "Plan" | "Waiting for your review. Answer in the card above the message box." |
| running | "Plan" | — |
| done | "Plan complete" | — |
| revise | "Plan · changes requested" | "Changes sent. The agent is revising the plan." |
| skipped | "Plan · not started" | "Set aside for your new message. Nothing ran." |
| stopped | "Plan · stopped" | "Stopped before it started. Nothing ran." |
| halted | "Plan · stopped" | "Stopped by you. Steps marked done finished; the rest didn't run." |
| gone | "Plan · review closed" | "The review closed before an answer. Nothing ran here." |
| answered | "Plan · answered elsewhere" | "Answered in another window. This turn follows that answer." |

Settled phases dim the steps to 0.6. The list is read-only and rebuilt whole from every `plan.updated` event. Status values accepted: `pending`, `inProgress` / `in_progress` / `in-progress`, `completed`. ≤ 640 px drops the number column.

### 12.8 Receipt line and trace card (observability)

**Receipt** (mono micro, end of each settled turn): clock + duration · Σ + "18.4k tokens" · spark + model name · optional `tx-pill-warn tx-pill-sm` "1 privacy" (only when a step had a privacy finding) · copy · **Details** chip (`aria-expanded`) that opens the trace card.

**Trace card** (`role="region"`, `--r-lg`, opens with a 6 px fade-in over `--tx-d-2`):

- Head: `tx-tile-signal` activity icon · "Turn trace" + "T‹n› · ‹time› · ‹steps› steps · no helpers" · `tx-pill-ok` "Completed" · segmented tabs **Trace / Model context** (the second tagged "Dev") · close.
- **Steps waterfall**: "Steps · ‹dur› wall time"; one plain-language summary sentence ("9 steps over 1m 52s, all in the main agent. It made 3 tool calls, read 2 files and wrote the answer. No helpers were spawned. One step read a file with a privacy finding."); rows = label (11.5rem) · track with a 0.75rem bar positioned in real time · duration (3.5rem); gridlines at 25 / 50 / 75 %; the agent's lifetime bar in `--id-main` at 22 % opacity; step kinds use the neutral ramp (think `--cx-r3`, file `--cx-r2`, tool `--cx-r1`, write `--cx-data`); a legend; and a table twin in a `details` (with a hidden caption) for screen readers.
- **Token receipt**: a printed slip — "Where it went / by step kind", "Billed as / by token role" (input `--cx-r1`, cache `--cx-r2`, output `--cx-r3`, reasoning `--cx-r4`), total, stamp. The slip's slight rotation and paper details are print artwork (19.1).
- **Context jar**: stacked layers (system r1, tools r2, docs r3, conversation r4, free `--well-2`) against a 258k window with a **75 % warn** line (`--warn`) and a **90 % full** line (`--bad`); the fill line is signal; "‹n›% full" in the serif accent; tip: under 75 % "Docs are ‹x›% of the load. Room for about ‹n› more turns' worth of reading before the 75% warn."; at or over "Past the 75% warn. Compact the conversation or start a new one."; Compact button (states "Compacted" / "Wait for the reply" / "Already compacted" / "Nothing to compact", reverting after 1.8 s).
- **Timing** `dl`: Accept, First token, Stream, Longest gap, Rate (tok/s), Finalize.
- **Privacy**: a finding card, or "Nothing personal was read on this turn." in `--ok-ink`.
- **Model context (Dev)**: composition bar + "Four sections fill ‹k› of the 258k window; workspace docs are ‹x›% of what's used." and one `details` per section (System, Tools, Workspace docs — open by default, Conversation) with a share meter, file list and a masked preview; footer "Masked on the server. Captured for live turns only." + Copy masked.
- Keyboard: ←/→ switch tabs (roving), Esc closes and returns focus to Details. Charts are `role="img"` with labels that list each segment.
- Number format: ≥ 1000 → "18.4k" (no ".0").

---

## 13. Blocking requests (approvals and questions)

When the agent needs the person, the turn pauses and **exactly one** request card (`.rq`) is pinned in `.cs-pinned` directly above the composer. There **must** be only one card at a time — no stacked cards; when several requests are queued, the queue position shows **inside** the one card as the "n of m" step badge (`.aq-step`, oldest first), not as a stack. A placeholder stays in the stream; after the answer the card is removed and an ApprovalRecord is written into the reply (13.6). The `.rq` design is the contract — radius `--r-lg`, a text countdown (not a ring clock), and the record written into the stream. Reference: `system/screens/approval.*`, `elicit.*`.

### 13.1 Shared card shell

- `section.rq` with `aria-labelledby` its title; max-height `min(48vh, 26rem)` (55 vh at ≤ 640 px) and scrolls inside, so it can never push the composer off screen; padding `--sp-3`; `--r-lg`; `--surface`; `--sh-2`; border `1px color-mix(--signal 32%, --line)`; enters with a 0.28 s fade + 8 px rise. Border by state: error `color-mix(--bad 32%, --line)`; expired `color-mix(--warn 40%, --line)`; tool approval `color-mix(--warn 40%, --line)`. (The shell classes are `.rq` / `.rq-*` — e.g. `.rq-ic`, `.rq-time`, `.rq-soft`, `.rq-err`; the part prefixes `.aq-` (question), `.at-` (tool), `.ar` (record), `.el-` (elicitation) and `.pl-` (plan) stay.)
- Head: 1.5rem icon tile `.rq-ic` (`--r-sm`; signal tint by default, warn tint for tools) · title (`650 --t-ui` `--ink`) · optional queue badge "2 of 3" · countdown pill at the end.
- **Countdown** `.rq-time` (`role="timer"`, mono micro, `--well` / `--ink-2`; `--warn-soft` / `--warn-ink` in the last minute): "4:59" under an hour, "1h 05m" above; accessible label "Expires in 4 minutes" / "Expired"; ticks every 500 ms; omitted when there is no expiry.
- **Buttons**: the decision row **must** use default-height buttons (`tx-btn`, 36 px — **not** `tx-sm`); `tx-sm` (28 px) is only for secondary in-card controls such as show-details or copy. Exactly one button is `tx-primary`; broader or alternative answers use the soft secondary (`--signal-soft` / `--signal-ink`, no border, no shadow; hover `color-mix(--signal 18%, --surface)`); exits use `tx-ghost`. Disabled 0.6. While sending, the acting button shows spinner + "Sending…" and all buttons disable.
- **Error envelope** (`role="alert"`, focus moves to its first button): message in `--bad-ink` with alert icon; generic "Couldn't send your answer. Check your connection and try again." → Try again (primary) + Back (ghost). Terminal cases → Dismiss only: 409 — on a plan card "This plan was already answered.", on question / tool / elicitation cards "This was already answered." · 404 "This review is gone. It may have expired." (all card kinds) · 410 "This review expired before your answer arrived." Reference chip "Ref ‹requestId› · ‹status›" at the end.
- **Lifecycle**: `pending → submitting → (answered | expired | error)`; `stop()` closes as stopped (Stop or a new message); `destroy()` removes silently (new conversation). On close the host empties and hides.
- **Nudge**: a blocked send pulses the card (0.9 s signal ring) and focuses its first control.
- Keyboard hints (`⌘↵ send · Esc cancel`) hide on touch (`hover: none`).

### 13.2 Plan approval

Shown when the request has one question with id `plan_approval`.

- Icon check (signal). Title "‹header or "Plan"› ready for review". Question text. Steps rendered with the plan list (12.7), or "The drafted steps are in the message above."
- Pending: **Approve plan** (primary, check) · **Revise** (soft, pen).
- Revising: label "What should change?" · textarea (3 rows, 4.5–10rem, focus halo) · **Send feedback** (primary; disabled until text) · **Cancel** (ghost) · hint "⌘↵ send · Esc cancel". ⌘/Ctrl+Enter sends, Esc cancels (and does not bubble).
- Expired: "No reply in time. Continuing with the recommended option." → the server approves; the card closes after 2.2 s.
- Payloads: `{answers:{plan_approval:{answers:["Approve"]}}}` · `{answers:{plan_approval:{answers:["Revise","user_note: ‹text›"]}}}`.
- Focus: Revise → textarea (caret at end); Cancel → back to Revise; error Back → Approve.

### 13.3 Question (clarification, free text, secret, queue)

- Icon help. Title = the question's header, or "Your input is needed".
- Queue of several questions in one card: badge "‹n› of ‹m›" and a hidden "Question ‹n› of ‹m›: " prefix. Buttons **Back** (ghost, from the 2nd) · **Next** / **Send answer** on the last (primary).
- "Will run" block (mono uppercase label + `code`, `--well`, `--r-sm`) when the question states the action.
- Options `.aq-opt`: full-width rows (`1px --line`, `--r-sm`, `--surface`; hover `--line-strong` / `--surface-2`; selected `--signal` border + `color-mix(--signal-soft 60%, --surface)`; 1rem circular tick filled `--signal-fill`). Label `600 --t-meta`, description 12 px `--ink-3`. Group `role="group"` labelled by the question.
- One-click: a single question with options and no free text sends on click; rows show a trailing chevron that moves 2 px on hover.
- "Something else…" reveals a text field (placeholder "Type your own answer"). Field: `1px --line-strong`, `--r-sm`; focus signal border + halo; invalid `--bad`; read-only while sending.
- Secret: password field in mono with 0.08em tracking, and the note "Sent to the agent only. It won't appear in the conversation." Secrets are never shown, logged or summarised; in any retained or logged copy of the payload the secret value is replaced with "••••••" (`approval.js` `redact`).
- Missing answer (`role="alert"`, `--bad-ink`, the option group border reddens): "Choose an option or type your own answer." · "Choose an option to continue." · "Type your answer to continue." Clears the moment the question is answered.
- Enter in a text field advances.
- Expired: a question that states a tool action → "No reply in time. The tool won’t run." (the tool is not run); other non-secret → "Continuing with the recommended option." (closes after 2.2 s); secret → "This question has expired. Send a message to continue." + Dismiss (it waits; a secret never takes a default).
- Payload: `{answers:{‹questionId›:{answers:["‹label or text›"]}}}`.

### 13.4 Tool approval

- Border and icon tile in warn; icon shield; title **"Permission needed"**.
- Tool row: 2rem connector logo (brand mark when known — Google, Slack, Figma, Notion, GitHub, HubSpot, Stripe — else the first letter) · tool title · connector name · badge **Read-only** (ok-soft / ok-ink) or **Write** (warn-soft / warn-ink), omitted when unknown.
- "Action" block with the sentence of what will run; the question if it differs; **Arguments** disclosure (chevron rotates 90°; masked JSON, mono, max 10rem).
- Decisions (`role="group"`, `aria-label="Your decision"`), mapped from whatever wording the runtime sends:

| Runtime label matches | Button | Style | Decision |
|---|---|---|---|
| "Allow" / "Allow once" | **Allow once** | primary | allowedOnce |
| "Allow for/in this session/chat" | **Allow for this chat** | soft | allowedChat (allowedSession) |
| "Allow and don't ask…" / "Always allow" | **Always allow** | soft | allowedAlways |
| "Cancel" / "Decline" / "Deny" / "Don't allow" | **Don't allow** | ghost | declined |
| anything else | its own text | soft | toolAnswered |

  The payload sends the runtime's own label, not the display label. ≤ 640 px: buttons in a 2 × 2 grid, full width.
- Expired: "This question has expired. Send a message to continue." + Dismiss. A tool is **never** auto-allowed on expiry; the server treats it as declined.

### 13.5 MCP elicitation

An MCP server asks for input (`mcpServer/elicitation/request`). Same shell; icon tile in signal. Subhead on every mode: "Requested by **‹serverName›** · MCP server" (default name "An MCP server").

| Mode | Title | Body | Actions |
|---|---|---|---|
| form | "‹server› needs a few details" | fields from the schema; note "Only share what you're comfortable sending to ‹server›." | **Submit** (primary) · Decline (soft) · Cancel (ghost) |
| url | "‹server› wants you to open a link" | hostname + full URL; warnings below | **Open link** (primary) → after opening, **Done** becomes primary and Open becomes "Open again" (soft) · Cancel |
| verify | the given title or "Confirm it's you" | large mono code (`650 1.5rem`, 0.14em, dashed border) + Copy ("Copied" 1.6 s) | **Confirm** (primary) · Decline · Cancel |
| unknown | "‹server› sent a request" | "This request type (‹mode›) can't be shown here. Decline it, or cancel and ask the agent another way." | Decline · Cancel |

Form fields (from `requestedSchema`): string → text / email / url / date / datetime-local; number / integer → numeric input with min / max; boolean → checkbox card (signal border when checked); enum → single-choice option rows; array of enum → multi-choice (square ticks), with "Choose one" / "Choose any". Optional fields are marked "Optional" (required is the unmarked default). Enum groups lay out in `repeat(auto-fill, minmax(9.5rem, 1fr))`, one column ≤ 640 px. Long forms get a sticky footer, with scroll padding so focus never lands behind it.

Validation (on submit; live once a field is in error; focus goes to the first bad field; a `role="alert"` summary "Fix 2 fields to submit."): "Required." · "Choose one." · "Choose at least one." · "Choose at least ‹n›." · "Choose up to ‹n›." · "Enter a number." · "Enter a whole number." · "Enter ‹n› or more." · "Enter ‹n› or less." · "Use at least ‹n› characters." · "Use ‹n› characters or fewer." · "Enter an email address, like name@company.com." · "Enter a full link, starting with https://." · "Enter a date." · "Enter a date and time." · "Check this value."

URL warnings (`--warn-ink`): no usable link → "This link can't be opened here. Cancel, or ask the agent for another way."; `http:` → "This link isn't encrypted (http). Only continue if you trust ‹host›."; `https:` → note "Opens in a new tab. Come back and choose Done when you've finished." Only `http(s)` links open, with `noopener,noreferrer`.

Responses: `accept` (with content for forms), `decline`, `cancel`. Expired: "No reply in time. ‹server› will treat it as cancelled."

### 13.6 ApprovalRecord (the audit row in the stream)

Written into the reply's asks slot when a request is answered, auto-handled, expired or interrupted.

- Card: max 36rem, `--surface-2`, `1px --line`, `--r-sm`, 12 px text; `role="group"`, `aria-label="Your decision"`, `id="approval-‹requestId›"` (tool rows link here with "View approval").
- Label "YOUR DECISION" (mono micro). Rows:
  - tool row: 8 px dot (ok if allowed, bad if declined, `--line-strong` otherwise) · tool title · badge;
  - question row: question (muted, ≤ 140 chars) · answer (600, ≤ 180 chars).
- Foot: "‹summary› at ‹h:mm›" with a `<time datetime>`; summary "You answered" / "Closed" / the auto mode.

| Decision | Badge | Tone |
|---|---|---|
| allowedOnce | Allowed once | allowed (ok) |
| allowedChat / allowedSession | Allowed for this chat | allowed |
| allowedAlways | Always allowed | allowed |
| declined | Not allowed | declined (bad) |
| expired | No answer — timed out | muted |
| interrupted | No answer — stopped | muted |

- Auto-handled by policy (no card is shown, only the record): "Auto-allowed (read-only)" · "Auto-accepted (Autopilot)" · "Allowed for this chat".
- Answer wording: no answer → "No answer" or, on timeout, "Chosen automatically, no reply in time"; secret → always "Answer hidden" (dimmed); Autopilot pick → "‹answer› (chosen by Autopilot)".
- Elicitation records: question "‹server› asked for a few details" / "…asked you to open a link" / "…asked you to confirm it's you"; answer "Sent: field, field" (field **names** only, never values) / "Done" / "Confirmed" / "Declined" / "Cancelled".

### 13.7 Policy summary

- Only `item/tool/requestUserInput` reaches the browser; everything else is answered on the server.
- Approval modes (read-only auto-allow, Autopilot, chat grants) can answer tool requests without a card; they still leave a record.
- Secrets and plans **always ask**, whatever the mode.
- Expiry: plan → approve (recommended); question → recommended option; secret → waits; tool → declined; elicitation → cancelled.

---

## 14. Activity Panel

The right dock (⌘.), width `--inspector` (360). It reports what happened in a turn (and, next, the session) and never decides anything. Reference: `system/screens/business-activity.{html,css,js}`. Only the `.ap` panel in that file is the component; the page's demo bar (State / Note / Crew / theme) and the notes column are study scaffolding.

The Activity Panel **must** keep the `.ap` / `.ap-*` class family (`business-activity.css`). The approval request-card shell renames its own `.ap` / `.ap-*` classes to `.rq` / `.rq-*` (e.g. `.ap-time` → `.rq-time`, `.ap-soft` → `.rq-soft`, `.ap-err` → `.rq-err`, `.ap-ic` → `.rq-ic`), so the two families never collide; request-card classes are named `.rq-*` throughout the spec. The part prefixes `.aq-` (question), `.at-` (tool), `.ar` (record), `.el-` (elicitation) and `.pl-` (plan) stay as they are.

The locked four-tab panel from `business-activity.*` is the **only** Activity Panel. The `chat.html` inline rail (`.cs-activity`, `aria-label="Session activity"`, the "Wide" button, and tabs Activity / Agents / Files / Plan) is a stale scaffold and **must** be removed, not restyled (migration, 19).

### 14.1 Locked structure

Exactly four tabs, in this order (locked 27 Oct 2026; do not add, rename or reorder without reopening the decision):

1. **Activity** — Business activity & traces
2. **Agent** — the agent's info; label becomes **"Sub-agents ‹n›"** when helpers were spawned
3. **Files** — label carries the made-file count
4. **Insights** — time, cost, context, comparison, checks

Scope: the panel serves one turn and the whole session. The turn view is designed first; the session view is next (a session is expected to be a stack of turn blocks, with scope following the selection and a Session home).

### 14.2 Read-only contract

Allowed controls only reveal or move information: tabs, disclosures, Plain/Technical, jump to a step, pick an agent, show more, copy trace ID, export log, open/download a file **to view**, "View ‹agent›'s setup", and **"Show in chat"**.

Forbidden in the panel: approve, decline, retry, stop, steer, edit, rerun, start a chat, or any control that changes state. A pending item appears as a status notice (what is pending, why, how long it has waited) with at most a "Show in chat" jump. Copy always points to the chat: "Answer, add a note, or stop the turn from the chat."

### 14.3 Frame

- `<aside aria-label="Activity panel">`: flex column, width `--inspector`, height `min(100vh − 7.5rem, 56rem)` (min 34rem) in the study (in the app it fills the dock height), `1px --line`, `--r-lg`, `--surface`, `--sh-3`, `overflow: hidden`. At viewport width ≤ 1220 px the panel **must** narrow to `--inspector-sm` (`20rem`; new in 2.0); this token applies to the business-activity panel, not the retired `chat.html` rail.
- **Head**: scope crumb (`nav aria-label="Scope"`): "Session › Turn **4** of **4**" (current has `aria-current="page"`, figures in `.num`); then Previous turn · Next turn (disabled on the latest) · Close — all `tx-btn tx-ghost tx-icon tx-xs`.
- **Tabs** `tx-tabs`, `role="tablist"`, `aria-label="Activity panel sections"`; each tab `aria-controls` the body.
- **Body**: single `role="tabpanel"` (`tabindex="0"`, inset focus halo), scrolls (`scrollbar-width: thin`), re-rendered per tab; scroll resets on tab change.
- **Foot** (`--surface-2`, top hairline): "TRACE" + reference chip with the trace ID (copies; `aria-label="Copy trace ID"`) · ghost "Export log" (download icon).
- Sections `.sec` (padding `--sp-4`, divided by `--line`); section head = micro label (`--ink-3`) + meta (`--t-meta --ink-3`) on the right.

### 14.4 Turn states

| State | Status pill | Notice | Changed | Steps |
|---|---|---|---|---|
| live | `tx-pill-live` + spinner "Working" | — | "Nothing changed so far" (shield) | one `run` step |
| needs | `tx-pill-warn` hand "Needs your approval" | warn notice | "Nothing yet. 1 change waits for you in chat" (warn) | one `wait` step |
| done | `tx-pill-ok` check "Done" | — | the change + diff | all done |
| issue | `tx-pill-warn` alert "Done, 1 step failed" | bad notice | "Nothing. The one change failed" (bad) | one `fail` step |
| declined | `tx-pill-ok` check "Done" | — | "Nothing. You declined the change" | `decl`, then `skip` |
| stopped | `tx-pill-line` stop "Stopped by you" | neutral line notice | "Nothing. You stopped it before the ‹step›" | `stop`, then `skip`s |

Declined and stopped are the person's choices, not faults: no red anywhere for them.

Step statuses:

| Status | Title tense | Node (1.5rem circle) | Waterfall segment | Expandable |
|---|---|---|---|---|
| done | past ("Pulled Q3 revenue…") | kind icon, neutral | `--cx-r3` | yes |
| run | present ("Pulling…"), shimmer | `--signal-soft` + signal ring + spinning top arc | `--signal` | yes |
| wait | present | warn family | `--warn` + 45° hatch | yes |
| fail | past | x icon, bad family | `--bad` | yes |
| decl | "You declined the ‹thing›" | ban icon | track (`--cx-track`) | yes |
| stop | "Stopped while ‹present tense›" | stop icon, `--well-2`, ink ring | `--cx-r3` with a 2 px `--ink` cut edge | yes |
| skip | planned ("Will create…"), muted | ban icon, dashed | none (untimed) | no |
| next | planned, muted | dashed | none (untimed) | no |

### 14.5 Tab 1 · Activity (top to bottom)

1. **The ask**: "YOU ASKED · 2:41 PM" with the lead agent's name on the right (micro); the question in curly quotes, clamped to 3 lines; status pill + facts: where ("Step 5 of 8" / "At step 5 of 8" / "1 declined" / "8 steps"), "1 note from you" when steered, and the total time (live: "+ so far"). The right-hand micro label is the lead agent's name (`crew().lead.name`); the study's canonical example ask is the EMEA-Q3-revenue prompt ("Why did EMEA revenue drop in Q3? …", `ASK.q`) at `2:41 PM` (`ASK.at`).
2. **Needs you / notice** (only needs, issue, stopped; `role="status"`):
   - needs (warn-soft card, hand icon): "Waiting for your approval in the chat" · "It asked before creating a Jira ticket. Nothing is created until you answer there." · a `dl` of what is pending (Project, Title, Assignee) · steer note line if any ("You added a note to this turn. It's read when you answer.") · **Show in chat** + "Waiting ‹live time›" in `--warn-ink` · hint "Answer, add a note, or stop the turn from the chat."
   - issue (bad card): "The Finance ticket wasn't created" · cause · **Open trace** (jumps to the failed step) + Show in chat.
   - stopped (neutral `--well` card): "You stopped this turn at step ‹n›" · what finished, what was cut, what didn't run · Show in chat.
3. **Footprint** — "Read-only unless listed under Changed": a **Read** row (eye icon; each system read: mono letter mark · name · what; a live dot "Reading now") kept separate from a **Changed** row (pen icon; per state as in 14.4; when done, the change and a diff "FIN tickets 41 → 42" with the new value in `--ok-ink`). Empty read row: "Nothing yet".
4. **Steps** — head "Steps ‹done›/8" + `tx-seg tx-seg-sm` **Plain / Technical** (`aria-label="Detail level"`, `aria-pressed`).
   - Waterfall: a 0.5rem bar of segments with 2 px gaps on **one time scale** (each segment flexes by its duration, min 3 px; only timed steps draw); axis "0s … ‹total›". Hovering a row highlights its segment and dims the others to 0.35, and vice versa. The bar is `aria-hidden` (the list is the accessible equivalent).
   - Rail timeline: nodes joined by one `--line-strong` hairline; row grid node · main · right. Sub-line parts joined by "·": system · the helper who did it (identity dot + name) · status note ("Jira refused · no permission in FIN", "Waiting for you in chat", "You declined", "You pressed Stop · ‹what›", "Didn't run · you stopped the turn" / "Skipped, not approved", else the one-line status). Right: duration (mono, signal-ink when running, warn-ink when waiting) + chevron.
   - Each timed step expands into a trace `dl` (dt 4.75rem): **Did** (plain language) · **System** ("Qlik · Read-only", "Jira · Write", "Asks first", "No system") · **Touched** (list) · **Started** (+offset) · **Took** · **Result** (ok / warn / bad ink: "Refused · 403, no create permission in FIN", "Declined by you", "Stopped by you · …", "In progress", "Waiting for you") · **Your note** ("Followed · …") when a steer applied.
   - **Technical** adds a second `dl` on `--surface-2` with mono uppercase keys: **Tool** (`jira.create_issue`), **Input** (raw payload, `pre-wrap`), **Span** (`sp_…`). Secrets stay masked even here: masked values render as a `masked` token (`--well-2`, `--ink-3`, `--r-mark`).
   - A steer appears as its own row after the step it followed: a small rounded-square node (not a circle) in `--well`, chat icon, "You added a note", the quoted note (left rule, `--well`), and "Steer · from the chat · ‹effect› · 2:43 PM". It reads as the person's, not the agent's.
5. **Sources** — "Answer built from" (stopped: "Read before you stopped it"), meta "6 sources" / "so far": rows of mono mark · name · kind · "Step ‹n›" (clicking jumps to the step); first 4 then "Show ‹n› more" / "Show fewer"; empty "No sources yet."; stopped adds "No answer was written. The web pages it had opened weren't kept."

Jumps (`focusStep`): open the step, scroll it into view (instant under reduced motion), flash it with signal for 1.2 s (none under reduced motion) and move focus to its button.

### 14.6 Tab 2 · Agent / Sub-agents

Identity hue is the only colour an agent carries (avatar, dot, hairline, share bar, lane).

Avatar sizes are tokens (new in 2.0): `--av-xs` (`1.25rem` / 20), `--av-sm` (`1.5rem` / 24; the old `1.375rem` folds into it), `--av-md` (`2rem` / 32) and `--av-lg` (`3rem` / 48, agents screens); the status dot is `--dot` (`0.4375rem` / 7). The sizes named below map to these tokens — the 3rem identity avatar is `--av-lg`, the 1.5rem crew/dossier avatars are `--av-sm`.

**One agent ("Agent")**:
1. Identity: 3rem avatar (initials on `--id-*-soft`) · name + pill "Built-in" / "Yours" · description · mono "@handle · model".
2. "Allowed, and used this turn" (meta "Used 3 of 6"): groups **Servers / Skills / Knowledge**, each row = mark (server letter / spark / book) · name · permission ("Can create issues" in `--warn-ink`, read in neutral) · what it is · right side: step chips ("Step 2") when used, else "Planned" or "Not used" (row dimmed); "None connected" when empty.
3. "Rules it worked under": instructions clamped to 3 lines with "Show all" / "Show less" (`aria-expanded`) and a limits `dl`.
4. Setup snapshot: "Ran on version ‹v›, saved ‹date› by ‹name›" + "✓ Unchanged since" (ok-ink).

**With helpers ("Sub-agents ‹n›")**:
1. **Crew** (meta "2 of 2 hand-offs made"): one card per agent in a grid (lead first, `aria-pressed`): 2 px identity hairline across the top (55 % → 100 % when picked) · 1.5rem avatar · "LEAD" / "HELPER" · pen mark when it can change a system · name · status dot + word (Working (signal, glowing) / Needs you / Failed / Stopped / Didn't start / Waiting / Queued / Done) · share bar of its time (identity fill) · "12s · 3 steps". Picked card: `--surface`, `--line-strong` ring, `--sh-2`. Hover or focus dims the other agents everywhere.

   Each status word **must** map to a fixed tone (`agentStatus`), evaluated in this order; a declined helper reads **"Stopped"** with the neutral `line` tone, never red:

   | Condition | Tone | Word |
   |---|---|---|
   | any step `run` | `live` | Working |
   | any step `wait` | `warn` | Needs you |
   | any step `fail` | `bad` | Failed |
   | any step `decl` | `line` | Stopped |
   | turn stopped, all its steps `skip` | `line` | Didn't start |
   | turn stopped, otherwise | `line` | Stopped |
   | lead while another is live | `line` | Waiting |
   | all its steps `next` | `line` | Queued |
   | else | `ok` | Done |
2. **How the work moved** — a branch graph drawn after layout from the row positions (SVG, `aria-hidden`; the rows carry the meaning): the lead is the spine (x = 9), each helper a lane 16 px to the right; a helper branches off at its hand-off and merges back at its return with curves of radius ≤ 12. Spine solid when the lead holds the work, **dotted** while a helper holds it, **dashed** ahead (pending). Nodes on top: step circle r 4.5 (running + pulsing halo r 8), steer = 7 × 7 rounded square, hand-off / return = r 3 on the spine. Rows: "Handed to ‹helper›" + task · steps · "‹helper› handed back" + what it returned (or "never started" / "stopped") · "You added a note".
3. **Dossier** of the picked agent: identity + status pill; a perforated ticket (two panes, dashed tear with notches) — lead: "Its part" + "Instructions"; helper: "Brief from ‹lead›" (quoted ask, offset) + "Returned" / "Return so far" / "No return" (toned); then a `dl`: Steps (chips), Read, Changed (toned), Allowed (chips, used ones filled, writers tagged "writes", "Used 2 of 4"); footer ghost "View ‹name›'s setup" (opens the Agents screen).
4. Setup snapshot of the lead.

### 14.7 Tab 3 · Files

Made, read and edited are counted apart, so "edited nothing" is a stated fact.

1. Tiles (3 columns, `--surface-2`, `--t-h4` tabular values): **Made** (+ "2 planned") · **Read** · **Edited** (0).
2. "Made by this turn" (meta "New files only" / "So far"): rows = mono type badge ("CSV", "PNG") · name · meta · size · chevron. Expanded: a preview (table in mono with masked sensitive columns and "18,237 more rows"; or a bar chart in chart ink, diverging around a centre axis when values go negative, highlight in `--cx-data-hi`) · `dl` Made by (avatar + name) · Built from · Step (chip) · Created · Kept "In this chat · not shared outside it" · **Open** and **Download** (ghost, view only). Files from steps that have not run show dimmed with a dashed badge: "Planned · made in step 7" or "Not made · step 7 didn't run".
3. "Read, not changed": knowledge documents opened (DOC badge, step chips) + "Also available, not opened: ‹names›".
4. "Edited": "No existing file was edited." + a state note ("Everything above is new. It lives in this chat." / "The failed step was a Jira write, not a file." / "You stopped it before it wrote anything else.").

### 14.8 Tab 4 · Insights

Time, cost and context are chart ink. Waiting for the person is amber and kept apart so the agent is not read as slow. Comparisons are a band (the middle half of recent turns), a tick (usual) and a dot (this turn).

1. Tiles: **Time** ("so far" when live) · **Cost** ("est.") · **Context** ("used").
2. "Where the time went": a stacked bar (`role="img"`) — thinking `--cx-data-mute`, your systems `--cx-data`, web `--cx-data-hi`, **waiting for you `--warn`** — and a list with swatch, seconds and percent; note when there was waiting: "…the turn waiting for your answer in chat, not the agent working."
3. "What it cost" (+ Plain / Technical): meter against the per-turn cap ("‹$› estimated" / "$5.00 cap per turn"); per-agent split when helpers ran (sorted, share bars in `--cx-data-mute`). Technical adds Input, From cache, Output, Reasoning, Model ("… · helpers on ‹model›"), Rates ("$5 in · $0.5 cached · $25 out, per 1M"). The reference rates (`$5` in / `$0.5` cached / `$25` out per 1M, `RATE`) and the `$5.00` per-turn cap (`BUDGET`) are the study's illustrative constants, labelled "est." / "cap" — not pricing.
4. "How much it kept in mind": "‹n›K of 200K", meter with an 80 % threshold tick (`--cx-axis`); note under 80 %: "Plenty of room. Past 80% it starts summarising older parts of the chat."; above: "Close to full…". The `200K` context window (`WINDOW`) is likewise an illustrative study constant.
5. "Against its usual turn" (last 30 turns): two strips — **Working time** (waiting excluded) and **Cost** — each with band (`--cx-track` + edge), median tick (`--cx-axis`), this-turn dot (`--cx-data-hi`), "About / Longer / Shorter than usual" (cost: More / Less), "This turn ‹v›" / "Usual ‹v›"; legend "Middle half of its turns · Usual · time waiting for you left out".
6. "How it checked the answer": checklist items with a round icon — ok (check, ok-soft), warn (alert, warn-soft), wait (clock, `--well`), off (ban, `--well`): "Totals match across systems", "Sources are recent", "Every number has a source", the steer ("Follows / Followed your note", "Your note wasn't applied", "…wasn't needed"), rules ("Stayed within its rules" / "One write failed"), "Within budget". When the turn was stopped, unrun checks are **off** ("Not checked. You stopped the turn first."), not warnings.

### 14.9 Live updates

- One 100 ms clock updates live figures in place (current step time, waiting time, totals, axis, the live segment's length) so open traces, focus and hover survive; Insights re-renders once a second while live.
- The panel follows the selected turn's real status; it never advances state by itself in product (the study's auto-advance from live to needs is demo behaviour).

### 14.10 Stop and Steer in the panel

The panel only records them: the `stopped` state (14.4), the cut step and skipped steps, the neutral notice, a steer row in Steps, a square node in the relay, and a check in Insights. There are no Stop or Steer buttons in the panel.

### 14.11 Panel accessibility

`aside` label; scope `nav` with `aria-current`; tablist with `aria-selected` and the panel `aria-labelledby` the active tab; the tablist **must** implement roving focus — ←/→ move between tabs, Home/End jump to the first/last, exactly one tab is in the tab order (`tabindex="0"` on the selected tab, `-1` on the others), and activation follows focus (automatic activation: moving focus selects and shows that tab). The study wires only `click` and sets no roving `tabindex`, so this is a migration item (19); expandables expose `aria-expanded` / `aria-controls`; notices `role="status"`; data visuals `role="img"` with value-listing labels, or `aria-hidden` when a list carries the same facts; icons `aria-hidden`; toasts through the polite host.

---

## 15. Agents: team board and Agent ID desk

Reference: `system/screens/agents.*` (team list) and `system/screens/agent-id.*` (creation flow). Both are built on the foundations, with one sanctioned exception: **printed artwork** (robots, pastel tints, push-pins, the ID card, sticker sheet, signature pad, lanyard) is a fixed physical material in every theme. Its colours are named once in a scoped block (`--pb-*` on the board, `--pr-*` and `--c-*` on the desk) and nowhere else.

### 15.1 Agent data model

| Field | Type | Notes |
|---|---|---|
| `id`, `name`, `handle` | string | handle = name lower-cased, non-alphanumerics removed, max 24; shown as `@handle` |
| `purpose` / `desc` | string | ≤ 280 chars; one sentence of what it owns |
| `model` | model id | one backend model + server catalogue; the display name **must** drop the "Claude " prefix and use the catalogue's casing and version — e.g. raw `Claude Sonnet 5.5` renders as **"Sonnet 5.5"** (`agent-id.html:654,1015`). The board uses the lower-case short label (`sonnet 5.5`, `agents.js:50`) |
| `instructions` | rules + behaviour + topics | rules and behaviour are newline lists (≤ 12 items × 160 chars, or text ≤ 1200); topics `focused` (only its purpose) or `open` (general questions too) |
| `mcps` / `servers` | map id → `read` \| `write` | new servers start at `read` (least privilege) |
| `skills` | ordered ids | |
| `knowledge` | sources | "Soon" in the creation flow |
| `builtin` | boolean | Built-in vs Yours |
| `scope` | `personal` \| `tenant` | tenant can't be made personal again |
| `look`, `tint` | artwork | robot look index; tint id (ice, mint, butter, peach, lilac) |
| `sig` | SVG path | optional signature |

### 15.2 Team board (Agents screen)

- Page: max `--wrap`, dotted `--page` bench. Top: "TRUEX / AGENTS" (mono) · theme toggle · **New agent** (the one primary). Hero `t-display` "What the *team* can help with" + lede "‹n› specialists · ‹m› built by you. Pin one to the chat, or build your own."
- Tools: search field (placeholder "Search by name, handle or purpose", matches name + handle + purpose) and a segmented filter **All / Yours / Built-in** (`role="radiogroup"`). No sorting; the list keeps its order. Count tag "06/06" (`aria-label="6 of 6 agents shown"`).
- Board: `--surface`, `1px --line`, `--r-lg`, `--sh-1`, neutral grid-paper wash (ink at 11 % / 5 %); cards in `repeat(auto-fill, minmax(220px, 1fr))`, gap `--sp-8 --sp-6`.
- Card (a pinned polaroid, tilted by a fixed sequence −4, 3, −2.5, 4.5, −3.5, 2, −1.5, 3.5°; its text counter-tilted upright): frame in the tint colour (`--r`, `--sh-2` → `--sh-3` on hover), photo button (5:4, `--r-sm`, tint wash, the robot lifts 4 px on hover, `aria-label="Edit ‹name›"`), caption = the name in the serif italic (printed artwork), `@handle` (mono), purpose, server chips (mono micro pills with a server accent dot; "No servers connected"), meta "sonnet 5.5 · 2 skills · 3 sources", and a **Chat** button.
- Live agent (the one in the current chat): `tx-pill-live tx-pill-sm` "in chat" with a pulsing dot; its button becomes disabled "Chatting"; its push-pin is signal. Every other pin is neutral metal: signal is spent only on live work.
- Built-in agents carry a "BUILT-IN" lock badge (and a hidden " · built-in").
- New-agent slot (when not filtering to Built-in and not searching): dashed `--line-strong` frame (hover `--signal`), a 44 px `--signal-fill` plus, caption "New agent", note "build your own".
- Empty search: **"No agents match "‹query›""** (`agents.js:155`) + **Clear search**. Note: the source emits **straight** double quotes; §17.1 requires curly quotes `“ ”` — the source **must** be fixed to `“‹query›”`, not the spec (migration, 19).
- Motion: cards drop in (0.5 s, 60 ms stagger), pins re-measure after layout; reduced motion removes card, pulse and robot animation.
- ≤ 560 px: 2 columns, smaller caption, stacked foot, meta and doodles hidden.

### 15.3 Agent ID desk (creation flow)

A modal (`role="dialog"`, `aria-modal`, labelled; Esc and a backdrop press close it): form on the left, the agent's lanyard ID card on the right. Max 980 px, `--r-lg`, `--sh-3`, height `min(720px, 100dvh − 88px)`; scrim `color-mix(--ink 18%)` + 2 px blur.

Steps (`role="tablist"`; a step shows a check when done; the active step has a 2 px signal underline):

| Step | Subhead | Fields |
|---|---|---|
| 1 Identity | "Who it is and what it's for. This prints on the front of its ID." | **Name** (≤ 60, placeholder "Research Scout", hint shows `@handle`, autofocus) · **Purpose** (≤ 280, "What this specialist owns", live count) · **Photo** (backdrop tint swatches, look grid, "shuffle") · **Model** (radio cards in 3 columns, one roving radio group via ←/→/↑/↓ with Home/End and `tabindex` 0 on the selected card, −1 on the rest; three featured models shown by default — Haiku 5.5 / Sonnet 5.5 / Opus 5.5 — with **"All models (‹n›)" / "Fewer"** to expand the full backend catalogue; a "Search models" box appears once more than **7** models are listed. The display name drops the "Claude " prefix.) |
| 2 Access | "What it can open and what it's good at. This prints on the back." | **MCP servers** as a sticker sheet (tap to attach; each attached sticker gets a READ / R/W segmented control; note "New stickers start on READ. R/W lets it create and change things.") · **Skills** (chips, `aria-pressed`) · **Knowledge** — "Soon" |
| 3 Rules | "What it answers, the rules it follows, and how it comes across." | **What it answers** (Only its purpose / General questions too — the "Only its purpose" hint reads `Sticks to “‹purpose, clipped to 70 chars›” and politely declines anything else.`, or the generic "Sticks to the purpose you gave it…" when no purpose is set) · **Rules** and **Behaviour** editors (Bullets / Text; Enter adds a line, Backspace on an empty line removes it; idea chips) |
| 4 Sign & issue | "Who can use it, and your signature." | **Who can use it** (Just me / Everyone in this workspace — "Every member can use it; their chats stay private. It can't be made personal again.") · **Signature** (optional pad `role="img"` with accessible name "Signature pad, empty" / "Signature drawn"; "Sign for me" injects a fixed pre-drawn path (`AUTO_SIG`) for keyboard users; Clear) |

- Requirements: name and purpose only. Problems read "Give it a name" / "Say what it's for"; on later steps the footer says "‹problem› on the Identity step first" and Issue is disabled.
- Footer (sticky): Cancel (step 1) or Back · **Continue** (primary) → on the last step **Issue ID** / "Issuing…".
- Issue: the card flips to its front, an "ISSUED · ‹date›" foil seal lands, and the dialog closes with a toast "Issued ‹name›".
- The card: front = identity (brand, photo window in the agent's tint, ID number "AG-‹4 digits›", name (2-line clamp), handle, purpose in serif italic, Model / Issued / Expires "No expiry", band "Workspace agent" / "Personal agent"); back = Access (server grid, R/W badges, "+N more") · Skills (≤ 6 + "+N more") · signature strip · limits in plain words ("read only, everywhere") · machine-readable zone. Drag to swing, tap to flip; Front / Back control for keyboard users.
- Theme: dialog chrome, fields, steps, buttons and chips follow the theme; card, sheet, pad, strap and metals stay fixed (the pad uses `--pr-paper-2` in dark). Idle sway, tilt, pose fade, ink draw and seal animation stop under reduced motion; user-driven flip and drag remain.
- ≤ 760 px: one column with the card above the form; ≤ 560 px: model grid one column and step tabs show numbers only (the label stays in the accessible name).

### 15.4 Printed-material blocks (the only raw hex outside `color.css`)

Board (`.page`): `--pb-metal-hi #E7E2D6` · `--pb-metal #B3AB99` · `--pb-metal-lo #6E685C` · `--pb-pin-stem #8A867A` · `--pb-pin-cast rgb(16 20 24 / 22%)` · `--pb-live-hi color-mix(in srgb, var(--signal) 45%, #fff)` · `--pb-live var(--signal)` · `--pb-live-lo var(--signal-hover)`.

Desk (`.idd`): `--pr-paper #FFFFFF` · `--pr-paper-2 #F4F7F8` · `--pr-sheet #F7F4EC` · `--pr-rule #D8E0E4` · `--pr-ink #1F2A30` · `--pr-ink-3 #6B777E` · `--pr-ink-4 #A3AFB5` · `--pr-pen #1D2D52` · `--pr-signal #2A72A3` · `--pr-signal-soft #EAF5F8` · `--pr-warn-soft #FFF3D9` · `--pr-warn-ink #7D5D1D`.

Card (`.idc`): `--c-bg1 #FCFCFA` · `--c-bg2 #E9EDEC` · `--c-ink #161B1F` · `--c-ink2 #56626A` · `--c-ink3 #8A959B` · `--c-line rgb(22 27 31 / 10%)` · `--c-gl #161B1F` · `--c-gl-o .07` · `--c-acc #161B1F` · `--c-warn #161B1F` · `--c-edge rgb(255 255 255 / 90%)` · `--c-ph1 #F3F4F3` · `--c-ph2 #DDE1E0`; silver chip metal `#F4F7F8 #C9D1D6 #97A3AA #6B777E`.

Agent pastel tints (artwork): ice `#EAF5F8` / `#3691CD` · mint `#E7F4ED` / `#A9D5BE` · butter `#FFF3D9` / `#EBCB8B` · peach `#FBE9DD` / `#F0B999` · lilac `#EFEDF8` / `#C4BDE3` (wash / frame). Caption ink is chosen by luminance (white on dark tints, `#1F2A30` otherwise). These tints are the agent's *portrait* artwork only (sanctioned, 19.1) and **must not** map to an `--id-*` slot. The agent's *identity hue* everywhere else in the product (stream, panel, helpers) is the `--id-1..5` slot assigned by first appearance (19.2).

---

## 16. Data visualisation

Forms come from the chart system (`Charts-v2-hig.html`, reference only); colour from chapter 02; type from chapter 01. Reference: `system/chart-studies.html`.

Rules:
1. Series stay neutral: `--cx-data` and the ordered `--cx-r1…r4` ramp. A rainbow is not a scale.
2. Signal marks only what is live or selected: the now line, the live dot, the live edge of a running bar, a selected point, today in a heatmap.
3. Status annotates an exception (a failed trace bar, an outlier) with a glyph and a word; it is never a category.
4. Identity never enters data (the one allowed exception: an agent's own lifetime bar in a trace).
5. Labels carry the reading: direct values, axes and a table underneath; colour is the last cue, never the only one.
6. Tokens only; no hex in a chart.
7. Waiting for the person is drawn as blocked time (`--warn` + hatch), kept apart from working time.
8. Bars and marks use `--r-mark` (3 px) and stay round; never fully rounded bars.

Forms in use: readout tiles (four numbers + one trend + context ring + share stack), step waterfall (one row per step on real time, failed steps keep position, bar and glyph), scatter + evidence table (the table is the source of truth), heatmap (neutral density ramp, today ringed in signal), event log (status lives here, with glyph and word), meters with thresholds (context 75 % warn / 90 % full in the trace, 80 % in the panel), comparison strips (band / median / dot).

Accessibility: each chart is `role="img"` with an `aria-label` that lists its values, or `aria-hidden` when an adjacent list or table carries the same facts.

For anything not covered here, follow the `dataviz` method with this palette (neutral series, signal live only).

---

## 17. Content, voice and formats

### 17.1 Voice

- Plain, business-safe language. Say what happened and what it means: "Pulled Q3 revenue from the dashboard", not `qlik.get_sheet_data`. Raw tool names, inputs and span IDs live behind **Technical**.
- Sentence case everywhere (headings, buttons, tabs). Uppercase only in mono micro labels.
- Buttons are verb + object and name the outcome: "Approve plan", "Allow once", "Send answer", "Compact conversation", "Show in chat". Never "Submit", "OK" or "Yes".
- Errors name the fix and offer the smallest step forward; references go in a chip ("Ref t_04 · 429").
- The person's choices are stated neutrally: "Stopped by you", "You declined", "Not allowed" — never framed as failures.
- Point decisions to the chat: "Nothing is created until you answer there."
- Pending vs done tense: present for running ("Pulling…"), past for done ("Pulled…"), future/planned for not yet run ("Will create…"), "Stopped while ‹present›" for a cut step.
- Empty states invite ("No sessions yet. Start a session to see turns, plans and files here."). Loading titles end in "…". Titles ≤ 5 words.
- Curly quotes and apostrophes (“ ” ’) and the real ellipsis (…).

### 17.2 Formats

| Thing | Format | Examples |
|---|---|---|
| Duration | `< 10 s` one decimal; `< 60 s` whole seconds; else `Xm Ys` (panel pads seconds: `1m 05s`) | 6.3s · 12s · 1m 5s |
| Clock time | locale short time | 10:31 · 2:41 PM |
| Relative time (history) | m / h today, weekday this week, `Mon D` older | 12m · 1h · Sun · Oct 18 |
| Countdown | `m:ss` under an hour, `1h 05m` above | 4:59 |
| Tokens / counts | `k` above 1000, no `.0` | 18.4k · 38,206 (exact in receipts) |
| Money | `$x.xx`, "est." when estimated | $0.42 est. |
| File size | KB / MB rules (12.3) | 480 KB · 2.4 MB |
| Percent | integer unless precision matters | 62% · −3.1% |
| Delta | arrow + value; arrow is direction, not judgement | ↑ 12.4% · ↓ 8.2% |
| Ratios | "3 of 4", "3 / 4" in mono | Checks 3 / 4 |
| Separators | middot `·` between tokens | T4 · 00:04:38 |
| Plurals | always handled | 1 helper · 3 helpers |
| IDs | mono, in a reference chip | tr_7f3a91c2 · req_7f3a21 |
| Masked values | "•••" in text, a `masked` token in Technical, "Answer hidden" for secrets | j•••@acme.com |

### 17.3 Privacy in copy

Never show secrets, keys, tokens, full paths or full URLs in any visible text, record, toast, log export preview or accessible label. Hosts only for web sources. Field names, never values, when summarising a form the person sent.

Masking **must** be one shared function used by every surface (the stream, tool arguments, WebSearchRow, ToolActivityRow, TurnError and records), so the rule can never drift between them:

- URLs and file paths → "•••".
- E-mail → first letter + "•••@domain" (e.g. `j•••@acme.com`).
- Key-like tokens → "•••": any token beginning `sk-`, `pk-`, `rk-`, `api_`, `key_` or `tok_`, and any unbroken run of **32 or more** characters.

The study's `activity.js` mask does not yet apply the key-like-token rule — a migration item (19).

---

## 18. Accessibility contract

- **Contrast**: text ≥ 4.5:1, marks ≥ 3:1 in all four contexts (ledger 4.8). Measure new pairs before shipping.
- **Never colour alone** (status glyph + word; identity + shape; charts + labels).
- **Text scaling**: every surface works at 150 % and 200 %; containers fold earlier rather than break; 320 px reflow.
- **Targets**: ≥ 24 px; decisions ≥ 36 px (44 on touch-first surfaces).
- **Keyboard**: every action reachable and operable; visible focus (`--focus`, one halo); logical order; no traps. Menus, tabs, radio groups and segmented controls use roving focus with arrows; a radio group (including the Agents board filter, `role="radiogroup"`) **must** rove with ←/→/↑/↓ and Home/End, moving selection with focus and keeping one control in the tab order (`tabindex` 0 on the checked radio, −1 on the rest). The study's Agents filter wires only `click` and no arrow handling — a migration item (19). Esc closes overlays and returns focus to the trigger; dialogs trap focus while open and restore it on close.
- **Semantics**: native elements first (`button`, `details`, `input`); `aria-expanded` + `aria-controls` on every disclosure; `aria-pressed` on toggles; `aria-selected` on tabs; `aria-current` on the current page, session, scope and step; `aria-disabled` (not `disabled`) for visible-but-unavailable items that must stay discoverable; `aria-invalid` + `aria-describedby` on fields in error; `aria-busy` on a turn being generated; `aria-keyshortcuts` on shortcut keys. The application **must** bind every chord listed in 11.10 (⌘J, ⌘K, ⌘B, ⌘., ⌘, and ?), and `aria-keyshortcuts` **must** advertise only chords that are actually bound. The study binds ⌘J, ⌘B and ⌘. (`chat.js`); ⌘K, ⌘, and ? are a migration item (19).
- **Live regions**: one polite status region per app for announcements; `role="alert"` only for errors that need immediate attention; `role="timer"` for countdowns; `role="status"` on working indicators and notices. Toasts never take focus.
- **Names**: icon-only buttons have `aria-label`; decorative SVG is `aria-hidden="true"` and `focusable="false"`; images have alt text; data visuals have value-listing labels or an accessible twin (table, list).
- **Motion**: reduced motion honoured by media query and `data-eff-motion` (8.3).
- **Hover**: nothing is hover-only; on `hover: none` devices tooltips are not relied on and the dock is always visible.
- **Language**: `lang` declared; no text in images.
- **Forced colours**: manual review; borders and glyphs must still carry state.

---

## 19. Decisions, deviations and migration

Version 2.0 closes every decision that 1.0 left open. The application follows the contract in chapters 0–18 as written; where a study file in `system/` does not yet match, the gap is listed in 19.5 as a code change to make, not as a reason to copy the study.

### 19.1 Sanctioned exceptions (allowed raw values)

| Where | What | Why |
|---|---|---|
| `color.css` | all hex | the palette's home |
| `space.css` | shadow rgb values | elevation's home |
| `type.css` `::selection` | `var()` fallback literals `#BCDEE8` (light) and `#1F2A30` (dark) | defaults inside a foundation file, used only if `--signal-soft` fails to resolve |
| Printed artwork: `--pb-*`, `--pr-*`, `--c-*`, robot `LOOKS`, pastel portrait tints, metals, strap, sticker and card geometry, sub-11 px type and card radii on the Agent ID card and sheet (`agent-id.css`) | raw hex and px | a fixed physical material in every theme; must stay scoped and named once |
| Floating dock (`.cs-dock`) | raw px geometry (40 px keys, 20 px glyphs, 12 px offsets, 92 px reserve) and `#fff` in `--dock-shine` / `--dock-rim` | magnification is measured in CSS px and must not scale with text size |
| Trace card slip and jar | SVG coordinates, tiny rotations, gloss `#fff` / `#000` stops | ported chart artwork |
| Avatar initials | type below `--t-micro` inside an avatar circle | decorative; the name is always present as text or `aria-label` |
| Mask gradients | `#000` in `mask-image` | a mask channel, not a colour |
| SVG geometry | coordinates and stroke widths | drawing, not layout |

Anything else raw is a deviation.

### 19.2 Decisions closed in 2.0

Each decision is binding. The "Rule" column is what the application does; the section named holds the full contract.

| # | Question in 1.0 | Rule | Spec |
|---|---|---|---|
| D1 | Approval cards and the Activity Panel both use `.ap` | The Activity Panel keeps `.ap` / `.ap-*`. The request-card shell renames `.ap` / `.ap-*` → `.rq` / `.rq-*` (`.rq-head`, `.rq-time`, `.rq-soft`, `.rq-err`, `.rq-ic`, `.rq-ref`, `.rq-btns` …). Part prefixes `.aq-` (question), `.at-` (tool), `.ar` (record), `.el-` (elicitation), `.pl-` (plan) stay. | 13, 14 |
| D2 | `chat.html` still shows an inline rail with Activity / Agents / Files / Plan and "Session activity" | The only Activity Panel is the locked four-tab panel from `business-activity.*`. The inline rail is a stale scaffold and is removed, not restyled. | 11.1, 14 |
| D3 | Activity Panel tablist has no arrow-key focus | Roving focus: ←/→ move, Home/End jump, `tabindex="0"` on the selected tab and `-1` on the others, automatic activation on focus move. | 14.11 |
| D4 | Request cards (`.ap`) differ from the `.pt-req` pattern | The product card is the contract: `--r-lg`, text countdown, ApprovalRecord written into the stream. `.pt-req` is updated to match the product. The ring clock, the resolved strip in the dock and the stacked queue are retired. | 10.4, 13 |
| D5 | Stacked queue vs one card at a time | One card at a time in `.cs-pinned`, oldest first. The queue position shows inside the card as the "n of m" badge (`.aq-step`). | 10.4, 13.1, 13.3 |
| D6 | Should an agent's pastel portrait tint map to an `--id-*` slot? | No. Tints are portrait artwork only (19.1). Identity colour everywhere else is `--id-1` … `--id-5` by first appearance. | 4.5, 15.4 |
| D7 | Model names and server catalogues differ between board and desk | One model and server catalogue from the backend. Display names drop the "Claude " prefix and use the catalogue's casing and version, e.g. "Haiku 5.5". | 15.1, 15.3 |
| D8 | Current conversation row: `--signal-soft` (product) vs `--well` (pattern) | Signal tint: `background: var(--signal-soft); color: var(--signal-ink)`. Selection is a signal job. | 10.1, 11.2 |
| D9 | Corners study lists "Icon cuts · 45° cut"; icon rev 02 removed the cuts | Icons follow rev 02 (continuous hand). The "Icon cuts" entry is dropped from the round charter. | 6.3, 7 |
| D10 | Agent ID desk: three steps or four? | Four steps. | 15.3 |
| D11 | Request-card decisions use `tx-sm` (28 px) buttons | The decision row uses default-height buttons (36 px). `tx-sm` is only for secondary in-card controls (show details, copy). | 9.4, 13.1 |
| D12 | Key-like tokens are masked in TurnError but not in the stream | One shared masking function for every surface (stream text, tool arguments, WebSearchRow, ToolActivityRow, TurnError, ApprovalRecord): URLs and file paths → "•••"; e-mail → first letter + "•••@domain"; key-like tokens (`sk-`, `pk-`, `rk-`, `api_`, `key_`, `tok_`, any run of 32+ characters) → "•••". | 12, 17.3 |
| D13 | Shortcuts labelled but not all bound | The application binds every chord in 11.10 (⌘J, ⌘K, ⌘B, ⌘., ⌘, and ?). `aria-keyshortcuts` advertises only bound chords. | 11.10, 18 |
| D14 | Agents filter radiogroup is click-only | Every radiogroup roves: ←/→/↑/↓ move, Home/End jump, one stop in the tab order. | 9.9, 15.2, 18 |
| D15 | Held composer copy: "Held until the request is answered." vs "Answer the request above to keep going" | Both stay; they do different jobs. The note under the composer is the status ("Held until the request is answered."); the disabled input's placeholder is the instruction ("Answer the request above to keep going"). | 10.4 |
| D16 | `.pt-brand-word` uses a raw `1.125rem` | The brand word uses `--t-h3` with `--cut-brand`, as the chat sidebar already does. | 2.4, 10.1 |
| D17 | `.pt-user` foot avatar is a raw `1.75rem` circle | Use `--av-md` (2rem), matching the chat sidebar's `.cs-avatar`. | 5.4, 10.1 |

### 19.3 Off-scale values in screen CSS (decided mappings)

Every value below is mapped; no new type role or radius is added. New size tokens are marked in 5.4.

| Found | Where | Map to |
|---|---|---|
| font-size `.75rem` (12 px) | activity rows, files meta, attach note, error tip, plan note, approval record, compaction text, elicitation sub/hint, trace labels | `--t-meta` (0.8125rem) |
| font-size `.6875rem` as Bricolage UI text | file meta numerals, helper model, plan labels, request hint/note, elicitation option | `--t-meta`; mono labels and tool arguments use `--t-micro` (0.6875rem, mono) |
| font-size `.625rem`, `.5625rem`, 9 px | mono keys (`.aq-k`, `.ar-k`), tool chips (`.hg-tool`, `.hg-mark`), trace axis, `.pt-irail-lbl`, `.pt-req-clock small` | `--t-micro`; only avatar initials may stay smaller (19.1) |
| radius `8px` | helper tiles (`.hg-tile`), Agent ID model tools (`agent-id.css`) | `--r-sm` (10px) |
| radius `4px`, `6px` literal | helper labels, badges and bars, multi-select ticks, attach tile | `--r-xs` (6px) |
| radius `2px` on chart marks | Activity Panel charts (`business-activity.css`) | `--r-mark` (3px) |
| `2px`, `3px`, `5px`, `6px`, `10px` gaps and paddings | many small parts in chat, approval, elicitation, helpers, trace, agents | 2 → `--sp-h`; 3, 5, 6 → `--sp-1` (4); 10 → `--sp-2` (8) |
| `.2s linear` progress transition | attach progress line (`.ac-bar i`) | `var(--tx-d-2) linear` |
| `width: 20rem` at ≤ 1220 px | narrow Activity Panel | `--inspector-sm` (new in 2.0), applied to the `business-activity` panel |
| hero heading `clamp(2.125rem, 4.5vw, 2.75rem)`, weight 780, `--cut-hero` | chat hero | the `.t-h2` role |
| avatar sizes `1.25rem`, `1.375rem`, `1.5rem`, `2rem`, `3rem`; state dot `7px` | chat, Activity Panel, agents screens | `--av-xs` (1.25rem), `--av-sm` (1.5rem; 1.375rem folds into it), `--av-md` (2rem), `--av-lg` (3rem), `--dot` (0.4375rem) |

### 19.4 Product gaps the system does not yet specify

- Session view of the Activity Panel (next to design).
- Settings, Keyboard shortcuts sheet, Help, Share dialog, Knowledge base (marked Soon).
- Command palette wired in the chat screen (⌘K is labelled but has no handler in the study); ⌘, (Settings) and ? (Keyboard shortcuts) are labelled with no handler and no destination screen yet.
- The motion chapter: only `--tx-d-1/2/3` and `--tx-spring` exist as tokens; the three springs in 8.2 are design intent until the chapter ships.
- The full icon set (29 of 34 glyphs to draw).
- Chart layer (forms on trial).

### 19.5 Migration list (study code → contract)

These are changes to the `system/` sources so they match 2.0. Until a row is done, the application follows the contract, not the study.

| # | Change | Where (current) | Decision |
|---|---|---|---|
| M1 | Rename the request-card shell `.ap` / `.ap-*` → `.rq` / `.rq-*` in CSS and JS | `screens/approval.css` (from line 7, incl. `.ap.is-nudge` at 277), `screens/approval.js`, `screens/chat.js` (nudge, line 510) | D1 |
| M2 | Remove the inline activity rail (`.cs-activity`, "Session activity", "Wide", tabs Activity/Agents/Files/Plan) and mount the `business-activity` panel | `screens/chat.html:277–290`, `chat.css`, `chat.js` | D2 |
| M3 | Add roving focus to the panel tablist | `screens/business-activity.js:1248–1294` | D3 |
| M5 | Drop `tx-sm` from request-card decision buttons (tool Allow / Don't allow, plan Approve / Revise, question Next / Send) | `screens/approval.js` | D11 |
| M7 | Remove "Icon cuts · 45° cut" from the round charter | `04-corners.html:861–862` | D9 |
| M8 | Redraw the five chat sprite glyphs (`i-run`, `i-agent`, `i-trace`, `i-tool`, `i-search`) to rev 02 `n-*` geometry | `screens/chat.html:54–58` vs `icon-foundations.html` | D9 |
| M9 | Add the key-like-token rule to the stream masker and route every surface through one function | `screens/activity.js:41–47` (`mask`, `maskDeep`); `error.js` `scrub` already has the rule | D12 |
| M10 | Bind ⌘K, ⌘, and ?; keep `aria-keyshortcuts` to bound chords (⌘J, ⌘B, ⌘. are bound) | `screens/chat.js` (key handlers near 1411 and 1734) | D13 |
| M11 | Add arrow-key roving to the Agents filter radiogroup | `screens/agents.html:68`, `screens/agents.js` | D14 |
| M12 | Board model label `haiku 4.5` → catalogue name "Haiku 5.5"; one shared model and server catalogue | `screens/agents.js:46–50`, `screens/agent-id.html:398–413` | D7 |
| M13 | Empty-search copy uses curly quotes: `No agents match “‹query›”` | `screens/agents.js:155` | 17.1 |
| M16 | Off-scale sweep (19.3): type, radius, gap and transition literals | `chat.css`, `activity.css`, `files.css`, `attach.css`, `error.css`, `plan.css`, `approval.css`, `elicit.css`, `helpers.css`, `trace.css`, `business-activity.css`, `agents.css`, `agent-id.css` | 19.3 |
| M17 | Chat hero heading → `.t-h2` | `screens/chat.css:393–399` | 19.3 |

When a row is done, delete it here and add a line to the change log (21).
## 20. Review checklist

Copy into every PR that changes UI.

**Foundations**
- [ ] No raw hex, px/rem spacing, font-size, radius or box-shadow outside the sanctioned list (19.1).
- [ ] Every text uses one of the 13 roles; figures use `.num` / `.t-num`.
- [ ] At most one serif accent on the surface, at headline size.
- [ ] Spacing is on the lattice and in the right lane; `gap` over margins.
- [ ] Radii from the ladder; nested radii subtract the inset; circles, capsules and marks stay round.
- [ ] Elevation matches overlap (T0–T3); no coloured shadows.

**Colour**
- [ ] Signal used only for interaction, selection, focus, live; one primary on the surface.
- [ ] Every status has a glyph and a word; stopped / declined / skipped are neutral.
- [ ] Identity hues only on agent marks, assigned by first appearance.
- [ ] Charts neutral; signal only on live/selected; status only on annotated exceptions.
- [ ] Checked in light, dark, light + and dark +.

**Behaviour**
- [ ] Answer before evidence; work folded; request docked above the composer; composer always visible.
- [ ] Decisions only in the main chat; the Activity Panel has no state-changing control.
- [ ] Empty, loading and error states exist and each has its exit.
- [ ] Copy follows section 17 (verb + object, sentence case, formats, masking).
- [ ] Request cards use `.rq-*`, mount one at a time with the "n of m" badge, and the decision row uses default-height buttons (19.2 D1, D5, D11).
- [ ] Every masked surface goes through the one shared masking function, including key-like tokens (D12).

**Access**
- [ ] Keyboard path complete; focus visible and returned after overlays.
- [ ] Correct roles and ARIA states; live announcements through the shared region.
- [ ] Tablists and radiogroups rove with arrow keys and Home/End; `aria-keyshortcuts` names only bound chords (D3, D13, D14).
- [ ] Works at 150 % and 200 % text, 390 px wide, and under reduced motion (static twins present).
- [ ] Contrast measured for any new pair.

---

## 21. Changing the system

1. A value that does not exist is a **token request**, not a local decision. Write the job it does, where it is needed, and why an existing role cannot do it.
2. Add it to the foundation file first (`color.css` for colour in all four contexts, `type.css`, `space.css`, `primitives.css`, `patterns.css`), then to the chapter page, then to this document.
3. Colour additions need measured contrast in all four contexts and must not add a hue outside the three jobs.
4. Locked chapters (01–03) change only by explicitly reopening the lock. The Activity Panel's four tabs are locked the same way.
5. A pattern that needs a new control means the primitive is missing from chapter 05: add it there, not in the pattern.
6. Every change ships with its narrow twin (390 px, 200 %, keyboard, reduced motion).
7. Update the version line at the top of this document and note the change below.

### Change log

- 1.0 · 28 Oct 2026 — first complete specification, written from `system/` foundations (type, colour, space, corners, primitives, patterns), icon rev 02, chart study, and the screens: chat, stream parts, requests, Activity Panel (`business-activity`), agents board and Agent ID desk.
- 2.0 · 28 Oct 2026 — every chapter re-checked against its `system/` source; corrections applied (icon sprite geometry, request-card terminal copy, masking coverage, keyboard bindings, dock hysteresis, model catalogue, panel crew states and more). All 1.0 open decisions closed (19.2 D1–D17) and off-scale values mapped (19.3); new tokens `--inspector-sm`, `--av-xs/-sm/-md/-lg`, `--dot`; added 0.4, 2.4 and the focus-and-selection rules from the earlier partial draft (`truex-design-spec.md`, now removed); chapter 19 gains the migration list (19.5).
- 2.1 · 28 Oct 2026 — migration rows M4, M6, M14, M15 and M18 done in `system/`: `space.css` gains `--inspector-sm`, `--av-xs/-sm/-md/-lg` and `--dot`, and the avatar and state-dot literals in `chat.css`, `business-activity.css`, `approval.css` and `agents.css` use them; the business-activity panel narrows to `--inspector-sm` at ≤ 1220 px; `patterns.css` retires the ring clock, stacked queue and resolved strip, adds `.pt-req-step` and `.pt-req-time`, and moves `.pt-req` to `--r-lg`; the current session row uses signal tint (D8); the brand word uses `--t-h3` (D16); `.pt-composer` gets a base border. M18 asked for a transparent border; it is `--line` instead, because `patterns.css` loads after `primitives.css` and a transparent border would erase the `.tx-card` hairline every composer carries.
- 2.2 · 28 Oct 2026 — `.tx-seg` shows its selected look for `aria-checked="true"` too, so a segmented control built as the radiogroup 9.9 requires (`role="radio"`, which cannot carry `aria-pressed`) is styled without a second state attribute.
