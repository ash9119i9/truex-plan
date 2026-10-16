# Runtime adapter: per-message disk work on AgentCore storage

Status: open · measure on AgentCore, then decide · Added 2026-10-17

## Problem

On every message, even when Codex already has the thread loaded, the adapter creates the chat's directories (if missing) and reads `chat.json`. On a local disk this costs under 1 ms. In production the same work runs on AgentCore persistent session storage (`/mnt/state`), where the cost is unknown.

## Proposed fix

Skip the directory creation and `chat.json` read once the chat's Codex process has the thread loaded; keep them only for the cold path (first message after a new microVM or idle shutdown).

## Measure first

In the deployed AgentCore test, record:

- the cost of the per-message disk work on `/mnt/state` on a warm follow-up;
- a cold resume end to end, including Codex's SQLite reads and writes on `/mnt/state`.

Only build the fix if the warm per-message cost is noticeable next to the 13 ms local follow-up overhead.

## Done when

- `/mnt/state` costs are recorded here.
- If built: warm follow-up latency measured before and after on AgentCore; the chat-binding check (one chat per session) and resume tests still pass.

Local-only findings (many concurrent Codex processes, debug-build memory) are deliberately not tracked: production runs one chat per AgentCore microVM on the release build.
