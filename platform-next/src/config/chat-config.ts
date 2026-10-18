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
  if (problems.length > before || !adapterUrl || !gatewayUrl) return undefined;
  return {
    adapterUrl,
    adapterToken: env.RUNTIME_ADAPTER_TOKEN!,
    gatewayUrl,
    gatewaySecret: env.MODEL_GATEWAY_SECRET!,
  };
}
