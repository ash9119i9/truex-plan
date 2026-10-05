import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { waitForPort } from "../../scripts/dev-readiness.mjs";

async function freePort() {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

test("backend readiness waits for an actual listener, then resolves", async () => {
  const port = await freePort();
  const server = createServer();
  let ready = false;
  const waiting = waitForPort(port, { timeoutMs: 3000 }).then(() => {
    ready = true;
  });
  try {
    await pause(150);
    assert.equal(ready, false);
    await new Promise<void>((done) => server.listen(port, "127.0.0.1", done));
    await waiting;
    assert.equal(ready, true);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test("backend readiness times out and aborts without an open listener", async () => {
  const port = await freePort();
  await assert.rejects(waitForPort(port, { timeoutMs: 100 }), /did not start/);
  const controller = new AbortController();
  const waiting = waitForPort(port, { signal: controller.signal });
  controller.abort(new Error("Stopped test startup"));
  await assert.rejects(waiting, /Stopped test startup/);
  await assert.rejects(
    waitForPort(port, { signal: controller.signal }),
    /Stopped test startup/,
  );
});

test("backend readiness rejects invalid ports and deadlines immediately", async () => {
  for (const port of [0, -1, 65536, NaN, 1.5])
    await assert.rejects(waitForPort(port), RangeError);
  for (const timeoutMs of [0, -1, NaN, Infinity])
    await assert.rejects(waitForPort(4000, { timeoutMs }), RangeError);
});

// Real subprocesses and TCP sockets: same startup regression can be run against
// the preserved old launcher via TRUEX_DEV_SCRIPT_UNDER_TEST, without touching
// the user's servers, real Mongo database, authentication, or model providers.
for (const scenario of [
  "local",
  "remote",
  "quoted",
  "no-gateway",
  "cancel",
  "backend-exit",
]) {
  const remote = scenario === "remote",
    quoted = scenario === "quoted";
  test(`dev launcher startup: ${scenario}`, { timeout: 15000 }, async () => {
    const root = await mkdtemp(resolve(tmpdir(), "truex-dev-startup-"));
    const ports = {
      platform: await freePort(),
      frontend: await freePort(),
      "agent-core": await freePort(),
      "model-gateway": await freePort(),
    };
    const launcher =
      process.env.TRUEX_DEV_SCRIPT_UNDER_TEST || resolve("../scripts/dev.mjs");
    const marker = resolve(root, "frontend-result.json");
    let child: ReturnType<typeof spawn> | undefined;
    try {
      for (const [name, port] of Object.entries(ports)) {
        if (name === "model-gateway" && scenario === "no-gateway") continue;
        const dir = resolve(root, name);
        await mkdir(dir);
        await writeFile(
          resolve(dir, "package.json"),
          JSON.stringify({
            private: true,
            scripts: { dev: "node index.mjs" },
          }),
        );
        await writeFile(
          resolve(dir, ".env"),
          quoted
            ? `PORT="${port}"\nHOST=127.0.0.1 # local listener\n`
            : `PORT=${port}\n`,
        );
        const script =
          name === "platform" && scenario === "cancel"
            ? "setInterval(() => {}, 1000);"
            : name === "platform" && scenario === "backend-exit"
              ? "setTimeout(() => process.exit(2), 100);"
              : name === "frontend"
                ? `import{writeFileSync}from'node:fs';import{createServer}from'node:http';let status=0,gatewayStatus=0;try{status=(await fetch('http://127.0.0.1:${ports.platform}/api/agents')).status;gatewayStatus=(await fetch('http://127.0.0.1:${ports["model-gateway"]}/')).status}catch{}writeFileSync(${JSON.stringify(marker)},JSON.stringify({status,gatewayStatus,port:process.env.PORT}));if(status!==200)process.exit(1);createServer((q,r)=>r.end('frontend')).listen(Number(process.env.PORT)||${port},'127.0.0.1');`
                : `import{createServer}from'node:http';setTimeout(()=>createServer((q,r)=>r.end('[]')).listen(${port},'127.0.0.1'),${name === "platform" ? 1500 : 0});`;
        await writeFile(resolve(dir, "index.mjs"), script);
      }
      const environment = {
        ...process.env,
        AGENTCORE_RUNTIME_ARN: remote ? "fixture-runtime" : "",
      };
      delete environment.HOST;
      delete environment.PORT;
      child = spawn(process.execPath, [launcher], {
        cwd: root,
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const exited = new Promise<number | null>((done) =>
        child!.once("exit", (code) => done(code)),
      );
      let logs = "";
      child.stdout?.on("data", (data) => {
        logs += data;
      });
      child.stderr?.on("data", (data) => {
        logs += data;
      });
      if (scenario === "cancel" || scenario === "backend-exit") {
        if (scenario === "cancel") {
          await waitForPort(ports["agent-core"], { timeoutMs: 3000 });
          child.kill("SIGTERM");
        }
        const code = await exited;
        assert.equal(code, scenario === "cancel" ? 0 : 2);
        await assert.rejects(readFile(marker), { code: "ENOENT" });
        for (const port of Object.values(ports))
          await assert.rejects(
            waitForPort(port, { timeoutMs: 100 }),
            /did not start/,
          );
        return;
      }
      let result;
      for (let attempt = 0; attempt < 120; attempt++) {
        try {
          result = JSON.parse(await readFile(marker, "utf8"));
          break;
        } catch {}
        if (child.exitCode !== null)
          throw new Error(`Launcher exited before frontend: ${logs}`);
        await pause(50);
      }
      assert.ok(result, `Frontend never started: ${logs}`);
      assert.equal(
        result.status,
        200,
        "Frontend must not mount before its initial API request can succeed",
      );
      assert.equal(result.gatewayStatus, scenario === "no-gateway" ? 0 : 200);
      if (scenario === "no-gateway")
        await assert.rejects(
          waitForPort(ports["model-gateway"], { timeoutMs: 100 }),
          /did not start/,
        );
      assert.equal(result.port, String(ports.frontend));
      if (remote)
        await assert.rejects(
          waitForPort(ports["agent-core"], { timeoutMs: 100 }),
          /did not start/,
        );
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((done) =>
          child!.once("exit", () => done()),
        );
        child.kill("SIGTERM");
        await Promise.race([exited, pause(3000, undefined, { ref: false })]);
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await exited;
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  });
}
