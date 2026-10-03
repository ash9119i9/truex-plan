import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const usage =
  "Usage: node scripts/agentcore-smoke.mjs <runtime-arn> [runtime-session-id]";

async function aws(args) {
  try {
    const { stdout } = await execute("aws", args, {
      encoding: "utf8",
      timeout: 150_000,
      maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, AWS_PAGER: "", AWS_CLI_AUTO_PROMPT: "off" },
    });
    return stdout;
  } catch (error) {
    if (error.code === "ENOENT")
      throw new Error("Install AWS CLI v2 before running this script.");
    throw new Error(error.stderr?.trim() || error.message);
  }
}

// This checks the deployed adapter and real Codex startup without a model call.
export async function runSmokeTest({
  runtimeArn,
  sessionId = randomUUID(),
  outputDir = resolve(".runtime/agentcore-tests", sessionId),
  expectedRevision,
  invoke = aws,
  log = console.log,
}) {
  const arn = runtimeArn?.match(
    /^arn:(?:aws|aws-us-gov|aws-cn):bedrock-agentcore:([a-z0-9-]+):\d{12}:runtime\/[A-Za-z0-9_-]+$/,
  );
  if (!arn) throw new Error(`Invalid AgentCore runtime ARN. ${usage}`);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{32,255}$/.test(sessionId))
    throw new Error(
      "Session ID must contain 33–256 letters, digits, underscores or hyphens.",
    );
  if (expectedRevision === undefined) {
    const pin = JSON.parse(
      await readFile(new URL("../codex.lock.json", import.meta.url), "utf8"),
    );
    expectedRevision = pin.revision;
  }
  const region = arn[1];
  await mkdir(outputDir, { recursive: true });
  log(`Runtime: ${runtimeArn}`);
  log(`Session: ${sessionId}`);
  log(`Results: ${outputDir}`);

  async function check(name, path) {
    const payload = join(outputDir, `${name}.request.json`);
    const response = join(outputDir, `${name}.response.json`);
    await writeFile(payload, JSON.stringify({ method: "GET", path }) + "\n");
    const metadata = JSON.parse(
      await invoke([
        "bedrock-agentcore",
        "invoke-agent-runtime",
        "--agent-runtime-arn",
        runtimeArn,
        "--runtime-session-id",
        sessionId,
        "--region",
        region,
        "--content-type",
        "application/json",
        "--accept",
        "application/json",
        "--payload",
        `fileb://${resolve(payload)}`,
        "--cli-connect-timeout",
        "10",
        "--cli-read-timeout",
        "120",
        "--output",
        "json",
        "--no-cli-pager",
        resolve(response),
      ]),
    );
    await writeFile(
      join(outputDir, `${name}.metadata.json`),
      JSON.stringify(metadata, null, 2) + "\n",
    );
    assert.equal(metadata.statusCode, 200, `${name}: AWS invocation failed`);
    if (metadata.runtimeSessionId !== undefined)
      assert.equal(
        metadata.runtimeSessionId,
        sessionId,
        `${name}: session ID changed`,
      );
    const envelope = JSON.parse(await readFile(response, "utf8"));
    assert.equal(
      envelope.status,
      200,
      `${name}: core returned ${envelope.status}: ${JSON.stringify(envelope.body ?? envelope)}`,
    );
    return envelope.body;
  }

  function healthy(body, name) {
    assert.equal(body?.ok, true, `${name}: core is not healthy`);
    assert.equal(
      body.codexHomeWritable,
      true,
      `${name}: Codex storage is not writable`,
    );
    assert.equal(
      body.revision,
      expectedRevision,
      `${name}: deployed Codex pin differs from codex.lock.json`,
    );
    assert.equal(
      typeof body.codex,
      "string",
      `${name}: missing Codex identity`,
    );
    assert.ok(body.codex.length > 0, `${name}: empty Codex identity`);
    assert.equal(
      typeof body.codexHome,
      "string",
      `${name}: missing Codex storage path`,
    );
  }

  const first = await check("health-start", "/healthz");
  healthy(first, "health-start");
  log(`PASS: Codex started; revision ${first.revision}; writable storage`);
  const capabilities = await check("capabilities", "/capabilities");
  assert.equal(
    capabilities?.revision,
    expectedRevision,
    "Capabilities use a different Codex pin",
  );
  assert.ok(
    Array.isArray(capabilities.requests) && capabilities.requests.length > 0,
    "Missing protocol capabilities",
  );
  log(`PASS: ${capabilities.requests.length} pinned protocol capabilities`);
  const again = await check("health-repeat", "/healthz");
  healthy(again, "health-repeat");
  assert.equal(
    again.codexHome,
    first.codexHome,
    "Codex storage path changed within the session",
  );
  log("PASS: repeated invocation in the same runtime session");
  const result = {
    runtimeArn,
    region,
    sessionId,
    revision: expectedRevision,
    passed: true,
  };
  await writeFile(
    join(outputDir, "result.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  log("Runtime smoke test passed. Model generation was not tested.");
  return result;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [runtimeArn, sessionId, ...extra] = process.argv.slice(2);
  if (runtimeArn === "--help") console.log(usage);
  else if (!runtimeArn || extra.length) {
    console.error(usage);
    process.exitCode = 1;
  } else {
    runSmokeTest({ runtimeArn, sessionId }).catch((error) => {
      console.error(`FAIL: ${error.message}`);
      process.exitCode = 1;
    });
  }
}
