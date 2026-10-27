# Codex upgrade verification — 2026-10-16

## Pin and build

- Previous pin: `4a942885c8b4745757a9f86ad2075e16c42483c5`.
- New pin: `1ef30bcbe784f1006548adc1542985be32b05109`.
- Source: `https://github.com/openai/codex.git`, upstream `main` resolved once during this upgrade; this is not a release-tag selection.
- Upstream commit: `2026-10-15T19:15:04Z`, “Preserve existing SQLite journal modes on startup (#54389)”.
- `vendor/codex` is detached at the new pin, with no tracked source modifications.
- `npm run codex:setup` completed the locked native Cargo build in 3m28s.
- Binary: `vendor/codex/codex-rs/target/debug/codex`, native macOS ARM64; its development version string is `codex-cli 0.0.0`, so identify the build by revision and checksum.
- SHA-256: `a73dfd399e368e94a6c456411467dc4690fe5e868ca40652f43842bd83078a06`.
- Checkout revision, `codex.lock.json`, `.runtime/codex-build.json`, binary checksum, and generated protocol inventory agree.

The previous binary, build manifest, lock, README and generated contracts are preserved under `.runtime/codex-upgrade-tjvlaabn/`. No existing conversation storage was copied into tests, migrated, or opened by the verification fixture. No services were restarted or deployments performed. The Linux ARM64 deployment artifact was not rebuilt.

## Protocol regeneration and compatibility adjustments

`npm run protocol:gen` regenerated TypeScript, JSON schemas, the inventory and generated documentation from the rebuilt binary. Old generated directories were backed up and removed before generation, so removed upstream types do not remain as stale files.

| Inventory       | Previous | New |
| --------------- | -------: | --: |
| Client requests |      152 | 173 |
| Server requests |       11 |  11 |
| Notifications   |       77 |  87 |

Upstream removed `thread/rollback` and `account/rateLimits/read` from the generated request inventory. The corresponding rollback type/schema files were removed. No application source consumer of these method names was found in agent-core, platform, or frontend lib/components. New APIs include attachment, prediction, timeline, turn-settings, gateway OAuth and MCP-event-stream operations; their presence is not an implementation or availability guarantee.

Two small compatibility adjustments accompany the pin:

1. The command-approval integration fixture now emits the current `exec_command` tool with its `cmd` parameter and enables unified execution. The old `shell_command` fixture passed against the preserved old binary and failed against the new binary. Approval denial, final response and durable approval-record assertions remain intact; the updated fixture passes against the new binary.
2. The protocol documentation generator no longer hardcodes that the default backend rejects `thread/items/list`. The direct new-runtime probe successfully called both `thread/items/list` and `thread/read`.

## Direct vendor-runtime verification

The standalone verifier imports Node built-ins and directly launches the pinned Codex binary. It does not import the existing agent-core or platform implementation. The actual Codex process performs JSON-RPC, thread storage, skill loading, MCP connection/tool execution and event streaming. Model responses and two HTTP MCP connectors are local fixtures using synthetic credentials; no paid model or real Notion/GitHub account was used.

Run from the repository root:

```sh
node .runtime/codex-upgrade-tjvlaabn/verify-chat.mjs
```

| Turn | Configuration                        | Model / provider             | MCP execution | Prior turns retained |
| ---- | ------------------------------------ | ---------------------------- | ------------- | -------------------: |
| 1    | General                              | `gpt-5` / `fixture_general`  | None          |                    0 |
| 2    | Notion                               | `gpt-5.1` / `fixture_notion` | `read_page`   |                    1 |
| 3    | GitHub                               | `gpt-5.2` / `fixture_github` | `list_issues` |                    2 |
| 4    | Notion                               | `gpt-5.1` / `fixture_notion` | `read_page`   |                    3 |
| 5    | Notion, unchanged live configuration | `gpt-5.1` / `fixture_notion` | `read_page`   |                    4 |

All five turns completed on the same thread ID. For the first three switches, the verifier stopped Codex and resumed the same thread from the same isolated home with the selected configuration. Turn 5 reused the live process without another resume. It checked the outgoing model/provider credentials, current base instructions, explicit skill-body injection, absence of the other connector's tools, conversation continuity, and streamed text. Models/providers here are configured request identifiers and fake endpoints, not proof of real model access.

During GitHub's turn, the model fixture deliberately attempted the previous Notion tool. Codex returned `unsupported call: mcp__notionread_page`; the Notion MCP endpoint received no call for that turn. GitHub's own tool then executed successfully.

This proves controlled sequential reconfiguration through process restart and same-disk resume. It does not prove an atomic live switch or that an LLM will select the correct agent automatically.

## Important instruction and skill findings

- Base instructions are sent as a developer message in the Responses input at this pin, rather than a top-level `instructions` property. The verifier initially assumed the older layout; captured requests established the new layout and the assertion was corrected.
- A separate probe supplied different `developerInstructions` on cold resume. The next outgoing model request retained the previous developer text and did not contain the new developer marker. Do not assume that replacing this field on resume rewrites existing developer context. The passing switch scenario keeps platform developer instructions fixed and puts the selected agent's instructions in `baseInstructions`.
- Skill paths must match the discovered paths. The initial macOS fixture used `/var/...` while discovery exposed canonical `/private/var/...` paths; using the canonical home path made explicit skill selection and body injection succeed. See `codex-rs/ext/skills/src/selection.rs` for exact-path selection.
- Switching configuration does not erase earlier tool results or previously injected instructions from thread history. The experiment verifies current tool availability and dispatch, not confidentiality between agents sharing a thread.
- Native sub-agent roles still preserve the parent's model provider and MCP configuration. This is explicit in `codex-rs/core/src/agent/role.rs` and `apply_role_cannot_expand_parent_authority` in `role_tests.rs`. They are not an automatic replacement for independently configured application agents.
- Codex supplies thread execution and delegation primitives. Discovering our MongoDB agents, interpreting product tags and choosing previously introduced agents remain application responsibilities.

## Checks and remaining blockers

| Check                                                                 | Result                                                               |
| --------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Locked native Codex build                                             | Pass                                                                 |
| Pin/source/checksum verification                                      | Pass                                                                 |
| Protocol regeneration                                                 | Pass                                                                 |
| Direct same-thread switch, skills, MCP, history and streaming fixture | Pass, 5 turns                                                        |
| Agent-core suite after command fixture update                         | Pass, 216 tests, 0 skipped                                           |
| Model-gateway suite                                                   | Pass, 68 tests, 0 skipped                                            |
| Artifact-verifier test                                                | Pass, 1 test                                                         |
| Agent-core, platform and model-gateway TypeScript builds              | Pass                                                                 |
| Platform suite                                                        | 315 pass, 1 unrelated failure, 0 skipped                             |
| Full application build                                                | Blocked at frontend TypeScript checks                                |
| Changed handwritten script/config/test formatting                     | Pass                                                                 |
| Repository-wide formatting                                            | Fails on 42 existing files outside the upgrade's handwritten changes |
| Tracked root configuration secret check                               | Pass                                                                 |
| Final diff whitespace check                                           | Pass                                                                 |

The platform failure is `provision-demo: dry run changes nothing; refuses populated or foreign databases; is repeatable`, `platform/test/safety.test.ts:635`: it expects `/cannot be the implicit "default"/`, while the unchanged script returns `public signup cannot use the implicit legacy "default" tenant`. It does not exercise Codex.

The frontend build reaches successful compilation, then fails in session/auth tests importing removed exports such as `fetchTenants`, `parseMe` and `switchWorkspace`, along with calls using outdated signatures. Those frontend session/auth changes were present before this task. They were not modified to make the upgrade pass. Next.js's incidental `next-env.d.ts` build rewrite was reverted.

The original aggregate `npm test` run stopped at the outdated command fixture. After its correction, agent-core was rerun successfully; platform and model-gateway were executed independently, with the results above. Do not interpret this upgrade as a green full-repository check or production readiness approval.

## Evidence and rollback

Local evidence is under `.runtime/codex-upgrade-tjvlaabn/`: build and check logs, `pin-check.json`, `protocol-diff.json`, the direct verifier and `chat-verification.json`. Failed diagnostic attempts are retained separately, including the developer-instruction resume probe. All request data uses local fixture content and synthetic credentials.

To roll back the runtime, restore the previous pin, clean vendor checkout revision, preserved binary/build manifest and generated protocol files together. Review/revert only this upgrade's application fixture and generator/doc changes; do not reset unrelated frontend or platform-next work. Existing conversation storage was not migrated by this task. A new pin does not make older deployment artifacts valid: rebuild and verify the Linux ARM64 artifact separately before deploying it.
