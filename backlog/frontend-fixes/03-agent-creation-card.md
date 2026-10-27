# Agent creation: badge preview card

Status: open, needs details · Added 2026-10-17

## Problem

The badge preview card on the right of the New agent dialog needs rework. The exact changes haven't been specified yet.

Observed in the 2026-10-17 screenshot (1440-wide desktop):
- The card shows "Unnamed" and "PERSONAL AGENT" in low-contrast grey until a name is typed.
- The footer shows only the model label (`sonnet 4.5`-style); handles were dropped in v1, so the old handle line is gone.
- The card sits high in the panel, leaving most of the panel empty below it.

## To decide

- What the card should show in v1 (name, scope, model, description?).
- Empty-state text and contrast.
- Position and size within the preview panel.

## Where

- `frontend/components/tenant/tenant-agent-dialog.tsx`
- `frontend/components/v2/agent-dialog.tsx`
- `frontend/styles/v2/agent-dialog.css`
