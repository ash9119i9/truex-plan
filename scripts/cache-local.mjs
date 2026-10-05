// Local disposable Valkey only. Requires an already installed, verified binary.
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = "9.1.2";
const usage =
  "Usage: node scripts/cache-local.mjs [--check | --port <1-65535>]";

function binary(configured, fallback, command) {
  if (configured) {
    const path = resolve(configured);
    if (!existsSync(path)) throw new Error(`${command} binary does not exist`);
    return path;
  }
  if (existsSync(fallback)) return fallback;
  for (const entry of (process.env.PATH || "").split(delimiter)) {
    if (!entry) continue;
    const path = resolve(entry, command);
    if (existsSync(path)) return path;
  }
  throw new Error(
    `Install verified Valkey ${version}, then set VALKEY_SERVER_BIN and VALKEY_CLI_BIN. See docs/APPLICATION_CACHE_OPERATIONS.md.`,
  );
}

async function main() {
  const args = process.argv.slice(2);
  const check = args.length === 1 && args[0] === "--check";
  let port = 6379;
  if (!check && args.length) {
    if (args.length !== 2 || args[0] !== "--port" || !/^\d+$/.test(args[1]))
      throw new Error(usage);
    port = Number(args[1]);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
      throw new Error(usage);
  }
  const server = binary(
    process.env.VALKEY_SERVER_BIN,
    resolve(root, ".runtime/cache-tools/valkey/src/valkey-server"),
    "valkey-server",
  );
  const cli = binary(
    process.env.VALKEY_CLI_BIN,
    join(dirname(server), "valkey-cli"),
    "valkey-cli",
  );
  for (const [path, expected] of [
    [server, /^Valkey server v=9\.1\.2(?:\s|$)/],
    [cli, /^valkey-cli 9\.1\.2(?:\s|$)/],
  ]) {
    const output = execFileSync(path, ["--version"], {
      encoding: "utf8",
      timeout: 2000,
      maxBuffer: 4096,
    }).trim();
    if (!expected.test(output))
      throw new Error(
        `Expected Valkey ${version}; install the documented test version.`,
      );
  }
  console.log(
    `Valkey ${version} binaries verified by version (not artifact checksum).`,
  );
  console.log(`VALKEY_SERVER_BIN=${server}`);
  console.log(`VALKEY_CLI_BIN=${cli}`);
  if (check) return;
  const dir = await mkdtemp(join(tmpdir(), "truex-local-cache-"));
  let child;
  let stopping = false;
  let force;
  const stop = () => {
    if (
      stopping ||
      !child ||
      child.exitCode !== null ||
      child.signalCode !== null
    )
      return;
    stopping = true;
    child.kill("SIGTERM");
    force = setTimeout(() => child.kill("SIGKILL"), 5000);
    force.unref();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    child = spawn(
      server,
      [
        "--bind",
        "127.0.0.1",
        "--protected-mode",
        "yes",
        "--port",
        String(port),
        "--save",
        "",
        "--appendonly",
        "no",
        "--maxmemory",
        "64mb",
        "--maxmemory-policy",
        "allkeys-lru",
        "--dir",
        dir,
        "--daemonize",
        "no",
      ],
      { stdio: "inherit" },
    );
    console.log(
      `Local disposable cache: redis://127.0.0.1:${port}; Ctrl-C stops it.`,
    );
    const code = await new Promise((done, reject) => {
      child.once("error", reject);
      child.once("exit", (exitCode, signal) =>
        done(stopping ? 0 : (exitCode ?? (signal ? 1 : 0))),
      );
    });
    process.exitCode = code;
  } finally {
    if (force) clearTimeout(force);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
