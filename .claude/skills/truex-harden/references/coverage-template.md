# Coverage Template

Two documents: the **proposal** (Step 5, shown to the user before any test is written) and the **report** (Step 9). Scale both to the change: a small mapper fix may need five rows; a lifecycle change may need thirty. Leave out sections that would be empty rather than writing "none" under each.

Show both in the reply. Save to `tasks/<feature>-coverage.md` only if the user asks.

The rows, caps, line numbers and test names below are illustrations of the format, not facts about the code. Fill every value from the change at hand.

## Proposal (Step 5)

```markdown
# Harden: <feature or task>

Scope: <task / diff>, packages: <runtime-adapter, platform-next, ...>
Attack: fresh-context sub-agent | self-attack (weaker)

## Invariants
1. MUST ALWAYS every run stream ends with exactly one run.completed
2. MUST NEVER  a malformed update_plan call fails the turn
3. MUST NEVER  plan.updated exceeds 50 steps (inferred, please confirm)

## Proposed tests (ranked)
| # | Risk | Invariant | P×I×D | Test kind, file, support | Already covered? |
|---|---|---|---|---|---|
| R1 | update_plan with `plan: null` crashes the event mapper | 2 | 3×3×2=18 | unit, runtime-adapter/test/unit/unit.test.ts | no |
| R2 | stop while update_plan is in flight leaves a second plan.updated after run.completed | 1 | 2×3×3=18 | real Codex, test/codex/plan.test.ts, `hangAfterCreated` + stop | no |
| R3 | 5,000-character step text is stored unbounded | 3 | 2×2×3=12 | unit + seeded loop | partly: "two update_plan calls..." covers 2 steps only |

## Accepted without a test
| Risk | Why |
|---|---|
| Step text with RTL markers renders reversed | Rendering only; checked in the browser, not here |

## Fixture changes needed
- ModelFixture: add `rawCall` kind (invalid JSON arguments) for R4

## Open questions
- Contract does not say what a plan step with an unknown status becomes. Drop it, or map to `pending`?

Approve, cut (e.g. "skip R3") or add, and I will write the approved tests.
```

## Report (Step 9)

```markdown
# Harden report: <feature or task>

## Result
<one or two sentences: how many risks tested, findings, survivors, release recommendation>

## Confirmed findings
### F1 (High): <title>
- Invariant broken: 2
- Test: runtime-adapter/test/unit/unit.test.ts "an update_plan call with plan null is dropped, and the turn completes"
- Expected / actual: <exact values>
- Failing output: <the assertion message the command printed>
- Code path: runtime-adapter/src/codex/activity.ts:<line>
- Status: not fixed (awaiting approval); the test is in place as the regression test

## Coverage
| Risk | Result | Test |
|---|---|---|
| R1 | finding F1 | unit.test.ts "..." |
| R2 | holds | plan.test.ts "..." |
| R3 | accepted by user | — |

## Mutation check
| File:line | Mutation | Result |
|---|---|---|
| src/codex/activity.ts:<line> | `>` → `>=` on the step cap | killed by "plan over the cap is cut to 50 steps" |
| src/runtime/run.ts:<line> | drop the `ended` guard before emitting | survived → added "no event after run.completed"; now killed |
| src/codex/activity.ts:<line> | `String(x)` → `x` | equivalent (input already a string), accepted |

All mutated files restored from copies; `cmp` clean; `git diff --stat` shows only test files.

## Flake check
<test name>: 5/5 passed

## Checks
- runtime-adapter: typecheck ok; npm test <pass>/<total>; format:check ok
- platform-next: ...

## Not covered
- Suspected security issue for a security review: <one line, or omit>
- Real-model behaviour not measured (not requested)
- <anything accepted, out of scope or blocked, with the reason>
```

## Severity

| Severity | Meaning in this stack |
|---|---|
| Critical | Data loss or corruption in stored chats, cross-tenant exposure, a side effect executed twice |
| High | A run that never ends or never sends `run.completed`, a turn failed by bad model output, duplicated or lost messages, an unbounded resource |
| Medium | A wrong error code, a wrong partial-text outcome, a degraded but recoverable path |
| Low | Cosmetic or diagnostic: an unclear log field, an over-long message |

Report findings in severity order. A finding without a failing test or a traced code path is listed as **likely** or **unverified**, never as confirmed.
