# Automations frontend verification

Verified 9 October 2026 (browser record: `2026-10-08T22:05:20.988Z`). The UI uses the existing Truex shell, graphite/blue tokens, keyed identity remounts and same-origin authenticated API forwarding. No automation content is saved in browser storage.

## Checks and evidence

- `npm --prefix frontend test`: **374 passed, 0 failed**, including twelve new automation helper/dispatch/run-detail tests. RED → GREEN covered recipe validation, whole-second cadence, unknown-execution fences, versioned PUT, stable Run now identity after receipt loss, delayed receipt after navigation, unread historical attention, filters/export and stale identity responses. Follow-up regression tests cover cancellation for failed or unknown outcomes whose execution remains fenced, and preservation of action errors during successful and failed background polling until a new action or explicit Refresh.
- `npm --prefix frontend run typecheck`: **passed**.
- `npm --prefix frontend run build`: **passed** on Next.js 16.3.5.
- Focused Prettier checks for the changed frontend/shared-contract files: **passed**.
- `node frontend/test/automations.browser.rig.mjs`: **passed** with Playwright Core 1.64.0 and Google Chrome 154.0.8037.98 in headless mode.

The browser connected to the isolated frontend at `http://127.0.0.1:58376`, backed by actual MongoDB, native Temporal Schedules, a Workflow worker and Activities. The runtime supplied a predetermined synthetic result and performed no connector/business actions. This is actual browser/API/workflow/storage integration evidence, not a configured external-agent pilot.

Successful browser run: automation `auto_d0b01260-c51d-4fee-84c8-7e0f823dc2bd`; run `run_795137a5-97d7-4b03-b86f-6181db4babb2`. The temporary native Schedule was archived after verification.

| Browser journey | Result |
| --- | --- |
| Create an hourly draft with selected agent and prompt | Draft persisted through the real API |
| Interval and timezone-calendar preview | Five actual Temporal preview instants rendered; DST gap/repeated-time semantics shown |
| Enable reviewed revision | Enable disabled until explicit review and valid preview |
| Run now and run details | Succeeded; exact root result, confirmed runtime stop, complete persisted audit, timing and authorized output shown |
| Filter history | Succeeded-only query returned the expected run |
| Export CSV | Actual browser download; succeeded metadata present, restricted prompt excluded |
| Pause, resume, edit and enable new revision | Current versions accepted; draft edit disabled Run now; interval anchor retained |
| Responsive widths 320, 768, 1024 and 1440 | No document or automation-content overflow after the existing shell transition settled |
| Console/network | Zero automation console/page errors and zero failed API responses |

The browser found and verified a fix for the Outcome selector's ambiguous accessible name. Existing `favicon.ico` returns 404; that unrelated baseline resource warning is recorded separately, rather than hidden or counted as an automation failure. Earlier T3 preview attempts hit intermittent desktop-host errors and an initial isolated-stack origin configuration error; final verification used the corrected stack and the explicitly permitted headless fallback.

Temporary workstation artifacts: [JSON result](/tmp/truex-automation-browser-evidence/result.json), [desktop screenshot](/tmp/truex-automation-browser-evidence/desktop.png), [320px screenshot](/tmp/truex-automation-browser-evidence/mobile.png), [downloaded CSV](/tmp/truex-automation-browser-evidence/history.csv). Screenshot inspection confirmed the existing product visual language and legible stacked mobile layout.

## Repeat the browser check

Use only the isolated synthetic-runtime harness. It writes the frontend address to `/tmp/truex-automation-browser.json`. The browser rig creates and archives native test schedules; it must not point at a real business agent.

```sh
npm install --prefix /tmp/truex-automation-playwright --ignore-scripts --no-audit --no-fund playwright-core@1.64.0
node frontend/test/automations.browser.rig.mjs
```

The rig uses the installed Chrome channel. `PLAYWRIGHT_MODULE_PATH` can select an existing ephemeral installation; `AUTOMATIONS_BROWSER_ARTIFACTS` selects the evidence directory. Browser setup follows the official [Playwright browser guide](https://playwright.dev/docs/browsers) and [launch API](https://playwright.dev/docs/api/class-browsertype).

## Limits

The immediate synthetic runtime completes before a person can exercise the cancellation button. Cancellation, unknown receipts, authorization revocation and failure recovery require the separate platform/runtime tests and controlled fault scenarios. Plan progress and truncated-event warnings render when supplied by the authorized API; this browser fixture did not produce a multi-step plan or more than 1,000 events. The check does not establish production capacity, connector/business correctness, a configured-agent pilot, or production release readiness.
