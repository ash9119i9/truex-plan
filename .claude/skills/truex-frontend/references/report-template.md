# Frontend Report

Scale it to the change: a one-file change may need three lines. Every finding names a rule from [rules.md](rules.md), or says why no rule covers it.

## Proposal (review mode: wait for approval before editing)

```text
Scope: <files>, route(s): <routes>, reached by a route: yes / <files not reached>
Next docs read: <doc paths>, or "no Next API touched"

Findings
  1. [High]  R2  chat-transcript.tsx:428  saved exchanges re-render on every stream frame
     Evidence: measured | read | unverified   <what was seen: number, test output, or the code path>
     Fix: <smallest change>   Test: <test file and name, or browser scenario>
  2. [<level>] <rule>  <file>:<line>  <what is wrong, in one line>
     ...

Not checked: <rule groups or scenarios skipped, and why>
```

## Report (after the work)

```text
Changed: <files>
Measurements (same machine, same mode, before → after):
  /t/[tenantId]/chat first-load JS: 914,766 → <n> bytes
  parsedChars (prose / code): <n> → <n>
  Browser: <scenario>: <number> → <number> (<browser>, <viewport>, next dev | next start)
Tests: <file>: <names>, failed against the baseline and pass on the change
Checks: typecheck <ok>, npm test <pass>/<total>, build <ok>, prettier on changed files <ok>
Browser check: <what was looked at>, or "not done: <reason>"
Noticed, not touched: <items or "none">
```

## Severity

| Level | Meaning in the frontend |
|---|---|
| Critical | Data shown to the wrong person, a token exposed, or the chat unusable for everyone |
| High | The chat freezes, drops or duplicates reply text, loses a draft, or cannot be used with a keyboard or screen reader |
| Medium | Measurable slowdown on a common path (per-frame work that grows with chat length, a route's JS up by more than 10%), a leak over a long session, an inaccessible secondary control |
| Low | A rule broken with small measured or likely impact |
| Info | A suggestion with no demonstrated effect |

Evidence decides the label: **measured** (a number or a failing test), **read** (a code path that shows it, with `file:line`), **unverified** (plausible, not shown). Severity above Medium needs measured or read evidence.
