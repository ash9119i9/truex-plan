import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
const pin = JSON.parse(readFileSync("codex.lock.json", "utf8"));
const checkout = resolve(pin.source);
execFileSync(process.execPath, ["scripts/codex.mjs"], { stdio: "inherit" });
const bin = resolve(checkout, "codex-rs/target/debug/codex");
for (const [command, out] of [
  ["generate-ts", "shared/protocol"],
  ["generate-json-schema", "shared/schema"],
])
  execFileSync(bin, ["app-server", command, "--experimental", "--out", out]);
const source = readFileSync(
  resolve(checkout, "codex-rs/app-server-protocol/src/protocol/common.rs"),
  "utf8",
);
const revision = execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const responses = {};
for (const m of source.matchAll(
  /^    (\w+)(?:\s*=>\s*"([^"]+)")?\s*\{([\s\S]*?)^    \},/gm,
)) {
  const response = m[3].match(/response:\s*(?:v[12]::)?(\w+)/)?.[1];
  if (response)
    responses[m[2] || m[1][0].toLowerCase() + m[1].slice(1)] = response;
}
const groups = {};
for (const [key, file] of [
  ["requests", "ClientRequest"],
  ["serverRequests", "ServerRequest"],
  ["notifications", "ServerNotification"],
]) {
  const ts = readFileSync(`shared/protocol/${file}.ts`, "utf8");
  groups[key] = [
    ...ts.matchAll(/"method": "([^"]+)"[^}]*?"?params"?: (\w+)/g),
  ].map((m) => ({
    method: m[1],
    params: m[2],
    response: responses[m[1]] || null,
    experimental: source.includes(`experimental("${m[1]}")`),
    basic:
      /^(initialize|thread\/(start|resume|started)|turn\/(start|steer|interrupt|started|completed)|item\/(started|completed|agentMessage\/delta)|error)$/.test(
        m[1],
      ),
  }));
}
if (revision !== pin.revision)
  throw new Error("Codex source revision does not match project pin");
const metadata = {
  revision,
  binaryVersion: execFileSync(bin, ["--version"], { encoding: "utf8" }).trim(),
  ...groups,
};
writeFileSync(
  "shared/protocol-inventory.json",
  JSON.stringify(metadata, null, 2) + "\n",
);
let doc = `# Verified protocol inventory\n\nGenerated from Codex revision \`${revision}\` with \`${metadata.binaryVersion}\`. Types and JSON schemas are generated, not transcribed. Regenerate: \`npm run protocol:gen\` (uses only the pinned vendor/codex build). The binary is built inside vendor/codex using npm run codex:setup; no global or sibling binary is used.\n\nEach schema in shared/schema documents full parameters and results. Experimental labels here identify method-level source annotations; field-level gating remains in generated types and runtime validation.\n`;
for (const [key, label] of [
  ["requests", "Client requests"],
  ["notifications", "Server notifications"],
  ["serverRequests", "Server requests"],
]) {
  doc += `\n## ${label}\n\n| Method | Params schema | Result schema | Priority | Method experimental |\n|---|---|---|---|---|\n`;
  for (const x of groups[key])
    doc += `| ${x.method} | ${x.params} | ${x.response || "—"} | ${x.basic ? "Basic" : "Additive"} | ${x.experimental ? "Yes" : "—"} |\n`;
}
doc +=
  "\n## Server-request responses and failures\n\nAll successful response shapes are linked by schema name above. JSON-RPC rejection uses `{ id, error: { code, message } }` without a jsonrpc field. Approval decline is a successful result with the variant-specific denial, not a generic RPC error. Unsupported host capabilities return -32601 promptly. Invalid client answers return HTTP 400 and leave the runtime request pending until a valid answer or expiry. See `agent-core/src/requests.ts` for safe defaults.\n\n## Verification limits\n\nGenerated schemas establish shape, not provider behavior, load capacity, or workspace durability. Tests and runtime evidence are tracked in docs/VALIDATION.md.\n";
doc +=
  "\n## Verified backend limitation\n\nAt this pin, the default history backend rejects `thread/items/list` with -32601. The adapter falls back to `thread/read` with `includeTurns: true`; the fallback is covered by real-runtime and HTTP integration tests. Feature presence in a schema does not imply availability in every backend.\n";
writeFileSync("docs/protocol.md", doc);
let coverage =
  "# Capability coverage\n\nGenerated from the project pin. A generic schema-validated relay and inspector are not proof that every capability works with the current provider/backend. Runtime verification remains separate.\n\n| Direction | Method | Implementation | Verification |\n|---|---|---|---|\n";
for (const [group, entries] of Object.entries(groups))
  for (const e of entries) {
    const dedicated = [
      "initialize",
      "thread/start",
      "thread/resume",
      "thread/read",
      "thread/items/list",
      "turn/start",
      "turn/steer",
      "turn/interrupt",
    ].includes(e.method);
    coverage += `| ${group} | ${e.method} | ${group === "requests" ? (dedicated ? "Dedicated lifecycle/history handler" : "Schema-validated capability relay") : group === "notifications" ? "Mapped event or runtime inspector" : "Variant-specific response or explicit unavailable error"} | See VALIDATION.md; full matrix pending |\n`;
  }
writeFileSync("docs/capability-coverage.md", coverage);
console.log(
  Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.length])),
);
