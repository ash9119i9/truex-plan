# Frontend redesign (design spec v2)

Added 2026-10-28 · Source: `system/DESIGN-SPEC.md` v2.0

The frontend is rebuilt to `system/DESIGN-SPEC.md`. The spec is the contract; `system/screens/*` are the working designs it ports.

## Decisions

- **The v2 spec wins.** The 26 Oct scope doc (`docs/FRONTEND_DESIGN_REVAMP_SCOPE.md`) was removed. Its choices to keep Figtree, retire the topbar and dock, defer the trace and Insights views, and ship no handles no longer apply.
- **Tailwind is dropped.** Outside `legacy/`, the frontend uses no Tailwind utility classes. Helpers such as `.grow` and `.sr-only` come from `styles/v2/base.css`. Tailwind is loaded only for its preflight reset, and `cn()` wraps tailwind-merge. The spec needs every value to come from a token, and its CSS (`tx-*`, `pt-*`) is plain CSS. The Foundations step removes `tailwindcss`, `@tailwindcss/postcss` and `tailwind-merge`, keeps `clsx` for joining class names, and adds a small reset of its own (box-sizing and form-control inheritance), because the system CSS doesn't ship one.
- **The duplicate render was removed.** `system/truex-design-spec.html` was a second HTML render of `DESIGN-SPEC.md`. `system/DESIGN-SPEC.html` (from `system/build-spec.py`) is the render to use.
- **The spec stays complete.** Content with no backend yet is kept in the spec and designed now. The backend work is tracked below.

## Spec content with no backend data yet

The design proceeds as specified. Each item needs backend work before the screen can show real data.

| # | Item | Spec |
|---|---|---|
| 01 | [Turn cost and per-turn budget](01-turn-cost-and-budget.md) | 14.8, 12.8 |
| 02 | [Time breakdown and step timings](02-time-breakdown-and-step-timings.md) | 14.5, 14.8, 12.8 |
| 03 | [Comparison with the agent's usual turn](03-usual-turn-comparison.md) | 14.8 §5 |
| 04 | [Context composition (context jar, Model context)](04-context-composition.md) | 12.8, 14.8 §4 |
| 05 | [Footprint: read vs changed, file counts](05-footprint-read-vs-changed.md) | 14.5 §3, 14.7 |
| 06 | [Sources the answer was built from](06-answer-sources.md) | 14.5 §5 |
| 07 | [How it checked the answer](07-answer-checks.md) | 14.8 §6 |
| 08 | [Privacy findings](08-privacy-findings.md) | 12.8 |
| 09 | [Approval modes: Always allow, read-only, Autopilot](09-approval-modes.md) | 13.4, 13.6, 13.7 |
| 10 | [MCP elicitation cards](10-mcp-elicitation.md) | 13.5 |
| 11 | [Agent identity fields](11-agent-identity-fields.md) | 15.1–15.3, 14.6 |
| 12 | [Share a conversation](12-share-link.md) | 11.3 |
| 22 | [Reasoning stream for the ThinkingBlock](22-reasoning-stream.md) | 12.1 |
| 23 | [Tool details and web search rows](23-tool-details-and-web-search.md) | 12.2 |
| 24 | [Question and plan-approval requests](24-questions-and-plan-approval.md) | 13.2, 13.3 |

## Unfinished in the spec (design first)

| # | Item | Spec |
|---|---|---|
| 13 | [Full icon set](13-icon-set.md) | 7, 0.1 |
| 14 | [Motion chapter](14-motion-chapter.md) | 8, 19.4 |
| 15 | [Sign-off: corners, primitives, patterns](15-sign-off-corners-primitives-patterns.md) | 0.1 |
| 16 | [Activity Panel session view](16-activity-panel-session-view.md) | 19.4 |
| 17 | [Settings, shortcuts sheet, command palette, Help](17-settings-shortcuts-palette-help.md) | 19.4, 11.10 |
| 18 | [Knowledge base](18-knowledge-base.md) | 19.4, 15.3 |
| 19 | [Chart layer](19-chart-layer.md) | 16, 19.4 |
| 20 | [System migration list M1–M18](20-system-migration-list.md) | 19.5 |
| 21 | [Live screens the spec doesn't design](21-screens-without-design.md) | none |

## Build order (when planned)

1. Foundations: system CSS, theme resolver, fonts, reset; remove Tailwind and the old CSS.
2. Controls: `tx-*` as React components.
3. Shell and chat: sidebar, topbar, start screen, composer.
4. Reply parts: reasoning, tools, helpers, plan, files, error.
5. Request cards.
6. Activity Panel.
7. Agents board and Agent ID desk.

Each step ships on its own, so the work can stop safely after any step.
