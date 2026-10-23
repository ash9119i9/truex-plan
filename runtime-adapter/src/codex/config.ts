import type { McpServerSpec, ModelSettings } from "../contract";
import { PERMISSION_PROFILE } from "./coding";

// The only place Codex configuration is built. The platform sends typed model
// settings; nothing it sends is merged in as raw configuration, so agent text
// can never turn a capability back on.

const PROVIDER = "truex_gateway";

// Verified against the pin (test/codex/lifecycle.test.ts): with these settings
// the model is offered zero tools and no Codex context blocks.
const TEXT_ONLY = {
  // Pinned on explicitly: a steer cuts the reply being written instead of
  // being appended to it. It is "under development" upstream, so pinning it
  // makes a default change fail the pin tests rather than silently alter
  // steer behaviour.
  "features.instant_interrupt": true,
  "features.shell_tool": false,
  "features.unified_exec": false,
  "features.multi_agent": false,
  "features.hooks": false,
  "features.view_image": false,
  "features.goals": false,
  "tools.experimental_request_user_input": { enabled: false },
  "skills.bundled.enabled": false,
  web_search: "disabled",
  project_doc_max_bytes: 0,
  // Codex's own context blocks: the permissions block contradicts the
  // no-tools prompt, and the environment block exposes the host's paths
  // (tenant and chat IDs), shell and timezone. The prompt carries the date.
  include_permissions_instructions: false,
  include_environment_context: false,
} as const;

// Per tool result, in tokens (Codex converts to ~4 bytes per token).
const TOOL_OUTPUT_TOKEN_LIMIT = 20_000;
const TOOL_OUTPUT_CONTEXT_SHARE = 0.1;

export function toolOutputTokenLimit(contextWindow: number): number {
  return Math.min(
    TOOL_OUTPUT_TOKEN_LIMIT,
    Math.floor(contextWindow * TOOL_OUTPUT_CONTEXT_SHARE),
  );
}

// Builds the `mcp_servers.<name>` config entries Codex consumes. Verified
// against the pin (the mcp-probe): the key is `mcp_servers.<name>` and each
// entry carries `url`, `http_headers` (an object), `tool_timeout_sec`,
// `startup_timeout_sec` and `enabled_tools`. `default_tools_approval_mode` is
// forced to "auto" on every server: a read-only tool runs, while an
// unannotated or write tool asks the client (MCP_APPROVAL_POLICY). The adapter
// never emits an "approve" mode (runs writes silently, mcp-probe 2) nor a
// per-tool `approval_mode`. Headers are copied verbatim and live in memory
// only.
function mcpConfigEntries(
  mcp: readonly McpServerSpec[],
  contextWindow: number,
): Record<string, unknown> {
  const entries: Record<string, unknown> = {};
  if (mcp.length === 0) return entries;
  // The pin waits only 1 s for an optional server before the first model call
  // (DEFAULT_OPTIONAL_MCP_STARTUP_GRACE); a slower server (GitHub takes ~4 s)
  // is left out of that call, so the model starts with no connector tools.
  // Waiting up to the slowest server's own startup timeout gives the first
  // call the tools. A server that still fails is omitted and reported through
  // `connector.status`; the chat answers without it (not `required = true`,
  // which would fail the whole thread start).
  entries.mcp_optional_startup_grace_ms =
    Math.max(...mcp.map((server) => server.startupTimeoutSec)) * 1000;
  // Codex does not know our model names, so it falls back to a 10 KB cap per
  // tool result and drops the middle of anything longer (a 4-repo GitHub
  // search already exceeds it). Allow a larger result, bounded by a share of
  // the model's context so a few calls cannot fill it.
  entries.tool_output_token_limit = toolOutputTokenLimit(contextWindow);
  for (const server of mcp) {
    entries[`mcp_servers.${server.name}`] = {
      url: server.url,
      http_headers: { ...server.headers },
      ...(server.enabledTools
        ? { enabled_tools: [...server.enabledTools] }
        : {}),
      tool_timeout_sec: server.toolTimeoutSec,
      startup_timeout_sec: server.startupTimeoutSec,
      default_tools_approval_mode: "auto",
    };
  }
  return entries;
}

// With connectors attached, Codex asks the client before a tool that is not
// marked read-only (`mcpServer/elicitation/request`, answered in chat.ts). Only
// MCP prompts are allowed; every other approval kind stays auto-refused, and
// the model is offered exactly the same tools as under "never" (verified on
// the pin, approval probe 2026-10-20). Text-only runs keep "never".
const MCP_APPROVAL_POLICY = {
  granular: {
    sandbox_approval: false,
    rules: false,
    skill_approval: false,
    request_permissions: false,
    mcp_elicitations: true,
  },
} as const;

// A skill directory Codex discovers as a capability root: `<state>/skills/
// <sha256>`, holding the skill's folder. The model reads it through Codex's
// own `skills.list` / `skills.read` tools (verified on the pin, skills probe
// 2026-10-21). Roots are read only at thread/start; a resumed thread keeps
// them as long as the files are still on disk.
export interface SkillRoot {
  readonly id: string;
  readonly path: string;
}

function capabilityRoots(skills: readonly SkillRoot[]) {
  if (skills.length === 0) return {};
  return {
    selectedCapabilityRoots: skills.map((skill) => ({
      id: skill.id,
      location: {
        type: "environment",
        environmentId: "local",
        path: skill.path,
      },
    })),
  };
}

// A coding run (RUNTIME_CODING_ENABLED=1): the coding profile's config keys,
// built by `codingConfig`, applied over the text-only base.
export interface CodingSettings {
  readonly config: Record<string, unknown>;
  // `codingInstructions`, sent on start and on every resume.
  readonly instructions: string;
}

// Coding runs ask only before a command a prompt rule matches (see coding.ts)
// and every MCP tool that is not read-only. Everything else inside the
// sandbox runs without asking. `sandbox_approval: false` makes Codex refuse,
// rather than ask about, anything that needs to leave the sandbox: a patch
// outside the workspace (which an approval would write unsandboxed), an
// escalation request, and a command Codex flags as dangerous (`rm -f`,
// `sudo`). Verified on the pin (test/codex/coding-approvals.test.ts). The
// named permissions profile replaces `sandbox` (Codex refuses both together).
const CODING_APPROVAL_POLICY = {
  granular: {
    sandbox_approval: false,
    rules: true,
    skill_approval: false,
    request_permissions: false,
    mcp_elicitations: true,
  },
} as const;

function access(mcp: readonly McpServerSpec[], coding?: CodingSettings) {
  if (coding)
    return {
      approvalPolicy: CODING_APPROVAL_POLICY,
      permissions: PERMISSION_PROFILE,
      developerInstructions: coding.instructions,
    };
  return {
    approvalPolicy: mcp.length > 0 ? MCP_APPROVAL_POLICY : "never",
    sandbox: "read-only",
  };
}

function sessionSettings(
  model: ModelSettings,
  workspace: string,
  mcp: readonly McpServerSpec[] = [],
  coding?: CodingSettings,
) {
  return {
    model: model.modelName,
    modelProvider: PROVIDER,
    cwd: workspace,
    ...access(mcp, coding),
    config: {
      ...TEXT_ONLY,
      ...(coding?.config ?? {}),
      [`model_providers.${PROVIDER}`]: {
        name: "Truex gateway",
        base_url: model.gatewayUrl,
        wire_api: "responses",
        // Held in memory only; verified not to be written to the Codex home.
        experimental_bearer_token: model.gatewayToken,
        supports_websockets: false,
        // Request retries are silent; keep them few so outages surface
        // instead of hiding behind a long spinner.
        request_max_retries: 1,
        stream_max_retries: 2,
      },
      model_context_window: model.contextWindow,
      model_auto_compact_token_limit: model.autoCompactTokenLimit,
      ...(model.reasoningEffort
        ? { model_reasoning_effort: model.reasoningEffort }
        : {}),
      // Empty when no MCP server is attached, so the params stay byte-for-byte
      // identical to the text-only path.
      ...mcpConfigEntries(mcp, model.contextWindow),
    },
  };
}

export function threadStartParams(
  model: ModelSettings,
  agentPrompt: string,
  workspace: string,
  mcp: readonly McpServerSpec[] = [],
  coding?: CodingSettings,
  skills: readonly SkillRoot[] = [],
) {
  return {
    ...sessionSettings(model, workspace, mcp, coding),
    baseInstructions: agentPrompt,
    // Absent without skills, so the params stay byte for byte the same.
    ...capabilityRoots(skills),
  };
}

// No instructions on resume: Codex keeps the thread's original prompt, and
// sending new ones would replace it (verified against the pin). The MCP config
// IS resent every time: a resume without it gives the model no MCP tools
// (mcp-probe 3).
export function threadResumeParams(
  threadId: string,
  model: ModelSettings,
  workspace: string,
  mcp: readonly McpServerSpec[] = [],
  coding?: CodingSettings,
) {
  return {
    threadId,
    ...sessionSettings(model, workspace, mcp, coding),
    excludeTurns: true,
  };
}
