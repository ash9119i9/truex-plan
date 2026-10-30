# MCP elicitation cards

Status: open · Backend · Added 2026-10-28 · Spec 13.5, 13.6

## Spec shows

When an MCP server asks for input, the chat shows a request card in one of four modes:

- **form**: fields built from `requestedSchema`, with validation copy.
- **url**: open a link, then Done.
- **verify**: a code to confirm.
- **unknown**: Decline or Cancel.

Responses are accept, decline or cancel. On expiry the request is cancelled. The record lists field names only, never values.

## Exists today

`runtime-adapter` handles `mcpServer/elicitation/request` only as tool approval. Any other elicitation is declined with `not_tool_approval` (`runtime-adapter/src/runtime/chat.ts`, `onApprovalRequest`). The frontend has no elicitation card.

## Do

- Pass non-tool elicitations through to the chat as a new request type, with the server name, mode, schema or URL, and the expiry.
- Validate form answers against the schema server-side before replying to the server.
- url mode: open only `http(s)`, with `noopener,noreferrer`; warn on `http:`.
- Never log or store submitted values. The record keeps field names only.
- Expiry answers cancel.

## Done when

A test MCP server's form, url and verify requests each reach the chat, get answered and leave a record. An unknown mode can be declined.
