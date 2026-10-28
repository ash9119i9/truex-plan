---
name: truex-secure
description: Attacks the trust boundaries a change in the Truex new stack touches — tenant and member isolation, tokens and sessions, the adapter and gateway credentials, MCP connectors and network egress, the coding sandbox, uploads and skills, prompt injection, and model output reaching the browser — and proves each boundary holds with abuse tests you approve. Run it by name only (/truex-secure). Lists the threat model and proposed abuse tests first and waits for approval before writing any.
disable-model-invocation: true
---

# Truex Secure

## Overview

A trust boundary holds only if a test shows it refusing the attacker. This skill takes a change, names who could abuse it and what they would want, writes the security rules the change must keep before reading the code, and then tries to break each rule with a concrete request, model output, file or connector response. Every rule ends as a passing abuse test, a confirmed finding with a failing test, or an accepted risk with a reason.

In this product the model is an attacker too. Anything it reads — a tool result, an uploaded file, a web page, a skill — can carry instructions. Controls have to hold even when the model obeys those instructions completely, so the tests script the model to obey and check the controls, not the model's judgement.

## When to Use

- A change touches auth, sessions, tenants, members, roles, chats, files, uploads, skills, connectors, network policy, approvals, the adapter or gateway credentials, or how model output is shown
- Before a feature that crosses a trust boundary reaches review
- When asked whether a feature is safe against another tenant, another member, a removed member, a hostile model or a hostile connector

**NOT for:**
- Edge cases and failure modes that cross no trust boundary (crashes, retries, races between the owner's own requests).
- A whole-codebase audit or a pen-test report with every attack class.
- Generic secure-coding guidance with no change to attack.
- Deployed endpoints, real accounts or real provider and connector credentials: everything here runs against local fixtures.
- The old stack (`agent-core/`, `platform/`): stop and ask.

## Truex New Stack

```text
frontend (3000, tenant chat in app/t/[tenantId])
   → platform-next (4100, NestJS + MongoDB: auth, tenants, agents, chats)
   → runtime-adapter (4400, one pinned Codex app-server per chat)
   → codex app-server (vendor/codex, never modified)
   → model-gateway (4200, Responses ↔ provider APIs)
```

Each package is independent (own `node_modules`, scripts, tests; no npm workspaces). Root `npm test` and `npm run build` skip runtime-adapter and platform-next, so they are not evidence for the new stack.

| # | Boundary | The attacker | Reference |
|---|---|---|---|
| B1 | Browser → frontend forwarders | Anyone on the internet; a forged header or path | [boundaries.md](references/boundaries.md) |
| B2 | Frontend → platform-next: tokens, sessions, tenant | A stolen or old token; a removed, downgraded or logged-out member | [boundaries.md](references/boundaries.md) |
| B3 | Member ↔ member, tenant ↔ tenant | Another member of the same tenant; a member of another tenant | [boundaries.md](references/boundaries.md) |
| B4 | platform-next → runtime-adapter | A caller with the wrong token, IDs or another chat's run | [boundaries.md](references/boundaries.md) |
| B5 | Codex → model-gateway | A gateway token used for another profile; a disabled profile | [boundaries.md](references/boundaries.md) |
| B6 | Codex → MCP connectors and network egress | A hostile connector; the model aiming requests at private hosts | [boundaries.md](references/boundaries.md) |
| B7 | Coding sandbox, workspace files, uploads, skills | A command, path, archive or file built to escape | [boundaries.md](references/boundaries.md) |
| B8 | Model and tool output → model and UI | Injected instructions; markdown, HTML and links built to leak or run | [prompt-injection.md](references/prompt-injection.md) |

Known findings and accepted risks live in `docs/SECURITY_AUDIT_2026-10-23.md` (F-1 to F-9, needs-validation N-1 to N-5, verified controls in §5) and `backlog/security/`. Read them before Step 2 so a known issue is reported as known, not new.

## Process

### Step 1: Scope

1. Name the change: a task from `tasks/<feature>-todo.md`, a diff (`git diff main...HEAD` plus uncommitted files), or files the user names.
2. List every entry point the change adds or alters: HTTP route, SSE stream, adapter request field, event mapper, Codex config written per run, UI component that renders model or file content, operator CLI.
3. Mark which boundaries (B1–B8) each entry point crosses. A change that crosses none: say so and stop.
4. Read the intent sources (idea, plan, todo, the adapter contract in `runtime-adapter/README.md`) and the earlier findings. Do not read the implementation yet.

### Step 2: Threat model and security rules first

For each boundary crossed, write the attackers (from the table above), the assets they want (another tenant's chats, files or connector tokens; provider keys; the model budget; the runtime host; a member's approval), and then 5–15 rules:

```text
MUST NEVER  a member reads, streams, answers or changes another member's chat, run, file or upload
MUST NEVER  another chat's or another tenant's resource looks different from a missing one
MUST NEVER  a connector token or provider key appears in a response, event, log line or file
MUST NEVER  a write tool runs without the owner's approval, however the model was instructed
MUST ALWAYS a removed member or revoked session is refused at the next check named in the contract
```

Mark rules the sources do not state as `(inferred)`. Map each rule to a STRIDE letter (Spoofing, Tampering, Repudiation, Information disclosure, Denial of service, Elevation of privilege) so no category is skipped by accident.

### Step 3: Map the controls

Now read the implementation. For each rule, record:

- **Control:** the check that enforces it (`file:line`) — guard, `ownerId` filter, token verify, ID pattern, path check, sandbox rule, CSP, sanitiser.
- **Where it can be skipped:** every other path to the same data — a second route, the SSE stream, the history or snapshot read, the operator CLI, the adapter called directly, a cached value.
- **Existing test:** by name, from the tables in [boundaries.md](references/boundaries.md), or "none".

A rule with no control is a finding candidate. A control on one path but not another is the most common real bug.

### Step 4: Attack in a fresh context

Start a sub-agent that did not write the code. Give it only: the rules, the list of changed files, and the three reference files. Ask it for concrete attacks — the exact request, token, header, ID, file, archive, model output or connector response — each with the code path (`file:line`) that lets it through. Tell it not to edit files and not to contact anything outside localhost.

If no sub-agent is available, do the attack yourself and label it **self-attack (weaker)** in the report. Discard any attack that cannot name a code path.

### Step 5: Rank and propose, then stop

Rate each candidate with the severity anchors in [report-template.md](references/report-template.md), using the real preconditions (who must the attacker already be, what must they already hold). Take every Critical, High and Medium; list Low and Informational as accepted with a reason unless the user asks for them. Mark anything matching an earlier finding as `known (F-n)` and do not re-rate it.

Present the threat model, rules and ranked list with one proposed abuse test each, in the format in [report-template.md](references/report-template.md). **Stop and wait for the user to approve, cut or add.** Write nothing before that.

### Step 6: Write the approved abuse tests

Use the patterns in [boundaries.md](references/boundaries.md) and [prompt-injection.md](references/prompt-injection.md), in the package and support code where neighbouring tests live. Every abuse test asserts all that apply:

1. **Refused exactly:** status and error code (`404 NOT_FOUND`, `401 UNAUTHORIZED`, `RUN_NOT_FOUND`), never only "not 200".
2. **Indistinguishable:** the foreign resource gets the same answer as a missing one (same status, code and body shape).
3. **No side effect:** the stored documents, the adapter's received requests and the event stream are unchanged after the attempt.
4. **No leak:** a unique marker planted as the secret appears in no response, event, log line, stored plaintext or file (see the marker sweep in [boundaries.md](references/boundaries.md)).

Hostile model behaviour comes from the scripted model fixture, hostile connectors from the MCP and connector fixtures, hostile hosts from the network fixture. Never real credentials, never an external host.

Run each new test. **Fails** → check the test against the rule; if the test is right, it is a **confirmed finding**: record the failing output, leave the test in place named for the finding, and do not fix it unless the user says so. **Passes** → Step 7 proves it would notice the control disappearing.

### Step 7: Prove the controls bite (hand mutation)

For each control the tests rely on, remove or weaken it once and run the tests that should catch it: drop the `ownerId` filter, skip the guard, compare the token with `===` before length, accept any profile ID, let `..` through the path check, widen the egress host check, render raw HTML.

```bash
cp <file> /tmp/secure-orig-<name>      # 1. copy first
# 2. apply ONE weakening with an edit
npx tsx --test --test-name-pattern='<pattern>' test/<...>.test.ts   # 3. run the tests that should catch it
cp /tmp/secure-orig-<name> <file>      # 4. restore from the copy
cmp /tmp/secure-orig-<name> <file>     # 5. must print nothing
```

Never restore with `git checkout`, `git restore` or `git stash`: the working tree usually holds the user's uncommitted work. After the last mutation, `git diff --stat` must show only the intended test files. A weakening no test catches is a **survivor**: strengthen the test or record it as accepted with the reason.

### Step 8: Flake check

Run every new test that involves a stream, a child process, revocation timing or concurrent principals **5 times in a row**. A single failure is a flaky test: fix its synchronisation (wait for the event, the request count or the stored change), never with a delay or a retry.

### Step 9: Full checks and report

In each package touched: `npm run typecheck`, `npm test`, and the format check (`npm run format:check` in runtime-adapter and platform-next; `npx prettier --check <changed files>` from the repo root for model-gateway and frontend; root `npm run format:check` already fails on files unrelated to any change). Write the report in the [report-template.md](references/report-template.md) format with the counts each command printed. Describe a confirmed finding by its test and code path; do not add an exploit beyond what the test does. Do not commit.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "The guard is on the route, so it's covered" | The same data is usually reachable through the stream, history, snapshot, files or the adapter. Test every path. |
| "Another member can't guess the ID" | IDs leak through logs, links, screenshots and shared agents. Isolation must hold for a known ID. |
| "A 403 for foreign and 404 for missing is clearer" | It tells the attacker which IDs exist. Foreign and missing must look the same. |
| "The model would refuse that instruction" | Some model, some day, won't. Script it to obey and check that the control still holds. |
| "It's internal, behind the platform" | The adapter and gateway are separate trust boundaries with their own credentials. Call them directly in the test. |
| "No secret showed up in the response" | Check events, logs, stored plaintext and files too, with a marker you can grep for. |
| "The token check passed, so revocation works" | Access tokens live 5 minutes by design (F-2). Test what the contract says is checked fresh, and report the rest as known. |
| "I'll fix it now, it's one line" | Report it with the failing test. The fix is a separate, approved change. |

## Red Flags

- Abuse tests written before the user approved the list
- Rules written after reading the implementation, or none written
- An assertion of "not 200" instead of the exact status and error code
- A foreign resource answered differently from a missing one, and the test accepting it
- A leak check that looks only at the HTTP response
- The module under test mocked, or the attacker faked by stubbing the guard instead of sending the request
- A real token, real provider key, deployed URL or external host anywhere in a test
- `test.skip`, `test.only` or a finding's test disabled to get green
- A fixed `sleep` used to wait for revocation or an event
- `git checkout`, `git restore` or `git stash` used during mutation; a weakening left in a source file
- A known finding (F-n) reported as new, or re-rated without new evidence
- A file in `agent-core/`, `platform/` or `vendor/codex/` changed

## Verification

- [ ] Every boundary the change crosses is named, with its attackers and assets
- [ ] Security rules were written from intent sources before the implementation was read, each with a STRIDE letter
- [ ] Every rule maps to a control (`file:line`), every other path to the same data, and a test or proposal
- [ ] Earlier findings were read; known ones are marked `known (F-n)`
- [ ] The attack ran in a fresh context, or the report says it was a self-attack
- [ ] The user approved the abuse tests before any was written
- [ ] Every abuse test asserts the exact refusal and, where they apply, indistinguishability, no side effect and no leak
- [ ] Every confirmed finding has its failing test output in the report
- [ ] Every control was weakened once; each was caught or recorded as accepted, and every file was restored and checked with `cmp`
- [ ] Stream, process and timing tests passed 5 runs in a row
- [ ] `typecheck`, `npm test` and the format check passed in every touched package, with counts reported
- [ ] Only local fixtures were used; nothing committed; no old-stack or `vendor/codex` files changed
