// Starts the chat v1 stack: model-gateway, runtime-adapter and platform-next,
// then the frontend once all three accept connections. Each service runs its
// own `npm run dev` and loads its own .env; this only checks that they agree,
// labels their output and stops them together. `npm run dev` is the old stack.
import { execFileSync, spawn } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseEnv } from "node:util";
import { portInUse, waitForPort } from "./dev-readiness.mjs";

const LOG_DIR = ".runtime/dev-next";
// tsx watch gives each backend 5 s to shut down; whatever is left is killed.
const STOP_TIMEOUT_MS = 10_000;
const services = [
  { dir: "model-gateway", port: 4200 },
  { dir: "runtime-adapter", port: 4400 },
  { dir: "platform-next", port: 4100 },
  { dir: "frontend", port: 3000 },
];

const problems = [];
const env = {};
for (const service of services) {
  const file = resolve(service.dir, ".env");
  env[service.dir] = existsSync(file)
    ? parseEnv(readFileSync(file, "utf8"))
    : {};
  if (!existsSync(file) && service.dir !== "frontend")
    problems.push(
      `${service.dir}/.env is missing: copy ${service.dir}/.env.example and fill it in.`,
    );
  if (!existsSync(resolve(service.dir, "node_modules")))
    problems.push(
      `${service.dir} has no dependencies: run npm --prefix ${service.dir} ci.`,
    );
  service.port = Number(env[service.dir].PORT || service.port);
}
// platform-next sends these to the adapter and the gateway. A mismatch only
// shows up later, as refused chat requests.
for (const [key, dir] of [
  ["RUNTIME_ADAPTER_TOKEN", "runtime-adapter"],
  ["MODEL_GATEWAY_SECRET", "model-gateway"],
]) {
  const sent = env["platform-next"][key];
  if (sent && sent !== env[dir][key])
    problems.push(
      `${key} differs between platform-next/.env and ${dir}/.env, so chat requests would be refused.`,
    );
}
const claimed = new Set();
for (const { dir, port } of services) {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    problems.push(`${dir}: PORT must be an integer between 1 and 65535.`);
  else if (claimed.has(port))
    problems.push(`${dir}: port ${port} is configured for another service.`);
  else if (await portInUse(port))
    problems.push(
      [`${dir}: port ${port} is already in use.`, listener(port)]
        .filter(Boolean)
        .join("\n"),
    );
  claimed.add(port);
}
if (problems.length) {
  for (const problem of problems) console.error(problem);
  process.exit(1);
}

function listener(port) {
  try {
    return execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], {
      encoding: "utf8",
    }).trimEnd();
  } catch {
    return "";
  }
}

mkdirSync(LOG_DIR, { recursive: true });
const width = Math.max(...services.map(({ dir }) => dir.length));
const running = new Set();
const startup = new AbortController();
let stopping = false;
// A closed terminal must not interrupt the shutdown below.
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});
for (const name of ["SIGINT", "SIGTERM", "SIGHUP"])
  process.on(name, () => stop("Stopping all services…"));

function launch(service) {
  const log = createWriteStream(resolve(LOG_DIR, `${service.dir}.log`));
  let logFailed = false;
  log.on("error", (error) => {
    if (!logFailed) console.error(`${service.dir}: log file: ${error.message}`);
    logFailed = true;
  });
  const child = spawn("npm", ["run", "dev"], {
    cwd: resolve(service.dir),
    // No shared stdin: tsx watch restarts its process when Enter is pressed.
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    // Next binds before loading .env; use the same port we checked above.
    env: { ...process.env, PORT: String(service.port) },
  });
  running.add(child);
  for (const [input, output] of [
    [child.stdout, process.stdout],
    [child.stderr, process.stderr],
  ])
    createInterface({ input, crlfDelay: Infinity }).on("line", (line) => {
      if (!logFailed) log.write(`${line}\n`);
      output.write(`${service.dir.padEnd(width)} │ ${line}\n`);
    });
  child.once("error", (error) =>
    fail(`${service.dir} could not start: ${error.message}`),
  );
  child.once("exit", (code, signal) =>
    fail(`${service.dir} exited (${signal ?? `code ${code}`})`, code),
  );
  child.once("close", () => {
    running.delete(child);
    log.end();
    if (stopping && running.size === 0) console.log("All services stopped.");
  });
}

function fail(reason, code) {
  if (stopping) return;
  process.exitCode = code || 1;
  stop(`${reason}; stopping the other services…`);
}

function stop(message) {
  if (stopping) return;
  stopping = true;
  startup.abort();
  // npm hands this on once, so each service runs its normal shutdown. Signalling
  // the whole group would reach tsx watch twice, and it force-kills on the second.
  for (const child of running) signal(child.pid, "SIGTERM");
  console.log(`\n${message}`);
  setTimeout(() => {
    for (const child of running) signal(-child.pid, "SIGKILL");
    setTimeout(() => process.exit(), 1000).unref();
  }, STOP_TIMEOUT_MS).unref();
}

function signal(pid, name) {
  try {
    process.kill(pid, name);
  } catch {}
}

const loopback = (dir) => {
  const host = process.env.HOST || env[dir].HOST || "127.0.0.1";
  return host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;
};
try {
  const backends = services.filter(({ dir }) => dir !== "frontend");
  backends.forEach(launch);
  console.log("Waiting for the backends to accept connections…");
  await Promise.all(
    backends.map(({ dir, port }) =>
      waitForPort(port, { host: loopback(dir), signal: startup.signal }),
    ),
  );
  const frontend = services.find(({ dir }) => dir === "frontend");
  if (!stopping) launch(frontend);
  await waitForPort(frontend.port, { signal: startup.signal });
  console.log(
    [
      "",
      `Ready: http://localhost:${frontend.port}`,
      backends.map(({ dir, port }) => `${dir} :${port}`).join(" · "),
      `Logs: ${LOG_DIR}/<service>.log · Ctrl+C stops everything`,
      "",
    ].join("\n"),
  );
} catch (error) {
  if (!stopping) {
    process.exitCode = 1;
    stop(`${error.message}; stopping all services…`);
  }
}
