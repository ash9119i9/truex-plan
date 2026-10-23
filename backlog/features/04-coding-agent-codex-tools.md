# Coding agent: create files, write and test code, push, using Codex's own tools

Status: open · High · Added 2026-10-21 · Waiting on AgentCore (`backlog/release/01-agentcore-validation.md`)

## Goal

On platform-next, the agent can create files, write and edit code, run tests, commit and push to the user's git host, with approval for everything except reads. Generic (no single git host), per user, security first, and built from Codex features rather than Truex logic. `vendor/codex` is not modified.

## Decided (2026-10-21)

- Run inside AgentCore first; move to a separate sandbox later.
- Node.js and Python both in the image; no other toolchains.
- Approve everything except reads. The card offers Allow once and Allow for this chat (`acceptForSession`); push always asks.
- No host-specific tools. Push is plain `git push`; PRs/MRs go through that host's MCP connector.
- Office documents through skills (skills plan), not a port of the legacy document tools.

## Codex features to use (pin `1ef30bc`)

| Need | Codex feature |
|---|---|
| Run code and tests | `exec_command` in the Linux sandbox (`linux-sandbox`: bubblewrap + seccomp); writes only in the workspace |
| Create, edit, delete files | `apply_patch` |
| Approve all but reads | `approval_policy = "untrusted"` + exec-policy rules file allowing read commands; redirects/subshells don't match a plain rule (`shell-command/src/bash.rs:20`) |
| Push always asks | `prompt` rule for `git push` |
| Token never in the sandbox | Network proxy credential broker (`network-proxy/src/credential_broker`): commands see a dummy, proxy injects the real token for configured URL prefixes |
| Network control | Proxy domain allowlist (npm, PyPI, user's git host); unlisted domain → network approval |
| Uploads, downloads, files panel | app-server `fs/writeFile`, `fs/readFile`, `fs/readDirectory`, `fs/watch` |
| Ask, plan, goals | `request_user_input`, `update_plan`, goal tools |
| Audit | Codex OTEL events + our approval records |

## Truex builds

1. Per-chat Codex config in `runtime-adapter/src/codex/config.ts`: permissions profile, rules file, domain allowlist, credential providers. Today it is text-only (`shell_tool: false`, `sandbox: "read-only"`).
2. Approval relay for command, file-change and network approvals to the existing MCP approval card.
3. Hand the user's git token and host to the credential broker.
4. UI: live command output, diffs (`turn/diff/updated`), files panel.

## Probe first (on AgentCore)

- Does bubblewrap run in the AgentCore microVM (user namespaces)? If not, the sandbox and the proxy can be bypassed, and a command can read the real token from the Codex process via `/proc`. Then push credentials must stay out of the VM until the separate sandbox exists.
- Rules + `untrusted`: reads run without asking; writes, `sed -i`, `find -delete`, redirects ask.
- `git commit` with `.git` read-only in the sandbox: does it need an out-of-sandbox approval?
- Broker adds the token on `git push` while the sandbox sees only the dummy.
- Per-user credentials through per-session environment.
- Whether `experimental_network` config is stable enough in this pin.

## Done when

Each probe result is recorded here, and in the real app a user can create a file, write code, run its tests in Node and Python, approve edits once or for the chat, and push to a branch on a non-GitHub host, with the token never visible inside the sandbox and every action in the audit log.
