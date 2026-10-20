# Dense text (CJK, emoji) fills the context window fast

Status: open · Medium · Added 2026-10-20 · Source: context stress test

## Observed

- One 32,000-character CJK message (the per-message maximum) is about 99k tokens, 38% of today's 258k usable window. 32k characters of emoji is about 56k.
- After compaction a CJK chat still held 175k tokens, because Codex assumes about 4 bytes per token for the messages it keeps. Such chats compact every 1–2 turns. Sequence: 99k → 190k → 280k → compaction → 175k.
- Each compaction is a 40–45 s wait (see `backlog/features/03-compaction-status.md`).

## Options

- Limit messages by estimated tokens as well as characters, so one message can't take more than a set share of the window.
- Raise the usable window first (`backlog/model-provider/03-context-window-cap.md`); this alone eases most of it.
- Leave as is and only show the condensing state, if dense-script tenants are not expected soon.

## Done when

A decision is recorded here and, if limits change, a CJK fill test shows at least several turns between compactions.
