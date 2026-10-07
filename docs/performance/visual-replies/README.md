# Local visual reply verification — 2026-10-07

Measurements use a shared Apple M5 development machine, local files, Docker
Desktop Linux ARM64 and deterministic provider/UI fixtures. These are observations,
not production capacity or reliability guarantees. Raw samples and scope are in
adjacent JSON files.

| Measurement                                          | Result                                  |
| ---------------------------------------------------- | --------------------------------------- |
| 170 KB complete-document publication, 40 samples     | 4.90 ms median; 14.24 ms p95            |
| Cached attachment snapshot, 100 samples              | 0.007 ms median; 0.022 ms p95           |
| 40-source cold recovery                              | 16.11 ms; 6,051-byte public snapshot    |
| Shared preparation, 180 KB text, 30 samples          | 2.81 ms median; 5.50 ms p95             |
| Real Chromium preview, simple 390 px visual          | 1,588 ms; 3,351-byte PNG                |
| Five CPU-heavy previews, bounded queue               | 15,866 ms total; sixth rejected         |
| Sampled heavy preview resource use                   | 205.5 MiB of 512 MiB; 98.83% of one CPU |
| Independent watchdog after Docker client loss        | 19.91 seconds; no owned container left  |
| Normal-chat warm switch p95, 30 before/after samples | 21.1 ms → 18.3 ms                       |
| Initial normal-chat encoded JS bytes                 | 358,645 → 358,256                       |

The warm-switch samples show no observed regression in this fixture; sequential,
nonrandomized samples on a busy host do not establish a statistically significant
speedup. The approximately 54 KB encoded parser/viewer chunk loads only when a
visual is displayed. Baseline was the original repository HEAD, built in an
isolated archive; Next builds use the same installed dependency versions.

## Reproduce

```sh
# File publication and cold/hot recovery
agent-core/node_modules/.bin/tsx agent-core/bench/visual-publication.ts
# Pure source preparation (Node supports type stripping)
node --experimental-strip-types docs/performance/visual-replies/shared-preparation.mjs \
  --output /tmp/shared-preparation.json
# Build isolated browser, then exercise real jobs
docker build -t truex-html-preview:local html-preview-worker
HTML_PREVIEW_DOCKER_TEST=1 agent-core/node_modules/.bin/tsx \
  --test agent-core/test/html-preview-docker.test.ts
# Synthetic UI API; uses no production data or model
VISUAL_REPLIES_FIXTURE_PORT=4511 platform/node_modules/.bin/tsx \
  docs/performance/t3-chat/next-chat-browser-fixture.mjs
# In another terminal, build and run the real production frontend
NEXT_PUBLIC_PLATFORM_URL=http://localhost:4511 npm --prefix frontend run build
NEXT_PUBLIC_PLATFORM_URL=http://localhost:4511 npm --prefix frontend run start -- --port 4510
```

Use the T3 collaborative browser at `http://localhost:4510/?session=fixture-a`.
Run the browser-only `chat-switch-browser.js` expression before configuring the
visual, and poll `window.__switch` after completion. Build original HEAD into a
separate directory/port with the same fixture to obtain the comparison. The timer
measures click to rendered reply 39, excluding sidebar reopening wait.

Then run `node docs/performance/visual-replies/configure-ui-fixture.mjs`, reload,
and check a single visual before the final prose. Native Tab/Enter controls
increase the team from 5 to 6 and propose a question. Only **Add to my message**
changes the composer; no `/turns` POST occurs. Light/dark changes preserve the
iframe identity and state. At 390 px the fixture has no horizontal overflow.
Expand/Escape preserve state; reopening restores it. Token parity is additionally
covered in the frontend test suite.

`ui-verification.json` records the browser observations. Native T3 snapshot calls
failed on the attached preview host, so pixel screenshot comparison is not
claimed. Live provider screenshot acceptance, private TLS deployment, production
host limits, sustained production load and arbitrary model-generated layout
quality remain outside these measurements.

## Quality gate record

[verification.json](verification.json) records full and targeted check outcomes.
The full test run passed; the five opt-in Docker cases passed separately. The
repository-wide format check has 55 pre-existing warnings, each verified against
original HEAD in [format-baseline.json](format-baseline.json); feature checks pass.
The full AgentCore release image requires its pre-existing exported Codex artifact,
missing from this checkout. Service image builds and shared-parser smoke checks
passed. No release, push or deployment was performed.
