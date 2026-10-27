import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkToolchain,
  configuredDirs,
  pinnedPackages,
} from "./toolchain.mjs";

const pins = [
  { name: "python-docx", version: "1.2.0" },
  { name: "pypdf", version: "6.21.2" },
];

const created = [];
after(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

function toolchainDir() {
  const dir = mkdtempSync(join(tmpdir(), "toolchain-test-"));
  created.push(dir);
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin", "python3"), "");
  return dir;
}

const found = (overrides = {}) => ({
  version: [3, 13, 5],
  prefix: "/opt/truex/python",
  basePrefix: "/usr",
  packages: { "python-docx": "1.2.0", pypdf: "6.21.2" },
  ...overrides,
});

test("requirements.in holds exact pins only", () => {
  const text = readFileSync(
    new URL("../runtime-adapter/toolchain/requirements.in", import.meta.url),
    "utf8",
  );
  assert.deepEqual(
    pinnedPackages(text).map(({ name }) => name),
    ["python-docx", "openpyxl", "python-pptx", "pypdf", "reportlab"],
  );
  assert.throws(() => pinnedPackages("pypdf>=6\n"), /not an exact pin/);
});

test("a complete toolchain has no problems", () => {
  const dir = toolchainDir();
  assert.deepEqual(checkToolchain([dir], { pins, run: () => found() }), []);
});

test("no configured Python is reported", () => {
  assert.match(checkToolchain([], { pins })[0], /lists no Python/);
  assert.match(
    checkToolchain(["/nonexistent"], { pins })[0],
    /No python3 in RUNTIME_TOOLCHAIN_DIRS/,
  );
});

test("missing, mismatched and old pieces are each reported", () => {
  const dir = toolchainDir();
  const problems = checkToolchain([dir], {
    pins,
    run: () =>
      found({
        version: [3, 9, 6],
        packages: { "python-docx": null, pypdf: "5.0.0" },
      }),
  });
  assert.equal(problems.length, 3);
  assert.match(problems[0], /Python 3\.9\.6; 3\.11 or later/);
  assert.match(problems[1], /python-docx is missing/);
  assert.match(problems[2], /pypdf is 5\.0\.0, pinned 6\.21\.2/);
});

test("a base interpreter the sandbox cannot read is reported unless listed", () => {
  const dir = toolchainDir();
  const run = () => found({ basePrefix: "/home/me/.pyenv/versions/3.13.5" });
  assert.match(
    checkToolchain([dir], { pins, run })[0],
    /sandbox cannot read; add it/,
  );
  assert.deepEqual(
    checkToolchain([dir, "/home/me/.pyenv/versions/3.13.5"], { pins, run }),
    [],
  );
});

test("a python3 that does not start is reported", () => {
  const dir = toolchainDir();
  const problems = checkToolchain([dir], {
    pins,
    run: () => {
      throw new Error("spawn EACCES");
    },
  });
  assert.match(problems[0], /does not run: spawn EACCES/);
});

test("RUNTIME_TOOLCHAIN_DIRS is read from the adapter's .env", () => {
  assert.deepEqual(
    configuredDirs("PORT=4400\nRUNTIME_TOOLCHAIN_DIRS=/a/python: /b \n"),
    ["/a/python", "/b"],
  );
  assert.deepEqual(configuredDirs("PORT=4400\n"), []);
});
