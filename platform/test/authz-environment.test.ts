import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { testEnvironment, assertFixtureRuntime } from "./environment";
import { runtimeHosts } from "../src/runtime-transport";

test("fixture environment drops inherited deployment secrets and routing", () => {
  const environment = testEnvironment(
    { AGENT_CORE_URLS: "http://127.0.0.1:43210", MONGO_URI: "fixture" },
    {
      PATH: "/fixture/bin",
      AGENTCORE_RUNTIME_ARN: "production-runtime",
      MONGO_URI: "production-mongo",
      AWS_SECRET_ACCESS_KEY: "production-secret",
      RESEND_API_KEY: "production-mail",
      NODE_OPTIONS: "--require injected-loader",
      HTTP_PROXY: "http://deployment-proxy",
    },
  );
  assert.equal(environment.PATH, "/fixture/bin");
  assert.equal(environment.MONGO_URI, "fixture");
  for (const key of [
    "AWS_SECRET_ACCESS_KEY",
    "RESEND_API_KEY",
    "NODE_OPTIONS",
    "HTTP_PROXY",
  ])
    assert.equal(environment[key], undefined, key);
  assert.deepEqual(runtimeHosts(environment), ["http://127.0.0.1:43210"]);
  assertFixtureRuntime(environment, "http://127.0.0.1:43210");
  assert.throws(() =>
    assertFixtureRuntime(
      { ...environment, AGENTCORE_RUNTIME_ARN: "remote" },
      "http://127.0.0.1:43210",
    ),
  );
  assert.throws(() =>
    assertFixtureRuntime(environment, "https://customer.example"),
  );
});

test("dotenv cannot route a subprocess through its working directory .env", () => {
  const directory = mkdtempSync(join(tmpdir(), "truex-test-env-"));
  try {
    writeFileSync(
      join(directory, ".env"),
      "AGENTCORE_RUNTIME_ARN=unexpected\nRESEND_API_KEY=unexpected\n",
    );
    const require = createRequire(resolve("package.json"));
    const child = spawnSync(
      process.execPath,
      [
        "-r",
        require.resolve("dotenv/config"),
        "-e",
        "process.stdout.write(JSON.stringify({runtime:process.env.AGENTCORE_RUNTIME_ARN,mail:process.env.RESEND_API_KEY}))",
      ],
      {
        cwd: directory,
        env: testEnvironment({}, { PATH: process.env.PATH }),
        encoding: "utf8",
      },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), { runtime: "" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
