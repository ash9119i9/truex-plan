# Tool details and web search rows

Status: open · Backend · Added 2026-10-28 · Spec 12.2

## Spec shows

ToolActivityRow with a Details toggle (result summary, masked ARGUMENTS) and a "Read-only" pill; WebSearchRow for searches (queries, hosts, source chips with favicons).

## Exists today

platform-next saves only connector, tool, outcome and duration for a tool call ("Arguments and results are never stored", `platform-next/src/modules/chats/chat.ts`), and no web-search item reaches the browser. The frontend redesign (Task 18) ships the row's name, state, sub-line and time; everything it shows goes through `frontend/lib/mask.ts`.

## Do

- Decide what may be stored and shown (data handling): a short result summary and masked arguments, or nothing.
- Forward `webSearch` items (query, host, source titles) through runtime-adapter and platform-next; mask before display.
- Add `readOnlyHint` from the MCP tool definition when it is known.

## Done when

A tool row's Details shows masked arguments and a result summary, and a web search shows its queries and sources, all through the shared masker.
