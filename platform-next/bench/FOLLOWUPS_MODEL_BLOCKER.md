# Follow Up model probe — blocked upstream (2026-10-25)

Task 1 (probe) and Task 10 (eval) could not produce real-model results: the
three enabled model profiles in the dev catalog all fail before a model
answers. This is an upstream/provider problem, not a harness problem; the same
400 appears in the live dev stack's model-gateway log.

| Profile ID | Slug | Gateway result |
|---|---|---|
| `6ad28658942bdeb193bbd80f` | `claude-sonnet-5-5` | HTTP 400 — upstream: `profileArn is required for this request.` |
| `6adb9041e6bf695274f115dd` | `cc` | HTTP 502 — upstream unreachable |
| `6ad9fc5190e68010a6486e4b` | `openrouter AI` | HTTP 401 — upstream unauthorized |

All three are `anthropic` / `claude-sonnet-5.5`. The check used one fixed
bench prompt through the real gateway (`127.0.0.1:4200`) and the production
`SUGGESTION_RULE`; no model produced a reply, so there are no counts or
scores to save and no keep/exclude decision.

## Reproduce

After fixing the upstream profile/key:

```sh
cd platform-next
FOLLOWUPS_BENCH_TENANT=6ad25557bd7f03d236240be6 \
  npm run bench:followups -- --models 6ad28658942bdeb193bbd80f

FOLLOWUPS_BENCH_TENANT=6ad25557bd7f03d236240be6 \
  npm run bench:followups-eval -- --models 6ad28658942bdeb193bbd80f
```

Repeat with each profile that should stay enabled. Results are written to
`bench/followups-probe-<date>.json` and `bench/followups-eval-<date>.json`
with dates, model IDs, raw replies and counts. Every prompt is a fixed bench
prompt, never member content.

The harness itself is covered end to end against the repository's fake gateway
(`platform-next/test/integration/followups-bench.test.ts`), so a fixed upstream
profile only needs the commands above.

The rest of the plan is verified: tenant indexes are version 6 (`followups_created`
exists), `followups-report --since 30d` runs read-only against the dev
database, and headless-Chrome screenshots confirm rows in both themes, reload
and click in the browser fixture.
