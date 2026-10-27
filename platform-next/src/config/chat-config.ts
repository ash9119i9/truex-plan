// Chat settings: where the runtime adapter and the model gateway are, and the
// secrets shared with each. All four are set or none: without them the app
// still serves sign-in and agents, and chat endpoints answer 503 instead of
// starting with a half-configured runtime.

export interface ChatConfig {
  readonly adapterUrl: string;
  readonly adapterToken: string;
  // Base URL Codex calls for a model: `${gatewayUrl}/p/<modelId>/v1`.
  readonly gatewayUrl: string;
  readonly gatewaySecret: string;
  // CHAT_SANDBOX_NETWORK=1: every run carries a network policy (baseline
  // registries, the tenant's allowed sites, the chat's connections) for the
  // runtime's coding sandbox. Off by default: an adapter older than the
  // network contract refuses the field, so turn this on after it is deployed.
  readonly sandboxNetwork?: boolean;
  // CHAT_SUBAGENTS=off|1|2|3 (default off): how many helper agents a reply
  // may run at once. Off sends nothing. An adapter older than the helper
  // contract refuses the field, so set it only once that adapter is deployed.
  // Coding runtimes run helpers too (shared workspace, Codex-exact Option B);
  // older adapters that predate that refuse the field under coding.
  readonly subAgents?: number;
  // FOLLOW_UPS=on|off (default on): whether new chats ask the model for
  // Follow Up rows. Off also stops the API from returning stored rows.
  readonly followUps?: boolean;
  // FOLLOW_UPS_HOLDOUT_PERCENT=0-50 (default 0): share of new chats that get
  // no rows, for the holdout comparison.
  readonly followUpsHoldoutPercent?: number;
  // Not read from the environment: tests shorten them. Defaults are
  // RECOVERY_SWEEP_MS (0 turns the sweep off) and STREAM_HEARTBEAT_MS.
  readonly recoverySweepMs?: number;
  readonly streamHeartbeatMs?: number;
}

type Env = Readonly<Record<string, string | undefined>>;

const NAMES = [
  "RUNTIME_ADAPTER_URL",
  "RUNTIME_ADAPTER_TOKEN",
  "MODEL_GATEWAY_URL",
  "MODEL_GATEWAY_SECRET",
] as const;
const SECRET = /^[\x21-\x7e]{32,512}$/;

function baseUrl(
  value: string,
  name: string,
  problems: string[],
): string | undefined {
  try {
    const url = new URL(value);
    if (
      (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    )
      return value.replace(/\/+$/, "");
  } catch {
    // Reported below.
  }
  problems.push(`${name} must be an http(s) URL without credentials or query.`);
  return undefined;
}

export function loadChatConfig(
  env: Env,
  problems: string[],
): ChatConfig | undefined {
  const set = NAMES.filter((name) => env[name]);
  if (set.length === 0) return undefined;
  if (set.length < NAMES.length) {
    problems.push(
      `Chat needs all of ${NAMES.join(", ")}; missing ${NAMES.filter((n) => !env[n]).join(", ")}.`,
    );
    return undefined;
  }
  const before = problems.length;
  const adapterUrl = baseUrl(
    env.RUNTIME_ADAPTER_URL!,
    "RUNTIME_ADAPTER_URL",
    problems,
  );
  const gatewayUrl = baseUrl(
    env.MODEL_GATEWAY_URL!,
    "MODEL_GATEWAY_URL",
    problems,
  );
  // Secrets are never echoed.
  for (const name of ["RUNTIME_ADAPTER_TOKEN", "MODEL_GATEWAY_SECRET"] as const)
    if (!SECRET.test(env[name]!))
      problems.push(`${name} must be 32-512 printable characters.`);
  const sandboxNetwork = env.CHAT_SANDBOX_NETWORK;
  if (sandboxNetwork !== undefined && !["0", "1"].includes(sandboxNetwork))
    problems.push("CHAT_SANDBOX_NETWORK must be 0 or 1.");
  const subAgents = env.CHAT_SUBAGENTS;
  if (subAgents !== undefined && !["off", "1", "2", "3"].includes(subAgents))
    problems.push("CHAT_SUBAGENTS must be off, 1, 2 or 3.");
  const followUps = env.FOLLOW_UPS;
  if (followUps !== undefined && followUps !== "on" && followUps !== "off")
    problems.push("FOLLOW_UPS must be on or off.");
  const holdoutRaw = env.FOLLOW_UPS_HOLDOUT_PERCENT;
  const holdout = holdoutRaw === undefined ? 0 : Number(holdoutRaw);
  if (
    holdoutRaw !== undefined &&
    (!/^\d{1,2}$/.test(holdoutRaw) || holdout > 50)
  )
    problems.push(
      "FOLLOW_UPS_HOLDOUT_PERCENT must be a whole number from 0 to 50.",
    );
  if (problems.length > before || !adapterUrl || !gatewayUrl) return undefined;
  return {
    adapterUrl,
    adapterToken: env.RUNTIME_ADAPTER_TOKEN!,
    gatewayUrl,
    gatewaySecret: env.MODEL_GATEWAY_SECRET!,
    followUps: followUps !== "off",
    followUpsHoldoutPercent: holdout,
    ...(sandboxNetwork === "1" ? { sandboxNetwork: true } : {}),
    ...(subAgents && subAgents !== "off"
      ? { subAgents: Number(subAgents) }
      : {}),
  };
}
