# Agent identity fields

Status: open · Backend · Added 2026-10-28 · Spec 15.1–15.3, 14.6

## Spec shows

- `@handle`, derived from the name: lower-cased, non-alphanumerics removed, max 24.
- Instructions as **rules** + **behaviour** (lists of up to 12 items × 160 characters, or text of up to 1,200) + **topics** (`focused` or `open`).
- **Knowledge** sources ("Soon" in the desk; see [18](18-knowledge-base.md)). The board meta shows "3 sources".
- Optional **signature** (an SVG path), an **ID number** "AG-‹4 digits›", and an "Issued" date.
- Agent tab setup snapshot: "Ran on version ‹v›, saved ‹date› by ‹name›" + "✓ Unchanged since".

## Exists today

`AgentDoc` (`platform-next/src/modules/agents/agent.ts:80`) has name, description (the purpose), model, look, tint, scope, connectors (with read/write), skills, helpers, revision and timestamps. There's no handle, no instructions on member-created agents (only built-ins carry `instructions`), no knowledge, no signature, no ID number and no `updatedBy`.

## Do

- Handle: decide whether it's unique per workspace and what happens on a collision (for example a numeric suffix). Store it rather than deriving it at read time, so renaming the agent doesn't break `@mentions`.
- Rules, behaviour and topics: add the fields and the limits, and build them into the chat prompt. Instructions written by members are untrusted input to the prompt. Keep the fixed guardrails after them.
- Signature: store the SVG path and check that its size and characters stay within bounds before saving. Render it as a path, never as raw SVG.
- ID number: stable per agent and unique per workspace.
- Store `updatedBy`, and snapshot the revision a chat started on, so "Unchanged since" can be checked.

## Done when

The board, the desk and the Agent tab show stored values for every field above, and old agents without them read with sensible defaults.
