# Matched send acceptance over localhost HTTP

The frozen existing implementation was measured first, then the final working implementation with the same synthetic inputs, Node v24.21.0, five measured repetitions and one warmup per scenario. Source hashes of the baseline match `send-fix-before-manifest.json`; final hashes match the working files. The checks in `send-fix-http-compare.mjs` passed.

| Scenario                                                          | Before median | After median |       Difference |
| ----------------------------------------------------------------- | ------------: | -----------: | ---------------: |
| New conversation: create + first message, no injected Mongo delay |      72.95 ms |     73.43 ms |   0.48 ms slower |
| Existing conversation followup, no injected Mongo delay           |      50.11 ms |     52.75 ms |   2.64 ms slower |
| Existing followup with 1,000 synthetic messages                   |      50.68 ms |     44.71 ms |   5.97 ms faster |
| New conversation: create + first message, 225 ms per Mongo await  |   3,035.77 ms |  2,125.14 ms | 910.64 ms faster |
| Existing followup, 225 ms per Mongo await                         |   1,644.34 ms |  1,186.50 ms | 457.84 ms faster |

All durations end when the acceptance response body has been read. New conversation totals include two sequential HTTP requests: create, then message. Existing followups start after an earlier message was accepted and completed. Each measured send asserted a durable accepted Mongo receipt matching its returned turn and a running manager turn before synthetic completion.

The benchmark uses the actual `PlatformService`, `Store`, Mongo driver, isolated `MongoMemoryServer`, `RuntimeTransport`, and `ThreadManager`. It mounts the exact production create/message and create/resume/turns route statements in Express, transpiling their TypeScript outside measurement. The actual development user/tenant resolvers and middleware use a synthetic owner; authorization remains in the actual service. The tenant cache is refreshed before each measurement so its five second TTL does not expire at different iterations as request duration changes. Runtime HTTP boundaries have the same fixed 20 ms delay in both variants. Runtime RPC responses are fake and make no provider calls.

The 225 ms Mongo delay is injected before real collection awaits only during measurement. It characterizes how serial database gates accumulate; it is not a measured production request latency or a claim that every remote Mongo command takes 225 ms. The matched samples have identical Mongo command counts and runtime request paths. The change overlaps independent reads rather than removing them. The extra configuration on new-chat creation explains why that flow saves approximately twice the followup time in this scenario. On fast local Mongo without the injected delay, the small samples do not show an acceptance improvement for ordinary empty-history chats.

For the 1,000-message synthetic transcript, each completed message contains 2,048 characters. Actual serialized runtime `/resume` HTTP response bodies fell from **2,146,149–2,146,152 bytes** to **482–483 bytes**, while the retained transcript stayed in the manager. The measured send opts into `response: "operational"`; ordinary full resume remains the default. The residual operational response includes bounded timings and traces, so it is larger than an empty-thread operational response.

The actual after message route emits `Server-Timing`. All 25 measured responses contained finite, nonnegative phase values; their rounded header values match the response JSON and authorization + preparation + dispatch + receipt equals total. Before responses had no message `Server-Timing` header. See the raw samples for the phase values and response sizes.

This is a service/runtime HTTP integration benchmark, not full production end-to-end verification. It excludes production bootstrap, OIDC/cookie authentication, browser rendering, the frontend proxy, SSE delivery, real model output, remote Mongo, and production CPU contention. First answer latency is not measured. Five samples make p95 the largest observed sample; the raw JSON preserves all values. Existing authorization, approval, duplicate and failure regression suites provide separate safety evidence.

Reproduce from the repository root, running before and after sequentially:

```sh
node --import ./platform/node_modules/tsx/dist/loader.mjs docs/performance/t3-chat/send-fix-http-probe.mjs /tmp/truex-send-fix-before-20261006 > docs/performance/t3-chat/send-fix-http-before.json 2> docs/performance/t3-chat/send-fix-http-before-stderr.txt
node --import ./platform/node_modules/tsx/dist/loader.mjs docs/performance/t3-chat/send-fix-http-probe.mjs /Users/ashok/truex-plan > docs/performance/t3-chat/send-fix-http-after.json 2> docs/performance/t3-chat/send-fix-http-after-stderr.txt
node docs/performance/t3-chat/send-fix-http-compare.mjs > docs/performance/t3-chat/send-fix-http-checks.txt
```

Both successful probe runs exited zero, with empty stderr files. They used disposable localhost servers and a disposable Mongo process, closed all owned resources, and did not read production `.env`, use user data, stop existing processes, or edit production code.
