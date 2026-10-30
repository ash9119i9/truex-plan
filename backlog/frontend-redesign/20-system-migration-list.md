# System migration list M1–M18

Status: open · Design · Added 2026-10-28 · Spec 19.5

## Gap

`system/` sources still differ from the 2.0 contract in 18 places. The spec gives the full table with file locations and decisions. Until a row is done, the app follows the contract, not the study code.

| Row | Change |
|---|---|
| M1 | Rename request-card shell `.ap` → `.rq` |
| M2 | Remove the inline activity rail from `chat.html`; mount `business-activity` |
| M3 | Roving focus on the panel tablist |
| M4 | Retire `.pt-req` clock, resolved strip and stacked queue |
| M5 | Drop `tx-sm` from request-card decision buttons |
| M6 | `.pt-session[aria-current]` → signal-soft / signal-ink |
| M7 | Remove the 45° icon cut from the round charter |
| M8 | Redraw the five chat sprite glyphs to rev 02 (see [13](13-icon-set.md)) |
| M9 | One masking function with the key-like-token rule |
| M10 | Bind ⌘K, ⌘, and ? (see [17](17-settings-shortcuts-palette-help.md)) |
| M11 | Arrow-key roving on the Agents filter |
| M12 | One shared model and server catalogue; "Haiku 5.5" label |
| M13 | Curly quotes in the empty-search copy |
| M14 | Add `--inspector-sm`, `--av-*`, `--dot` to `space.css` |
| M15 | `.pt-brand-word` → `--t-h3` |
| M16 | Off-scale sweep of type, radius, gap and transition literals |
| M17 | Chat hero heading → `.t-h2` |
| M18 | Base transparent border on `.pt-composer` |

## Do

Fix the rows in `system/` before the matching build step ports them: M14 before Foundations; M4–M6, M15 and M18 before Controls; M1, M5 and M9 before Request cards; M2 and M3 before the Activity Panel; M11–M13 before Agents. When a row is done, delete it from 19.5 and add a change-log line.

## Done when

19.5 is empty, and each ported screen matches the contract.
