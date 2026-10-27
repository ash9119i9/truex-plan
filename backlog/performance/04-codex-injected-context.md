# Codex adds unrequested context to every chat

Status: open · decide before AgentCore launch · Added 2026-10-17

## Problem

On top of our prompt and the user's message, the pinned Codex (`1ef30bc`) puts two extra blocks into every new thread: a permissions block and an `<environment_context>` block. They stay in the thread history, so the whole conversation resends them on every turn.

- **Cost:** about 280 extra input tokens per turn, for the life of the chat. On the real Claude profile the first turn dropped from 548 to 270 input tokens (−51%) with both blocks off.
- **Leak to the provider:** `<cwd>` and `<workspace_roots>` contain the runtime state path, which includes the tenant ID and chat ID. The shell and server timezone are sent too.
- **Odd replies:** the model cites the block. Asked for the date, Claude answered "I took this from the environment context."
- **Off-topic rules:** the permissions block tells a chat model about sandboxes and commands it cannot run.

## Exact request Codex builds (captured 2026-10-17)

Captured with the adapter's fake model fixture, real pinned Codex, real `chatPrompt()` v1, agent "Research Scout". Script: `.runtime/context-capture/capture.ts`, raw bodies in `turn1.json` / `turn2.json` (gitignored). The local temp path is shortened to `<stateDir>`; on AgentCore it is under `/mnt/state`.

Request `input` for turn 2 (turn 1 is the same without items 4–5):

```text
[0] developer   (857 chars)  ← ours: BASE_INSTRUCTIONS.v1 + agent name/role
You are an assistant in Truex, a workspace where people chat with AI agents.
…
Agent name: "Research Scout"
Agent role: "Finds and summarises sources."

[1] developer   (341 chars)  ← added by Codex
<permissions instructions>
Filesystem sandboxing defines which files can be read or written. `sandbox_mode` is `read-only`: The sandbox only permits reading files. Network access is restricted.
Approval policy is currently never. Do not provide the `sandbox_permissions` for any reason, commands will be rejected.
</permissions instructions>

[2] user        (667 chars)  ← added by Codex
<environment_context>
  <cwd><stateDir>/t/6ad25557bd7f03d236240be6/c/6ad3000000000000000000aa/workspace</cwd>
  <shell>zsh</shell>
  <current_date>2026-10-17</current_date>
  <timezone>Asia/Kolkata</timezone>
  <filesystem><workspace_roots><root><stateDir>/t/6ad25557bd7f03d236240be6/c/6ad3000000000000000000aa/workspace</root></workspace_roots><permission_profile type="managed"><file_system type="restricted"><entry access="read"><special>:root</special></entry></file_system></permission_profile></filesystem>
</environment_context>

[3] user        "What is today's date?"
[4] assistant   "Hello from the fixture."
[5] user        "Thanks"
```

Other top-level fields Codex sends to the gateway:

| Field | Value | Note |
|---|---|---|
| `instructions` | not set | Our prompt goes in as the first developer message |
| `tools` | `[]` | Lockdown holds |
| `tool_choice` / `parallel_tool_calls` | `auto` / `true` | Harmless with no tools |
| `reasoning` | `{"summary":"auto"}` | |
| `include` | `["reasoning.encrypted_content"]` | |
| `store` | `false` | |
| `prompt_cache_key` | the thread ID, same on every turn | Gateway uses it for caching (`model-gateway/src/prompt-cache.ts:73`) |
| `client_metadata` | thread/turn/session IDs, `x-codex-installation-id`, `sandbox`, `sandbox_mode`, `analytics_enabled: true`, `model` | Reaches the gateway only; the gateway does not forward it to Anthropic or Gemini |

Request size: turn 1 3.8 KB, turn 2 4.1 KB, of which about 1 KB is the two Codex blocks.

## Proposed fix (adapter config only, no Codex change)

In `runtime-adapter/src/codex/config.ts`, add to `TEXT_ONLY`:

- `include_permissions_instructions: false`
- `include_environment_context: false`
- `analytics.enabled: false` (confirmed to reach Codex; not yet confirmed whether Codex sends analytics without a ChatGPT login)

Turning off the environment block also removes `<current_date>`. Keep the date by having the adapter prefix each turn's input with one line such as `Today is 2026-10-17 (UTC).` Users never see it; the UI shows the message saved in MongoDB. Decide whether to use UTC or the user's timezone.

## Done when

- Captured request contains only our prompt, the date line and the conversation: no `<permissions instructions>`, no `<environment_context>`, no state path.
- A lockdown-style test asserts this on every Codex pin upgrade, like the zero-tools test.
- Input tokens per turn measured before and after on the production provider.
- The model still answers "what is today's date?" correctly.
