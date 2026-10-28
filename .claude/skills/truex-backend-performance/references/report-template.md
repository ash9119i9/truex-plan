# Report template

Use for audits and reviews. Keep it as short as the findings allow.

```markdown
# Performance Audit - <service> (<date>)

## 1. Summary
2-5 lines: biggest risks, ranked, and the one change to do first.

## 2. Method
- Harness: <file / command to reproduce>
- Dataset: <sizes, largest tenant shape>
- Environment: runtime, DB, driver/SDK versions, hardware, local vs prod-like
- Note: local milliseconds are relative; "at scale" figures are labelled arithmetic

## 3. Measurements
Tables: endpoint/job | p50 | p95 | p99 | DB calls | keys/docs examined | bytes

## 4. Findings
### P-1 - <plain-language title of the effect, e.g. "Sweep scales with tenants, not activity">
- Severity: Critical | High | Medium | Low  (probability x impact x detection difficulty)
- Evidence: <measured numbers, plan output, file:line>
- At scale: <labelled arithmetic>
- Fix: <smallest change>
- Cost of fix: <write amplification, staleness, complexity, memory>
- Guard: <test / metric / alert>

## 5. Attempts ledger
| Idea | Baseline -> result | Verdict | Why |
|---|---|---|---|
| <idea> | <numbers> | keep / reverted / rejected | <reason> |

## 6. Already efficient
Things checked and found fine, so nobody re-audits them.

## 7. Observability gaps
What we could not see, and the metric that would show it.

## 8. Limitations
What was not measured and why.
```
