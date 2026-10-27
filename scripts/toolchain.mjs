// The Python toolchain coding runs use (runtime-adapter coding profile):
// Python 3 with the pinned document libraries in
// runtime-adapter/toolchain/requirements.txt.
//
//   node scripts/toolchain.mjs setup [--python <python3>]
//     Creates .runtime/toolchain/python, a virtual environment holding exactly
//     the pinned, hash-checked wheels, and prints the RUNTIME_TOOLCHAIN_DIRS
//     line for runtime-adapter/.env.
//   node scripts/toolchain.mjs check
//     Reports what the toolchains listed in runtime-adapter/.env lack.
//
// The container image builds the same environment at /opt/truex/python
// (Dockerfile, `toolchain` stage).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REQUIREMENTS = join(ROOT, "runtime-adapter", "toolchain");
export const DEFAULT_DIR = join(ROOT, ".runtime", "toolchain", "python");
const MIN_PYTHON = [3, 11];

// Prefixes the sandbox reads without being told (Codex's minimal set, and on
// macOS the directories the adapter adds itself; runtime-adapter
// src/codex/coding.ts). A base interpreter anywhere else, such as one under
// the home directory, has to be listed in RUNTIME_TOOLCHAIN_DIRS as well.
const SYSTEM_PREFIXES = [
  "/usr/",
  "/System/",
  "/Library/Developer/CommandLineTools/",
  "/opt/homebrew/",
];

// The direct pins, `name==version`, from requirements.in.
export function pinnedPackages(text) {
  const pins = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const match = /^([A-Za-z0-9._-]+)==([A-Za-z0-9.+!-]+)$/.exec(line);
    if (!match) throw new Error(`requirements.in: not an exact pin: ${line}`);
    pins.push({ name: match[1], version: match[2] });
  }
  return pins;
}

// Prints JSON: the interpreter's version and prefixes, and the installed
// version of each package asked for (null when missing).
const PROBE = `
import json, sys
from importlib import metadata
def version(name):
    try:
        return metadata.version(name)
    except metadata.PackageNotFoundError:
        return None
print(json.dumps({
    "version": list(sys.version_info[:3]),
    "prefix": sys.prefix,
    "basePrefix": sys.base_prefix,
    "packages": {name: version(name) for name in sys.argv[1:]},
}))
`;

function probe(python, names) {
  return JSON.parse(
    execFileSync(python, ["-I", "-c", PROBE, ...names], {
      encoding: "utf8",
      timeout: 30_000,
    }),
  );
}

// What the adapter's commands would lack, given the toolchain directories it
// is configured with. Commands find `python3` in the first listed directory
// that has one; an empty list means coding runs fall back to whatever system
// Python exists, without the libraries.
export function checkToolchain(dirs, { pins = readPins(), run = probe } = {}) {
  const dir = dirs.find((d) => existsSync(join(d, "bin", "python3")));
  if (!dir)
    return [
      dirs.length
        ? `No python3 in RUNTIME_TOOLCHAIN_DIRS (${dirs.join(":")}).`
        : "RUNTIME_TOOLCHAIN_DIRS lists no Python toolchain.",
    ];
  let found;
  try {
    found = run(
      join(dir, "bin", "python3"),
      pins.map(({ name }) => name),
    );
  } catch (error) {
    return [`${dir}/bin/python3 does not run: ${error.message.split("\n")[0]}`];
  }
  const problems = [];
  if (compare(found.version, MIN_PYTHON) < 0)
    problems.push(
      `${dir} has Python ${found.version.join(".")}; ${MIN_PYTHON.join(".")} or later is needed.`,
    );
  const base = found.basePrefix.endsWith(sep)
    ? found.basePrefix
    : found.basePrefix + sep;
  if (
    !SYSTEM_PREFIXES.some((prefix) => base.startsWith(prefix)) &&
    !dirs.some((d) => base.startsWith(d.endsWith(sep) ? d : d + sep))
  )
    problems.push(
      `${dir} runs Python from ${found.basePrefix}, which the sandbox cannot read; add it to RUNTIME_TOOLCHAIN_DIRS.`,
    );
  for (const { name, version } of pins) {
    const installed = found.packages[name];
    if (installed === null) problems.push(`${dir}: ${name} is missing.`);
    else if (installed !== version)
      problems.push(`${dir}: ${name} is ${installed}, pinned ${version}.`);
  }
  return problems;
}

function compare(a, b) {
  for (let i = 0; i < b.length; i++)
    if ((a[i] ?? 0) !== b[i]) return (a[i] ?? 0) - b[i];
  return 0;
}

function readPins() {
  return pinnedPackages(
    readFileSync(join(REQUIREMENTS, "requirements.in"), "utf8"),
  );
}

// RUNTIME_TOOLCHAIN_DIRS from runtime-adapter/.env, as the adapter reads it.
export function configuredDirs(envText) {
  return (parseEnv(envText).RUNTIME_TOOLCHAIN_DIRS ?? "")
    .split(":")
    .map((dir) => dir.trim())
    .filter(Boolean);
}

function setup(basePython) {
  const base = probe(basePython, []);
  if (compare(base.version, MIN_PYTHON) < 0)
    throw new Error(
      `${basePython} is Python ${base.version.join(".")}; ${MIN_PYTHON.join(".")} or later is needed (pass --python).`,
    );
  // Only this script writes here, so a rebuild starts from nothing.
  rmSync(DEFAULT_DIR, { recursive: true, force: true });
  execFileSync(basePython, ["-m", "venv", DEFAULT_DIR], { stdio: "inherit" });
  execFileSync(
    join(DEFAULT_DIR, "bin", "python3"),
    [
      "-m",
      "pip",
      "install",
      "--disable-pip-version-check",
      "--no-input",
      "--require-hashes",
      "--only-binary=:all:",
      "--no-deps",
      "-r",
      join(REQUIREMENTS, "requirements.txt"),
    ],
    { stdio: "inherit" },
  );
  const created = probe(join(DEFAULT_DIR, "bin", "python3"), []);
  const dirs = [DEFAULT_DIR];
  const basePrefix = created.basePrefix + sep;
  if (!SYSTEM_PREFIXES.some((prefix) => basePrefix.startsWith(prefix)))
    dirs.push(created.basePrefix);
  const problems = checkToolchain(dirs);
  if (problems.length) throw new Error(problems.join("\n"));
  console.log(
    [
      "",
      `Python ${created.version.join(".")} toolchain ready in ${DEFAULT_DIR}.`,
      "Set this in runtime-adapter/.env and restart the adapter:",
      `RUNTIME_TOOLCHAIN_DIRS=${dirs.join(":")}`,
    ].join("\n"),
  );
}

function main(args) {
  const [command, ...rest] = args;
  if (command === "setup") {
    const flag = rest.indexOf("--python");
    if (flag >= 0 && !rest[flag + 1])
      throw new Error("--python needs the path of a python3 to build from.");
    setup(flag >= 0 ? rest[flag + 1] : process.env.PYTHON || "python3");
    return;
  }
  if (command === "check") {
    const file = join(ROOT, "runtime-adapter", ".env");
    const dirs = existsSync(file)
      ? configuredDirs(readFileSync(file, "utf8"))
      : [];
    const problems = checkToolchain(dirs);
    for (const problem of problems) console.error(problem);
    if (problems.length) {
      console.error("Run npm run toolchain:setup to create the toolchain.");
      process.exitCode = 1;
    } else console.log(`Toolchain OK: ${dirs.join(":")}`);
    return;
  }
  console.error(
    "Usage: node scripts/toolchain.mjs setup [--python <python3>] | check",
  );
  process.exitCode = 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
