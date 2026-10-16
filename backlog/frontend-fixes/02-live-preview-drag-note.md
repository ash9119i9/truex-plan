# Agent creation: "live preview · drag it around" note overlaps the badge

Status: open · Added 2026-10-17

## Problem

On the mobile layout (seen at 390×844), the "live preview · drag it around" note overlaps the bottom of the badge preview card. Found during the browser check of the dialog height fix; not caused by that fix.

## Where

- `frontend/components/tenant/tenant-agent-dialog.tsx`
- `frontend/components/v2/agent-dialog.tsx`
- `frontend/styles/v2/agent-dialog.css`

## Done when

- The note never overlaps the badge at any size, including after the badge is dragged and released.
- Checked in headless Chromium at 390×844 and the desktop sizes.
