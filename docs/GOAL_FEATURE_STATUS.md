# Goal Feature Status

Updated 2026-09-28. Rule for all work: `vendor/codex` is read-only. Everything is built around Codex behavior in agent-core, platform and frontend.

## Completed

### UI groundwork
- Light-mode revamp, the old sidebar restored, and a decluttered conversation page. MCP and Capabilities are `/` commands, and connected MCP servers show on the conversation page.

### Phases 1 to 3
- One goal per conversation. The assistant marks it complete; the user accepts it or reopens it with feedback.
- Token count built around Codex (`tokensObserved`), goal bar menu (edit objective, set budget, mark complete), custom budgets, and actions for a stuck goal.
- Goal history saved on the session, with a Goal tab in session activity.

### Items from the Codex-first plan
1. **Pause after this turn.** The goal bar offers it while a turn runs. Codex's pause lets the current turn finish and starts no new one. The bar then shows "Pausing after this turn", with Keep going.
2. **Error reasons that work with any provider.** `runtimeError` in `shared/errors.ts` now adds a `reason` and `httpStatus`, taken only from Codex's error info and HTTP status:

   | Reason | Signals | Shown action |
   |---|---|---|
   | Rate limited | 429 | Resume |
   | Out of credits | `usageLimitExceeded`, 402 | Provider tip |
   | Access denied | `unauthorized`, 401, 403 | Provider tip |
   | Provider unavailable | 5xx, overloaded, connection failures | Resume |
   | Conversation too long | `contextWindowExceeded` | Compact conversation |
   | Other | Anything else | Codex's message, with secrets removed |

   The goal bar shows the reason next to Codex's status, never in place of it. Provider tips are data, keyed by the agent's provider (OpenRouter, Bedrock, OpenAI, Anthropic, Gemini, and a fallback). Raw provider text never reaches the browser.

   Verified from Codex's own logs: an OpenRouter 429 arrives as `responseTooManyFailedAttempts{429}`.
3. **Timeline tied to turns.**
   - agent-core saves goal changes as durable records and skips token-only updates.
   - Platform replays them on ingest. A replayed record never rolls back a newer saved goal: it compares Codex's `updatedAt`, and uses the agent-core event time within the same second.
   - History entries carry `turnId` and Codex's token count. The timeline shows tokens since the last change and a "View turn" link that scrolls to that turn in the chat.
4. **Completion card.** The review panel shows the assistant's closing summary and lists the documents created during the goal, each with a Download link.

### Checks (run 2026-09-28)
- agent-core: 25 tests passing.
- platform: 34 tests passing.
- frontend: 49 tests passing.
- Type checks pass in all three packages, and the frontend production build succeeds.

## Not done or not verified
- **Rate-limit reset time.** Not built. Codex's `account/rateLimits/updated` is not forwarded yet, and the OpenRouter logs showed no reset times at all.
- **Closing summary timing.** The summary is picked by chat order, because chat entries on the client carry no timestamp. This is right in normal use, and copying `Message.at` into the entries would make it exact.
- **Browser click-through.** Not done for the new goal controls, the error reason, View turn or the completion card.
- **Stop during a live streaming turn.** Not verified, because OpenRouter kept returning 429.
- **Phase 4 forks** with Codex's `deferGoalContinuation` are not started.

## Known limitations
- Codex enforces the budget with its own, lower token count.
- agent-core forgets which turns belong to a goal when it restarts. Platform keeps the larger saved total.

## Housekeeping
- Nothing is committed.
- Other sessions have uncommitted work in the same tree (`model-gateway/`, model routing, deploy files and more). It was left alone.
- The test sessions from earlier can be archived.
