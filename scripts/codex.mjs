import {
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  mkdtempSync,
  copyFileSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
const lock = JSON.parse(
  readFileSync(new URL("../codex.lock.json", import.meta.url), "utf8"),
);
const root = resolve(new URL("..", import.meta.url).pathname);
const dir = resolve(root, lock.source);
const run = (cmd, args, cwd = root) =>
  execFileSync(cmd, args, { cwd, stdio: "inherit" });
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const recordPath = resolve(root, ".runtime/codex-build.json");

if (process.argv.includes("--download") || process.argv.includes("--verify")) {
  const { release } = lock;
  const hostArch = { x64: "x86_64", arm64: "aarch64" }[process.arch];
  const override = process.argv
    .find((arg) => arg.startsWith("--target="))
    ?.slice("--target=".length);
  if (!override && (process.platform !== "linux" || !hostArch))
    throw new Error(
      `No prebuilt Codex for ${process.platform}/${process.arch}; use --build`,
    );
  const target = override ?? `${hostArch}-unknown-linux-musl`;
  const canRun = target === `${hostArch}-unknown-linux-musl`;
  const archiveSha = release.assets[target];
  if (!archiveSha) throw new Error(`No pinned checksum for ${target}`);
  const binary = resolve(root, lock.binary);
  const readRecord = () =>
    existsSync(recordPath) ? JSON.parse(readFileSync(recordPath, "utf8")) : {};
  const isCurrent = () => {
    const record = readRecord();
    return (
      existsSync(binary) &&
      record.tag === release.tag &&
      record.target === target &&
      record.sha256 === sha256(readFileSync(binary))
    );
  };
  if (process.argv.includes("--download") && !isCurrent()) {
    const asset = `codex-${target}`;
    const url = `https://github.com/${release.repository}/releases/download/${release.tag}/${asset}.tar.gz`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed: ${res.status} ${url}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (sha256(bytes) !== archiveSha)
      throw new Error(`Checksum mismatch for ${url}`);
    const tmp = mkdtempSync(resolve(tmpdir(), "codex-"));
    try {
      const archive = resolve(tmp, `${asset}.tar.gz`);
      writeFileSync(archive, bytes);
      run("tar", ["-xzf", archive, "-C", tmp, asset]);
      mkdirSync(dirname(binary), { recursive: true });
      copyFileSync(resolve(tmp, asset), binary);
      chmodSync(binary, 0o755);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    mkdirSync(dirname(recordPath), { recursive: true });
    writeFileSync(
      recordPath,
      JSON.stringify(
        {
          tag: release.tag,
          target,
          sha256: sha256(readFileSync(binary)),
          binary: lock.binary,
          downloadedAt: new Date().toISOString(),
        },
        null,
        2,
      ) + "\n",
    );
  }
  if (!isCurrent())
    throw new Error(
      `${lock.binary} is missing or does not match ${release.tag}; run npm run codex:setup`,
    );
  const version = canRun
    ? execFileSync(binary, ["--version"], { encoding: "utf8" }).trim()
    : `(not run: ${target} binary on ${process.arch} host)`;
  console.log(
    `Codex ${release.tag} (${target})\n${version}\nBinary: ${binary}`,
  );
  process.exit(0);
}

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
