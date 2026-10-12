import { platform } from "node:os";

// Subprocess tests inherit operating-system plumbing only. Application routing,
// secrets, proxy settings and NODE_OPTIONS must come from the fixture itself.
const OS_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SystemRoot",
  "SYSTEMROOT",
  "COMSPEC",
  "WINDIR",
] as const;

export function testEnvironment(
  overrides: NodeJS.ProcessEnv = {},
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of OS_KEYS)
    if (inherited[key] !== undefined) environment[key] = inherited[key];
  return {
    ...environment,
    NODE_ENV: "test",
    AGENTCORE_RUNTIME_ARN: "",
    ...overrides,
    // A fixture cannot accidentally switch dotenv back to the project .env.
    DOTENV_CONFIG_PATH: platform() === "win32" ? "NUL" : "/dev/null",
  };
}

/** Refuse configured deployment routing before starting a fixture server. */
export function assertFixtureRuntime(
  environment: NodeJS.ProcessEnv,
  host: string,
) {
  const url = new URL(host);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    environment.AGENTCORE_RUNTIME_ARN ||
    environment.AGENT_CORE_URLS !== host
  )
    throw new Error("Test runtime must be the explicit loopback fixture");
}
