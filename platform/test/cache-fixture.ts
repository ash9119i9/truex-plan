import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import net from "node:net";

export const valkeyBinary =
  process.env.VALKEY_SERVER_BIN ||
  resolve(__dirname, "../../.runtime/cache-tools/valkey/src/valkey-server");
export const valkeyAvailable = existsSync(valkeyBinary);
if (process.env.REQUIRE_VALKEY_TESTS === "on" && !valkeyAvailable)
  throw new Error(
    "Real cache integration tests require VALKEY_SERVER_BIN; see docs/APPLICATION_CACHE_OPERATIONS.md",
  );
async function freePort() {
  const server = net.createServer();
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}
export async function startValkey(cluster = false) {
  const dir = await mkdtemp(join(tmpdir(), "truex-cache-test-"));
  const port = await freePort();
  const bus = cluster ? await freePort() : undefined;
  const child = spawn(
    valkeyBinary,
    [
      "--bind",
      "127.0.0.1",
      "--port",
      String(port),
      "--save",
      "",
      "--appendonly",
      "no",
      "--maxmemory",
      "32mb",
      "--maxmemory-policy",
      "allkeys-lru",
      "--dir",
      dir,
      ...(cluster
        ? [
            "--cluster-enabled",
            "yes",
            "--cluster-port",
            String(bus),
            "--cluster-config-file",
            "nodes.conf",
            "--cluster-node-timeout",
            "1000",
          ]
        : []),
    ],
    { stdio: "ignore" },
  );
  let spawnError: Error | undefined;
  child.once("error", (error) => {
    spawnError = error;
  });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const exit = new Promise<void>((done) =>
        child.once("exit", () => done()),
      );
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 5000);
      try {
        await exit;
      } finally {
        clearTimeout(force);
      }
    }
    await rm(dir, { recursive: true, force: true });
  };
  try {
    for (let attempt = 0; attempt < 250; attempt++) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null)
        throw new Error("Valkey fixture exited before listening");
      const ready = await new Promise<boolean>((done) => {
        const socket = net.connect({ host: "127.0.0.1", port });
        socket.once("connect", () => {
          socket.destroy();
          done(true);
        });
        socket.once("error", () => {
          socket.destroy();
          done(false);
        });
      });
      if (ready) return { port, url: `redis://127.0.0.1:${port}`, stop };
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("Valkey fixture readiness timed out");
  } catch (error) {
    await stop();
    throw error;
  }
}
export async function startValkeyCluster() {
  const nodes: Awaited<ReturnType<typeof startValkey>>[] = [];
  try {
    for (let i = 0; i < 3; i++) nodes.push(await startValkey(true));
    const cli =
      process.env.VALKEY_CLI_BIN ||
      join(resolve(valkeyBinary, ".."), "valkey-cli");
    await promisify(execFile)(
      cli,
      [
        "--cluster",
        "create",
        ...nodes.map((n) => `127.0.0.1:${n.port}`),
        "--cluster-yes",
      ],
      { timeout: 15000 },
    );
    await new Promise((r) => setTimeout(r, 1200));
    return {
      url: nodes[0].url,
      stop: async () => {
        await Promise.all(nodes.map((n) => n.stop()));
      },
    };
  } catch (error) {
    await Promise.all(nodes.map((n) => n.stop()));
    throw error;
  }
}
