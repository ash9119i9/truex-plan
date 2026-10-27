# Document export fails in the coding sandbox, saves an empty PDF and burns tokens

Status: open · High · Added 2026-10-27 · Source: chat `6ae0724170b39fcf2347fd2d` (tenant `truex_next_t_default`, Nemotron, coding on) · Related: `backlog/features/04-coding-agent-codex-tools.md` ("Office documents through skills")

## Observed

The member asked to "export it as a Markdown/PDF file". The `.md` and `.html` were written; no usable PDF was. From the Codex log of run 2:

| Attempt | Result |
|---|---|
| Look for `wkhtmltopdf`, `weasyprint`, `prince`, `apt-get` | None installed |
| `import markdown` (7 tries) | `No module named 'markdown'` |
| `weasyprint` after installing it | Missing system library (`libgobject`) |
| `brew install wkhtmltopdf` | Blocked by the sandbox network (HTTP 403) |
| `cupsfilter`, a WebKit tool, Safari via `osascript` | All failed; `cupsfilter` left a 0-byte `performance_guide.pdf` |
| `pip install fpdf2`, then 8 scripts | Font encoding errors (`–`, emoji), then "not enough horizontal space" |

37 commands, 19 failed, ~704K input tokens, ~8.5 minutes. The reply ended "PDF generation is blocked" and suggested Print → Save as PDF. What the member saw as "retrying" was the model trying approach after approach, not a platform retry loop. No provider errors were seen in the part of the log read.

Run 1 of the same chat is a positive data point: Nemotron started 3 helpers (`helperCount: 3`) and their rows were saved.

## Three issues

### 1. The sandbox has no document tooling (High)

Coding runs use the Mac's `/usr/bin/python3` (3.9) via the PATH set in `runtime-adapter/src/codex/coding.ts:166-181`. It has no `reportlab`, `python-docx`, `openpyxl`, `python-pptx` or `markdown`; there is no `pandoc` or LibreOffice. The coding instructions don't say what is available, so the model guesses. The old `agent-core` stack had document tools; platform-next has none.

Fix direction: give coding runs a pinned document toolset (a pinned Python environment with `reportlab`, `python-docx`, `openpyxl`, `python-pptx`, `markdown`), and tell the model in the coding instructions what to use for each format. `features/04` decided Office documents go through skills, so this is likely a document skill whose scripts run from `$SKILLS/<skill>/scripts/` with its own pinned environment. Needs the same setup on AgentCore (Linux ARM64), not only the local Mac.

Acceptance: "export this as PDF / Word / Excel / PowerPoint" produces a file that opens, in 1–3 commands, on both local and AgentCore.

### 2. Empty files are saved as chat files (Medium)

The 0-byte `performance_guide.pdf` was saved next to the `.md` and `.html`, so the files panel offers a PDF that won't open. `isWorkspaceFile` accepts `size >= 0` (`platform-next/src/modules/chats/runtime-client.ts:451`), and nothing downstream filters empty files.

Fix direction: don't capture 0-byte files (or capture them flagged as empty and don't show a download). Decide whether an intentionally empty file (e.g. `.gitkeep`) matters for chat files; it probably doesn't.

Acceptance: a run that leaves a 0-byte file shows no openable card for it; regression test in platform-next.

### 3. No limit on runaway failed attempts (Medium, needs design)

Nothing stops a run that fails command after command. This one spent ~704K input tokens for no result. Options: stop with a clear message after N consecutive failed commands, or past a per-run token ceiling. Codex's `features.rollout_budget` is tree-wide but under development upstream (see `tasks/subagents-plan.md` P0.10). Some tasks legitimately fail several commands before succeeding, so N must be measured, not guessed.

Acceptance: a run that cannot succeed ends within a bounded token spend, with an error that tells the member what failed and what to try.

## Order

1 removes the cause of this chat's failure; 2 is small and independent; 3 needs measurement first. Fixing 1 makes 3 much rarer for document tasks.
