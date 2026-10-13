// Fails when a tracked root-level configuration file (models.json, mcps.json,
// agent.json, ...) holds what looks like a credential instead of a reference.
//
//   npm run check:secrets
//
// A credential field must be empty, a "${ENV_NAME}" reference or an angle-
// bracket placeholder such as "<set through Connected tools>". Values are never
// printed: a finding names only the file, line and field.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const credentialField =
  /(?:^|[\s{,"'])(api[_-]?key|apikey|access[_-]?token|auth[_-]?token|bearer[_-]?token|client[_-]?secret|secret|password|token|authorization)["']?\s*[:=]\s*(["'`])((?:\\.|(?!\2).)*)\2/gi;
const knownTokens =
  /(sk-[A-Za-z0-9_-]{20,}|nvapi-[A-Za-z0-9_-]{10,}|AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})/;
const ignored = new Set([
  "package.json",
  "package-lock.json",
  "codex.lock.json",
  "tsconfig.json",
]);

/** A value that carries no credential. */
export function isSafeValue(value) {
  const text = value.trim();
  return (
    text === "" ||
    /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(text) ||
    /^<[^<>]*>$/.test(text)
  );
}

/** Findings as { line, field } for one file's text; values are never returned. */
export function findCredentials(text) {
  const findings = [];
  text.split("\n").forEach((content, index) => {
    const line = index + 1;
    for (const match of content.matchAll(credentialField))
      if (!isSafeValue(match[3])) findings.push({ line, field: match[1] });
    if (knownTokens.test(content) && !findings.some((f) => f.line === line))
      findings.push({ line, field: "credential-like token" });
  });
  return findings;
}

export function trackedConfigFiles() {
  return execFileSync("git", ["ls-files", "-z", "--", "*.json"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter((file) => file && !file.includes("/") && !ignored.has(file));
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  let failed = false;
  for (const file of trackedConfigFiles())
    for (const { line, field } of findCredentials(
      readFileSync(resolve(root, file), "utf8"),
    )) {
      failed = true;
      console.error(
        `${file}:${line}: ${field} holds a credential. Use "\${ENV_NAME}" and set the variable in your environment.`,
      );
    }
  if (failed) process.exit(1);
  console.log("No credentials found in tracked root configuration files.");
}
