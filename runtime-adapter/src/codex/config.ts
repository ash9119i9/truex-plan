import type { ModelSettings } from "../contract";

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

function sessionSettings(model: ModelSettings, workspace: string) {
  return {
    model: model.modelName,
    modelProvider: PROVIDER,
    cwd: workspace,
    approvalPolicy: "never",
    sandbox: "read-only",
    config: {
      ...TEXT_ONLY,
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
    },
  };
}

export function threadStartParams(
  model: ModelSettings,
  agentPrompt: string,
  workspace: string,
) {
  return {
    ...sessionSettings(model, workspace),
    baseInstructions: agentPrompt,
  };
}

// No instructions on resume: Codex keeps the thread's original prompt, and
// sending new ones would replace it (verified against the pin).
export function threadResumeParams(
  threadId: string,
  model: ModelSettings,
  workspace: string,
) {
  return { threadId, ...sessionSettings(model, workspace), excludeTurns: true };
}
