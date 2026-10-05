import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import net from "node:net";
import { parseEnv } from "node:util";
import { waitForPort } from "./dev-readiness.mjs";
const read = (name) => {
  const file = resolve(name, ".env");
  return existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {};
};
const remoteRuntime =
  process.env.AGENTCORE_RUNTIME_ARN || read("platform").AGENTCORE_RUNTIME_ARN;
const services = [
  ...(remoteRuntime ? [] : [["agent-core", 4100]]),
  ["platform", 4000],
  ["frontend", 3000],
];
if (remoteRuntime) console.log(`Runtime: Bedrock AgentCore ${remoteRuntime}`);
// The model gateway is a separate service: it starts only once
// model-gateway/.env exists. Its secret must match platform's, or every
// gateway request fails with 401.
if (existsSync(resolve("model-gateway", ".env"))) {
  services.push(["model-gateway", 4200]);
  const platform = read("platform").MODEL_GATEWAY_SECRET;
  const gateway = read("model-gateway").MODEL_GATEWAY_SECRET;
  if (platform && gateway && platform !== gateway)
    console.warn(
      "warning: MODEL_GATEWAY_SECRET differs between platform/.env and model-gateway/.env",
    );
}
const ports = new Map();
for (const [name, fallback] of services) {
  const port = Number(process.env.PORT || read(name).PORT || fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`${name}: PORT must be an integer between 1 and 65535`);
  if ([...ports.values()].includes(port))
    throw new Error(
      `${name}: port ${port} is configured for more than one service`,
    );
  ports.set(name, port);
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", () => {
      let owner = "";
      try {
        owner = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], {
          encoding: "utf8",
        });
      } catch {}
      reject(new Error(`${name}: port ${port} is in use\n${owner}`));
    });
    server.listen(port, () => server.close(resolve));
  });
}
mkdirSync(".runtime/workspace", { recursive: true });
const children = [];
const startup = new AbortController();
let closing = false;
function stop() {
  if (closing) return;
  closing = true;
  startup.abort();
  for (const child of children) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
  }
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, stop);
function launch(name) {
  const child = spawn("npm", ["run", "dev"], {
    cwd: resolve(name),
    stdio: "inherit",
    detached: true,
    // Next binds before loading .env; use the same port we checked above.
    env: { ...process.env, PORT: String(ports.get(name)) },
  });
  children.push(child);
  child.once("error", (error) => {
    if (closing) return;
    console.error(`${name} could not start: ${error.message}`);
    process.exitCode = 1;
    stop();
  });
  child.once("exit", (code) => {
    if (!closing) {
      stop();
      process.exitCode = code ?? 1;
    }
  });
}
try {
  const backends = services.filter(([name]) => name !== "frontend");
  backends.forEach(([name]) => launch(name));
  console.log("Waiting for backend listeners before starting the frontend…");
  await Promise.all(
    backends.map(([name]) => {
      const host = process.env.HOST || read(name).HOST || "127.0.0.1";
      return waitForPort(ports.get(name), {
        host: host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host,
        signal: startup.signal,
      });
    }),
  );
  if (!closing) launch("frontend");
} catch (error) {
  if (!closing) {
    console.error(error.message);
    process.exitCode = 1;
    stop();
  }
}
