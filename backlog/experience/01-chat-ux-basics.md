# Chat: small UX touches that build trust

Status: open, not yet checked against the chat v1 frontend · Added 2026-10-19

## Goal

Small, cheap UI touches that make the chat feel fast, clear and safe. Each one should be small on its own. Agent behaviors (what the agent says and does) are in [02-agent-behaviors.md](02-agent-behaviors.md).

First step: check each item against `frontend/components/tenant/` and mark it present, partial or missing.

## Before sending

- [ ] Drafts survive a refresh, a chat switch and a failed send.
- [ ] Starter prompts per agent, based on its real tools ("Summarize a PDF", "Research a competitor").
- [ ] Composer chips showing what the agent can use (Web, Docs, Jira).
- [ ] Large pastes (e.g. 2,000 lines) become a file chip instead of filling the input.
- [ ] Keyboard: Enter sends, Shift+Enter adds a new line, ↑ edits the last message, Esc stops a reply.

## While waiting for the first token

- [ ] The user's message appears immediately, and a status shows within about 100 ms.
- [ ] Specific status text ("Reading report.pdf (page 4 of 12)", "Searching for Q3 pricing") instead of a spinner or "Thinking…".
- [ ] Elapsed time on long tasks ("Working · 0:42").
- [ ] Stop is always reachable. A stopped reply keeps its partial text, labeled "Stopped".

## While streaming

- [ ] Scroll position doesn't move while the user reads. If they scrolled up, show a "↓ New content" pill.
- [ ] No layout jumps: code blocks, tables and lists render progressively.
- [ ] Live todo list that ticks off steps, with the current step in the status line.
- [ ] Tool activity in plain language, collapsed ("Searched 3 sources · read 2 files") and expandable.

## After the response

- [ ] Two or three follow-up suggestions, specific to the answer.
- [ ] Copy button per message and per code block, with "Copied ✓".
- [ ] Edit and resend, and regenerate, both keeping the original.
- [ ] Footer line, e.g. "14s · 3 sources · model name". Overlaps [features/01-live-thinking.md](../features/01-live-thinking.md).
- [ ] Sources with titles and favicons, linked to the claims they support.
- [ ] Notify when a long task finishes in a background tab (tab title "✓ Done" or a desktop notification).
- [ ] Rich cards for generated files: preview, file name, download button.
- [ ] Thumbs up/down with an optional one-tap reason.

## Answer quality (system prompt)

- [ ] Answer first, then the detail.
- [ ] Restate the goal in one line for complex asks.
- [ ] Ask one clarifying question instead of guessing when the request is ambiguous.
- [ ] Say when unsure, and cite sources.
- [ ] TL;DR at the top of long answers.

## Across sessions

- [ ] Meaningful auto-titles ("Q3 pricing analysis", not "New chat").
- [ ] Reopening a chat restores the scroll position and the draft.
- [ ] Search across chats; ⌘K for search, ⌘N for a new chat.

## When things go wrong

- [ ] Plain-language errors with a Retry button that keeps the message ("The model provider timed out, your message is safe. [Retry]").
- [ ] Silent reconnects: a quiet "Reconnecting…", then resume from the cursor. No red error for anything recoverable.
- [ ] Confirm before any destructive or outward-facing tool action, saying exactly what will happen.

## Do first

1. Draft persistence, and never losing the user's message on an error.
2. Scroll position held while reading, plus the "New content" pill.
3. Specific status text instead of a spinner.
4. Notification when a background task finishes.
5. Copy buttons with confirmation.
6. Answer-first and TL;DR rules in the system prompt.

## Done when

- Each item is marked present, partial or missing against the chat v1 frontend, and missing ones are picked or dropped.
- Each built UI item is checked in a real browser (headless Chromium with a mocked API), not only in unit tests.
