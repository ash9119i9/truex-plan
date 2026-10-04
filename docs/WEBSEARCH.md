# SearXNG WebSearch

WebSearch is the first implemented slice of the [web tools plan](WEB_TOOLS_IMPLEMENTATION_PLAN.md). It searches public sources through a private SearXNG instance and returns ranked URLs, titles, snippets, engine provenance and search time. It does not read full pages or crawl sites. Discovery IDs are deterministic URL identifiers, not stored-page handles.

## Run locally

The standalone Docker stack is intended for agent-core running on the host. Docker must be running. It publishes only the authenticated search API on `127.0.0.1:4400`; SearXNG has no host port.

1. Copy `deploy/websearch.env.example` to `deploy/websearch.env`. Generate two different values with `openssl rand -hex 32` and set `SEARXNG_SECRET` and `WEB_SERVICE_TOKEN`. The env file is ignored by Git and excluded from the Docker build context.
2. Start the services from the repository root:

   ```sh
   docker compose --env-file deploy/websearch.env -f deploy/websearch.compose.yaml up -d --build
   npm run websearch:smoke
   ```

3. Set these in `agent-core/.env`, using the same `WEB_SERVICE_TOKEN` as the Docker stack:

   ```dotenv
   WEB_SEARCH=on
   WEB_SERVICE_URL=http://127.0.0.1:4400
   WEB_SERVICE_TOKEN=<your generated token>
   WEB_SEARCH_TIMEOUT_MS=20000
   ```

4. Restart agent-core and start a **new conversation**. First ask a question that needs current facts without explicitly asking for search, for example “Who is the CM of Tamilnadu ?”. Verify `webSearchAvailable: true` from `/api/sessions/:id/documents`, a completed `webSearch` step in `/api/sessions/:id/traces`, and source links in the reply. Then ask an explicit search question. A service smoke alone does not prove that the configured model selects the tool.

To run the TypeScript API on the host instead, configure `web-service/.env` from its example, point `SEARXNG_URL` at your trusted instance and set the matching service token. `npm run dev` starts it when that env file exists. Do not create `web-service/.env` while the Docker stack is occupying the same API port.

The full containerized platform would need explicit agent-core network attachment and a container-reachable API URL; the standalone stack does not automatically configure the existing deployment. Kubernetes integration is outside this Search-only development slice.

## Policy and behavior

- Feature-off is the default. `WEB_SEARCH=on` requires a valid service URL and a 32–256-character URL-safe service token; invalid enabled configuration fails startup.
- `truex_models.webSearch` absent/`live` allows native live search. `disabled` blocks it. `cached` preserves hosted cached behavior and does not enable live SearXNG searches. Non-Responses gateway providers still cannot use hosted search, including cached hosted search.
- Native search disables the provider-hosted search path in registered conversations. Previously registered native threads can be disabled/re-enabled by model policy; older/unregistered threads cannot acquire a new tool on resume. Switching an existing native thread to cached disables live calls; start a new conversation to use hosted cached search. New registration requires a new conversation. Forks preserve registration and policy.
- The harness supplies fresh UTC time through the pinned runtime’s external `currentTime/read` reminder at user/tool boundaries. This works with host environment context disabled and is enforced on start and resume. Research instructions require live verification of mutable public facts (including officeholders even without “latest”), explicit search requests, and evidence links. Failed or inconclusive verification must be disclosed; stable questions can be answered directly.
- Main conversations execute this tool. Helper calls remain denied in this release; helpers can return search requests to the main agent.
- `query` is required (1–1000 characters). Optional fields are `limit` (default 10, max 20), `language`, `timeRange` (`day`, `month`, `year`) and up to five hostname filters in `domains`. Unknown fields and invalid values are rejected by both adapter and API.
- Domain filtering applies to the first result page and includes subdomains. Fewer matches and incomplete engine responses are disclosed. Search failures and empty results remain distinct; snippets do not prove full-page reading.
- Results are deduplicated and bounded. Unsafe schemes, embedded credentials, obvious local/private IP links and oversized normalized URLs are omitted. The service never fetches the returned pages or resolves their DNS; these checks validate citation links, not a future page-fetch SSRF boundary.
- The native tool's default deadline is 20 seconds; the upstream search deadline is 15 seconds. Turn interruption, deletion, policy opt-out, runtime shutdown and browser/API client disconnect cancel outstanding work. The API admits at most four simultaneous searches per process by default and responds with a typed busy error beyond that.
- No cross-session cache, corpus persistence or third-party LLM extraction is introduced. Queries and credentials are excluded from routine service logs; search queries/results still enter the conversation/model context and the existing trace retention path.
- The pinned SearXNG settings enable JSON and four general engines. Upstream providers can rate-limit or deny requests; partial-engine warnings are expected and are returned to the assistant. `/ready` checks connectivity to `/config`; a real JSON search smoke is the format/engine acceptance check.

## Tests

```sh
npm test
npm --prefix frontend test
npm run build
npm run codex:verify
npm run websearch:smoke
npm run websearch:runtime-smoke
```

The two smoke commands read the ignored `deploy/websearch.env`. The service smoke calls real search engines. The runtime smoke uses the real project-pinned runtime and real search service with a simulated Responses model: no model provider credentials are required, and this does not measure model reasoning or citation judgment. Explicit runtime smoke fails when configuration or the pinned binary is missing; ordinary test runs skip the opt-in live test.

The initial full regression run passed 193 agent-core tests, 144 platform tests, 61 gateway tests, 17 search-service tests and 175 frontend tests (590 total); one opt-in live test was skipped in that run and passed separately against real SearXNG. Follow-up targeted tests cover preservation of cached-only policy, expanded Unicode URLs, readiness coalescing and actual upstream disconnect on cancellation.

The real service and runtime smokes each returned five source records, including official SearXNG documentation. DuckDuckGo/Bing supplied results; Brave rate limits and Google access denial surfaced as partial-engine warnings. The SearXNG image and search API Docker image were built/run locally. Pinned runtime verification, service builds and the final Next.js production build passed. All changed implementation files pass formatting; the repository-wide check reports 57 unrelated failures, each verified as already present on `main`.

### Actual configured model acceptance

On 2026-10-04 (Asia/Kolkata), the running local app was configured with the private Docker stack and restarted. The actual configured `claude-sonnet-5` agent, through the model gateway and pinned harness, completed these uncanned prompts:

| Prompt                                        | Observed activity                        | Result                                                                                   |
| --------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| Who is the CM of Tamilnadu ?                  | One completed native `webSearch`, 960 ms | Answer changed from the earlier training-data answer and cited two returned source URLs. |
| What is the latest stable version of Node.js? | One completed native `webSearch`, 866 ms | Answer cited the official Node.js download URL.                                          |
| What is 17 multiplied by 23?                  | Reply only; no search                    | Answered 391.                                                                            |

The earlier failing conversation reported `webSearchAvailable: false` and a reply-only trace. The service was previously tested in isolation but had not been enabled in the running app. Existing unregistered conversations still require a new conversation. Local credentials remain in ignored env files, and the development search stack is left running. These observations validate tool selection and evidence plumbing for the tested prompts; search snippets alone do not establish full-page verification or guarantee every generated claim.

The actual model’s persisted rollout also confirmed fresh developer reminders at `2026-10-03 22:49:51 UTC` and `22:49:55 UTC`, around its real search call. Both answer links were present in the returned search results. Clock regression coverage separately uses the real pinned binary with a simulated model to inspect timestamps on initial turn, tool output and resume. The full backend regression suite passed after this fix; the affected clock/search checks and TypeScript build passed as well.

Stop the standalone services with:

```sh
docker compose --env-file deploy/websearch.env -f deploy/websearch.compose.yaml down
```

## References

- [SearXNG HTTP search API](https://docs.searxng.org/dev/search_api.html)
- [SearXNG container installation](https://docs.searxng.org/admin/installation-docker.html)

The deployment pins the official multi-architecture SearXNG manifest resolved on 2026-10-04, version `2026.10.2-19ffbcd30`. Change its digest deliberately and rerun real JSON-search acceptance on upgrades.
