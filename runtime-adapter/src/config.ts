import { accessSync, constants, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  detectToolchains,
  packageBoundary,
  type CodingSetup,
} from "./codex/coding";

// Startup configuration, read once and validated before anything listens.
// Invalid configuration stops startup with every problem listed.

// How the adapter is reached (RUNTIME_MODE):
// - "server" (default): the HTTP API on HOST:PORT, bearer token from
//   RUNTIME_ADAPTER_TOKEN.
// - "agentcore": the Bedrock AgentCore Runtime contract (/ping and
//   /invocations) on HOST:PORT, default 0.0.0.0:8080. The HTTP API runs on
//   loopback behind it with a token generated at start (src/agentcore).
export type RuntimeMode = "server" | "agentcore";
const MODES: readonly RuntimeMode[] = ["server", "agentcore"];

export interface AdapterConfig {
  readonly mode: RuntimeMode;
  readonly host: string;
  readonly port: number;
  // Empty in agentcore mode, where the bridge generates one per start.
  readonly token: string;
  readonly stateDir: string;
  readonly codexBinary: string;
  readonly maxProcesses: number;
  readonly idleMs: number;
  readonly drainMs: number;
  readonly limits: RuntimeLimits;
  // When true, an MCP spec may use an http URL whose host is loopback. Off by
  // default: every other request requires https. This is a test-only escape
  // hatch (the fixture MCP server listens on 127.0.0.1 over plain http), so
  // production never relaxes transport security for a real connector.
  readonly allowLoopbackMcp: boolean;
  // Present when the operator turned coding on (RUNTIME_CODING_ENABLED=1):
  // every run gets the coding profile (src/codex/coding.ts). An emergency
  // switch, not a per-agent setting; off keeps text-only runs unchanged.
  readonly coding: CodingSetup | undefined;
}

// Timeouts the adapter enforces. Callers may shorten the model limits, never
// lengthen them. Tests use small values.
export interface RuntimeLimits {
  readonly rpcMs: number;
  readonly firstResponseMs: number;
  readonly silenceMs: number;
  // Longest a tool approval may wait; the platform may ask for less.
  readonly approvalMs: number;
  readonly stopMs: number;
  readonly heartbeatMs: number;
  readonly finishedRunTtlMs: number;
  readonly bufferEvents: number;
  // Per reply, counting the lead's and its helpers' commands: a reply stops
  // as COMMAND_LIMIT when this many commands failed, or this many ran, so a
  // model retrying tools that can't work stops spending tokens.
  readonly maxFailedCommands: number;
  readonly maxCommands: number;
}

export const DEFAULT_LIMITS: RuntimeLimits = {
  rpcMs: 30_000,
  firstResponseMs: 180_000,
  silenceMs: 120_000,
  approvalMs: 5 * 60_000,
  stopMs: 5_000,
  heartbeatMs: 15_000,
  finishedRunTtlMs: 5 * 60_000,
  bufferEvents: 500,
  maxFailedCommands: 12,
  maxCommands: 120,
};

export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid configuration:\n- ${problems.join("\n- ")}`);
    this.name = "ConfigError";
  }
}

type Env = Readonly<Record<string, string | undefined>>;

// The repository root holds codex.lock.json; the adapter lives one level down.
export const REPO_ROOT = resolve(__dirname, "../..");

export function loadConfig(env: Env, repoRoot = REPO_ROOT): AdapterConfig {
  const problems: string[] = [];
  const int = (name: string, fallback: number, min: number, max: number) => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      problems.push(`${name} must be a whole number from ${min} to ${max}.`);
      return fallback;
    }
    return value;
  };

  const rawMode = env.RUNTIME_MODE || "server";
  const mode = MODES.find((m) => m === rawMode) ?? "server";
  if (mode !== rawMode)
    problems.push(`RUNTIME_MODE must be one of: ${MODES.join(", ")}.`);
  const agentCore = mode === "agentcore";

  // In agentcore mode IAM authenticates callers and the loopback token is
  // generated at start, so RUNTIME_ADAPTER_TOKEN is not read.
  const token = agentCore ? "" : (env.RUNTIME_ADAPTER_TOKEN ?? "");
  if (!agentCore && token.length < 32)
    problems.push("RUNTIME_ADAPTER_TOKEN must be at least 32 characters.");

  const stateDir = env.RUNTIME_STATE_DIR ?? "";
  if (!stateDir || !isAbsolute(stateDir))
    problems.push("RUNTIME_STATE_DIR must be an absolute path.");

  const host = env.HOST || (agentCore ? "0.0.0.0" : "127.0.0.1");
  const port = int("PORT", agentCore ? 8080 : 4400, 1, 65535);
  const maxProcesses = int("RUNTIME_MAX_PROCESSES", 20, 1, 1000);
  const idleMs = int("RUNTIME_IDLE_MS", 600_000, 1000, 86_400_000);
  const drainMs = int("RUNTIME_DRAIN_MS", 30_000, 0, 600_000);
  const maxFailedCommands = int(
    "RUNTIME_MAX_FAILED_COMMANDS",
    DEFAULT_LIMITS.maxFailedCommands,
    1,
    1000,
  );
  const maxCommands = int(
    "RUNTIME_MAX_COMMANDS",
    DEFAULT_LIMITS.maxCommands,
    1,
    10_000,
  );
  // A total under the failure limit would leave that limit unreachable.
  if (maxCommands < maxFailedCommands)
    problems.push(
      "RUNTIME_MAX_COMMANDS must be at least RUNTIME_MAX_FAILED_COMMANDS.",
    );
  // Opt-in, test-only: a single "1" turns it on. Any other value (including
  // "true") is treated as off, so an accidental setting can never silently
  // weaken transport security in production.
  const allowLoopbackMcp = env.ADAPTER_ALLOW_LOOPBACK_MCP === "1";
  // Same rule: only "1" turns coding on.
  const codingEnabled = env.RUNTIME_CODING_ENABLED === "1";
  const toolchainDirs = (env.RUNTIME_TOOLCHAIN_DIRS ?? "")
    .split(":")
    .filter(Boolean);
  if (toolchainDirs.some((dir) => !isAbsolute(dir)))
    problems.push("RUNTIME_TOOLCHAIN_DIRS must list absolute paths.");

  const codexBinary = resolveCodexBinary(env, repoRoot, problems);

  if (problems.length) throw new ConfigError(problems);
  return {
    mode,
    host,
    port,
    token,
    stateDir,
    codexBinary,
    maxProcesses,
    idleMs,
    drainMs,
    limits: { ...DEFAULT_LIMITS, maxFailedCommands, maxCommands },
    allowLoopbackMcp,
    coding: codingEnabled
      ? {
          toolchains: detectToolchains(toolchainDirs),
          packageBoundary: packageBoundary(stateDir),
        }
      : undefined,
  };
}

// The binary comes from the pinned lock, or from an operator override for
// packaged images. A caller can never select it. Without an override, the
// local build record must match the pinned revision.
function resolveCodexBinary(env: Env, repoRoot: string, problems: string[]) {
  const override = env.RUNTIME_CODEX_BINARY;
  let binary: string;
  if (override) {
    if (!isAbsolute(override)) {
      problems.push("RUNTIME_CODEX_BINARY must be an absolute path.");
      return "";
    }
    binary = override;
  } else {
    try {
      const lock = JSON.parse(
        readFileSync(resolve(repoRoot, "codex.lock.json"), "utf8"),
      ) as { revision?: string; binary?: string };
      const build = JSON.parse(
        readFileSync(resolve(repoRoot, ".runtime/codex-build.json"), "utf8"),
      ) as { revision?: string };
      if (!lock.binary || !lock.revision) throw new Error("incomplete lock");
      if (build.revision !== lock.revision) {
        problems.push(
          "The local Codex build does not match codex.lock.json. Run `npm run codex:setup`.",
        );
        return "";
      }
      binary = resolve(repoRoot, lock.binary);
    } catch {
      problems.push(
        "Cannot read codex.lock.json and .runtime/codex-build.json. Run `npm run codex:setup`.",
      );
      return "";
    }
  }
  try {
    accessSync(binary, constants.X_OK);
  } catch {
    problems.push("The Codex binary is missing or not executable.");
  }
  return binary;
}
