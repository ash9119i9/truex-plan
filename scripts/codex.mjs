import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
const lock = JSON.parse(
  readFileSync(new URL("../codex.lock.json", import.meta.url), "utf8"),
);
const root = resolve(new URL("..", import.meta.url).pathname);
const dir = resolve(root, lock.source);
const run = (cmd, args, cwd = root) =>
  execFileSync(cmd, args, { cwd, stdio: "inherit" });
if (!existsSync(resolve(dir, ".git"))) {
  mkdirSync(dir, { recursive: true });
  run("git", ["init", dir]);
  run("git", ["remote", "add", "origin", lock.repository], dir);
  run("git", ["fetch", "--depth", "1", "origin", lock.revision], dir);
  run("git", ["checkout", "--detach", lock.revision], dir);
}
const actual = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: dir,
  encoding: "utf8",
}).trim();
if (actual !== lock.revision)
  throw new Error(
    `Codex pin mismatch: expected ${lock.revision}, found ${actual}`,
  );
const dirty = execFileSync(
  "git",
  ["status", "--porcelain", "--untracked-files=no"],
  { cwd: dir, encoding: "utf8" },
).trim();
if (dirty)
  throw new Error(
    "Pinned Codex source has modifications; refusing an untracked build",
  );
if (process.argv.includes("--build")) {
  run(lock.build[0], lock.build.slice(1), resolve(dir, "codex-rs"));
  const hash = createHash("sha256")
    .update(readFileSync(resolve(root, lock.binary)))
    .digest("hex");
  mkdirSync(resolve(root, ".runtime"), { recursive: true });
  writeFileSync(
    resolve(root, ".runtime/codex-build.json"),
    JSON.stringify(
      {
        revision: actual,
        sha256: hash,
        binary: lock.binary,
        builtAt: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
  );
}
console.log(`Pinned Codex: ${actual}\nBinary: ${resolve(root, lock.binary)}`);
