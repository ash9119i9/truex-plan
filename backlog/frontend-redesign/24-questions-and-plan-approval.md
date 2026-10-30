# Question and plan-approval requests

Status: open · Backend · Added 2026-10-28 · Spec 13.2, 13.3

## Spec shows

Request cards in the dock for plan approval (Approve / Revise with feedback, ⌘↵ sends) and questions (clarification, free text, secret, "n of m" queue).

## Exists today

The new stack can't raise either. runtime-adapter turns Codex's `request_user_input` tool off (`runtime-adapter/src/codex/config.ts`), and its approval kinds are only `mcp`, `command` and `file_change` (`runtime-adapter/src/runtime/run.ts`). The frontend has the answer logic from the old stack (`frontend/lib/request-input.ts`, `frontend/lib/plan.ts`, both tested) but no card, because nothing would show it. The dock (Task 22) already holds one card at a time and is where these cards go.

## Do

- Contract task: enable `request_user_input` for the lead (decide which agents), relay the request and its answer through platform-next (expiry, first-answer race, secret answers never stored or echoed).
- Plan approval needs the plan relay first (`tasks/plan-checklist-todo.md` Tasks 4–6).
- Frontend: question and plan cards in `RequestDock`, sharing the `.rq` shell, keys and once-at-a-time sending.

## Done when

A model can ask a question or ask to approve a plan, the member answers from the dock, and the reply continues with the answer; a secret answer never appears again in the stream.
