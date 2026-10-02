import { spawn } from "node:child_process";

const services = [
  {
    name: "model-gateway",
    cwd: "/app/model-gateway",
    script: "dist/model-gateway/src/index.js",
    env: { HOST: "127.0.0.1", PORT: "4200" },
  },
  {
    name: "agent-core",
    cwd: "/app/agent-core",
    script: "dist/agent-core/src/index.js",
    env: { HOST: "127.0.0.1", PORT: "4100" },
  },
  {
    name: "agentcore-entrypoint",
    cwd: "/app/agent-core",
    script: "dist/agent-core/src/agentcore.js",
    env: {
      HOST: "0.0.0.0",
      PORT: "8080",
      AGENT_CORE_INTERNAL_URL: "http://127.0.0.1:4100",
      MODEL_GATEWAY_INTERNAL_URL: "http://127.0.0.1:4200",
    },
  },
];

const children = new Map();
let stopping = false;
let exitCode = 0;

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  exitCode = code;
  process.exitCode = code;
  for (const child of children.values()) child.kill("SIGTERM");
  setTimeout(() => process.exit(exitCode || 1), 35_000).unref();
}

for (const service of services) {
  const child = spawn(process.execPath, [service.script], {
    cwd: service.cwd,
    env: { ...process.env, ...service.env },
    stdio: "inherit",
  });
  children.set(service.name, child);
  child.on("error", (error) => {
    console.error(`${service.name} failed to start`, error);
    stop(1);
  });
  child.on("exit", (code, signal) => {
    children.delete(service.name);
    if (!stopping) {
      console.error(`${service.name} exited (code ${code}, signal ${signal})`);
      stop(1);
    }
    if (stopping && children.size === 0) process.exit(exitCode);
  });
}

process.on("SIGTERM", () => stop(0));
process.on("SIGINT", () => stop(0));
