# Agent creation: field compaction

Status: open · Added 2026-10-17

## Problem

The New agent form is taller than a normal laptop screen. At 1440×900 the Model field sits at the bottom edge, and Cancel / Create agent are only reachable because the form now scrolls with a pinned action bar (fixed 2026-10-17 in `frontend/styles/v2/agent-dialog.css`). Scrolling a short form is a workaround, not the goal.

What takes the space:
- The Look grid: 12 large tiles in two rows.
- The two "Who can use it" cards, each with a second line of help text.
- The Purpose textarea is tall for a 280-character limit.

## Goal

The whole form, including Model and the action buttons, fits without scrolling at 1440×900 and 1280×800 on desktop.

## Where

- `frontend/components/tenant/tenant-agent-dialog.tsx`
- `frontend/styles/v2/agent-dialog.css` (shared with the v2 agent board dialog)

## Done when

- No scrolling needed at 1440×900 and 1280×800; mobile still scrolls as one page.
- Checked in headless Chromium at 1440×900, 1280×720, 1024×640 and 390×844.
- Follows the design spec (`truex-design-spec.html`) and adds no new motion.
