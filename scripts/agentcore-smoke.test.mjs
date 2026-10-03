import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runSmokeTest } from "./agentcore-smoke.mjs";

const runtimeArn =
  "arn:aws:bedrock-agentcore:us-west-2:502055890667:runtime/test_runtime";
const revision = "a".repeat(40);
const sessionId = "12345678-1234-1234-1234-123456789abc";

async function fixture(
  t,
  {
    health = {},
    coreStatus = 200,
    awsStatus = 200,
    returnedSession = sessionId,
  } = {},
) {
  const outputDir = await mkdtemp(join(tmpdir(), "truex-agentcore-smoke-"));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const calls = [];
  const invoke = async (args) => {
    assert.deepEqual(args.slice(0, 2), [
      "bedrock-agentcore",
      "invoke-agent-runtime",
    ]);
    const value = (flag) => args[args.indexOf(flag) + 1];
    assert.equal(value("--region"), "us-west-2");
    assert.equal(value("--agent-runtime-arn"), runtimeArn);
    assert.equal(value("--runtime-session-id"), sessionId);
    assert.equal(value("--content-type"), "application/json");
    assert.match(value("--payload"), /^fileb:\/\//);
    const payload = JSON.parse(
      await readFile(value("--payload").slice(8), "utf8"),
    );
    assert.equal(payload.method, "GET");
    calls.push(payload.path);
    const body =
      payload.path === "/capabilities"
        ? { revision, requests: [{ method: "thread/start" }] }
        : {
            ok: true,
            revision,
            codex: "codex-cli/0.0.0",
            codexHomeWritable: true,
            codexHome: "/mnt/state/codex/business-v1",
            ...health,
          };
    await writeFile(args.at(-1), JSON.stringify({ status: coreStatus, body }));
    return JSON.stringify({
      statusCode: awsStatus,
      runtimeSessionId: returnedSession,
      contentType: "application/json",
    });
  };
  return {
    outputDir,
    calls,
    run: () =>
      runSmokeTest({
        runtimeArn,
        sessionId,
        expectedRevision: revision,
        outputDir,
        invoke,
        log: () => {},
      }),
  };
}

test("invokes the JSON adapter in one session and saves a successful report", async (t) => {
  const f = await fixture(t);
  const result = await f.run();
  assert.deepEqual(f.calls, ["/healthz", "/capabilities", "/healthz"]);
  assert.equal(result.passed, true);
  assert.equal(result.region, "us-west-2");
  assert.equal(result.sessionId, sessionId);
  assert.deepEqual(
    JSON.parse(await readFile(join(f.outputDir, "result.json"), "utf8")),
    result,
  );
});

test("fails on AWS errors, wrapped core errors, a wrong pin, unwritable storage or a changed session", async (t) => {
  for (const [name, options, expected] of [
    ["AWS error", { awsStatus: 500 }, /AWS invocation failed/],
    ["core error inside HTTP 200", { coreStatus: 503 }, /core returned 503/],
    [
      "different deployed binary",
      { health: { revision: "b".repeat(40) } },
      /deployed Codex pin differs/,
    ],
    [
      "unwritable mounted storage",
      { health: { codexHomeWritable: false } },
      /storage is not writable/,
    ],
    [
      "different session",
      { returnedSession: "a-different-runtime-session-id-12345" },
      /session ID changed/,
    ],
  ]) {
    await t.test(name, async (t) => {
      const f = await fixture(t, options);
      await assert.rejects(f.run(), expected);
      await assert.rejects(readFile(join(f.outputDir, "result.json")), {
        code: "ENOENT",
      });
    });
  }
});

test("rejects an invalid runtime ARN or short session ID before invoking AWS", async () => {
  const invoke = () => {
    throw new Error("AWS must not be called");
  };
  await assert.rejects(
    runSmokeTest({ runtimeArn: "invalid", invoke }),
    /Invalid AgentCore runtime ARN/,
  );
  await assert.rejects(
    runSmokeTest({ runtimeArn, sessionId: "too-short", invoke }),
    /Session ID must contain 33/,
  );
});
