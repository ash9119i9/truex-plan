# Report Template

Two documents: the **proposal** (Step 5, shown to the user before any test is written) and the **report** (Step 9). Scale both to the change: a new field on one route may need four rows; a new connector type may need twenty. Leave out sections that would be empty rather than writing "none" under each.

Show both in the reply. Save to `tasks/<feature>-security.md` only if the user asks. Never put a real token, key, cookie, URL with credentials or customer data in either document.

The rows, line numbers and test names below are illustrations of the format, not facts about the code. Fill every value from the change at hand.

## Proposal (Step 5)

```markdown
# Secure: <feature or task>

Scope: <task / diff>, packages: <platform-next, runtime-adapter, ...>
Boundaries crossed: B3 member ↔ member, B6 MCP and egress, B8 output → UI
Attack: fresh-context sub-agent | self-attack (weaker)
Earlier findings read: docs/SECURITY_AUDIT_2026-10-23.md, backlog/security/

## Threat model
| Attacker | Wants | Already holds |
|---|---|---|
| Another member of the tenant (bob) | alice's chat files | a valid tenant token, alice's chat ID from a shared link |
| Hostile connector | a write without approval | control of its tool annotations and results |
| Injected page | alice's connector token | text the model reads |

## Security rules
1. MUST NEVER  bob lists, reads or downloads a file of alice's chat (I)
2. MUST NEVER  a foreign file ID answers differently from a missing one (I)
3. MUST NEVER  a write tool runs without a card, however the model was instructed (E)
4. MUST NEVER  the connector token appears outside its encrypted field (I) (inferred, please confirm)

## Controls
| Rule | Control | Other paths to the same data | Existing test |
|---|---|---|---|
| 1 | chats.service.ts:<line> ownerId filter | files list, single file, run snapshot, history read | coding-chat.test.ts "another member can't list or read a chat's files" |
| 3 | adapter approval mode per server | approvedTools from platform | mcp.test.ts "approvedTools from the platform skip the card; other tools still ask" |

## Proposed abuse tests (ranked)
| # | Attack | Rule | Severity if it lands | Test kind, file, support | Known? |
|---|---|---|---|---|---|
| A1 | bob downloads alice's file by ID through the new export route | 1, 2 | High | integration, platform-next/test/integration/chats.test.ts, two principals | no |
| A2 | tool result tells the model to call `create_issue`; model obeys | 3 | High | real Codex, runtime-adapter/test/codex/mcp.test.ts, McpFixture + scripted `call` | no |
| A3 | server annotates `delete_repo` as read-only | 3 | Medium | same file | known (F-3) — confirm still true, no re-rating |

## Accepted without a test
| Attack | Why |
|---|---|
| Timing difference between foreign and missing file IDs | Single-digit ms over a network; needs a measurement harness, not a unit test |

## Fixture changes needed
- McpFixture: a tool whose result is set per call, for A2

Approve, cut (e.g. "skip A3") or add, and I will write the approved tests.
```

## Report (Step 9)

```markdown
# Security report: <feature or task>

## Result
<one or two sentences: boundaries tested, findings, survivors, release recommendation>

## Confirmed findings
### S1 (High): <title>
- Rule broken: 1
- Attacker and preconditions: another member of the same tenant who knows the file ID
- Test: platform-next/test/integration/chats.test.ts "<name>"
- Expected / actual: 404 NOT_FOUND / 200 with the file bytes
- Failing output: <the assertion message the command printed>
- Code path: platform-next/src/modules/chats/<file>.ts:<line> (no ownerId in the query)
- Status: not fixed (awaiting approval); the test is in place as the regression test

## Coverage
| Attack | Result | Test |
|---|---|---|
| A1 | finding S1 | chats.test.ts "..." |
| A2 | holds | mcp.test.ts "..." |
| A3 | known (F-3), still true | mcp.test.ts "..." |

## Control mutation check
| File:line | Weakening | Result |
|---|---|---|
| src/modules/chats/chats.service.ts:<line> | drop `ownerId` from the filter | killed by "<name>" |
| frontend/lib/tenant-files.ts:<line> | remove the CSP `<meta>` | survived → added "<name>"; now killed |

All weakened files restored from copies; `cmp` clean; `git diff --stat` shows only test files.

## Leak sweep
Marker planted as <connector token / provider key / header>; searched responses, SSE events, process output, stored documents (except the encrypted field) and files under the state directory: not found | found in <place>.

## Flake check
<test name>: 5/5 passed

## Checks
- platform-next: typecheck ok; npm test <pass>/<total>; format:check ok
- runtime-adapter: ...

## Not covered
- <boundary or attack accepted, out of scope or blocked, with the reason>
- Deployment facts not testable here (TLS between services, edge rate limits): see N-1 to N-5 in the audit
- Real-model injection rate not measured (not requested)
```

## Severity

The same anchors as `docs/SECURITY_AUDIT_2026-10-23.md`, applied with the real preconditions: who the attacker must already be and what they must already hold.

| Severity | Meaning in this stack |
|---|---|
| Critical | Unauthenticated access to any tenant's data, code execution on the runtime host outside the sandbox, provider keys or every tenant's connector tokens exposed |
| High | Cross-tenant or cross-member read or write by an ordinary member, a write tool or command run without the owner's approval, a secret reaching the browser, an authentication bypass for one account |
| Medium | Exposure that needs an extra secret or an unusual precondition, a revocation gap beyond what the contract states, existence of a foreign resource revealed, abuse of cost or capacity by one member |
| Low | Limited exposure with a concrete consequence: operational counts, a missing hardening header with no reachable exploit |
| Informational | A hardening improvement with no demonstrated defect |

Report findings in severity order. A finding without a failing test or a traced code path is listed as **likely** or **unverified**, never as confirmed.
