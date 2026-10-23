import assert from "node:assert/strict";
import {
  appendFile,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { after, before, describe, test } from "node:test";
import { loadConfig } from "../../src/config";
import { parseStartRun } from "../../src/contract";
import { AdapterError } from "../../src/errors";
import {
  linkSkills,
  MAX_SKILL_ARCHIVE_BYTES,
  missingSkills,
  skillRoot,
  skillsRoot,
  writeSkill,
} from "../../src/runtime/skills";
import { SkillUseWatcher, skillRead } from "../../src/runtime/skill-use";
import {
  archiveOf,
  sampleSkill,
  sha256,
  tarOf,
  type ArchiveEntry,
} from "../support/skill-archive";

async function refused(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof AdapterError, String(error));
    assert.equal(error.code, code);
    return true;
  });
}

const body = (data: Buffer) => Readable.from([data]);

describe("skill bundles", () => {
  let state = "";
  before(async () => {
    state = await mkdtemp(join(tmpdir(), "adapter-skills-"));
  });
  after(() => rm(state, { recursive: true, force: true }));

  test("archived setuid, setgid, sticky and world bits never reach disk", async () => {
    const archive = gzipSync(
      tarOf([
        { path: "modes/", type: "5", mode: 0o1777 },
        {
          path: "modes/SKILL.md",
          data: "---\nname: modes\ndescription: d\n---\n",
          mode: 0o6777,
        },
        { path: "modes/scripts/", type: "5", mode: 0o3777 },
        { path: "modes/scripts/run.sh", data: "echo hi\n", mode: 0o4755 },
      ]),
    );
    const digest = sha256(archive);
    await writeSkill(state, digest, body(archive));
    const dir = join(skillRoot(state, digest), "modes");
    const modeOf = async (path: string) => (await stat(path)).mode & 0o7777;
    assert.equal(await modeOf(dir), 0o700);
    assert.equal(await modeOf(join(dir, "scripts")), 0o700);
    assert.equal(await modeOf(join(dir, "SKILL.md")), 0o700);
    assert.equal(await modeOf(join(dir, "scripts", "run.sh")), 0o700);
  });

  test("unpacks one archive by digest, keeps the script executable, and repeats as a no-op", async () => {
    const archive = sampleSkill();
    const digest = sha256(archive);
    assert.deepEqual(await writeSkill(state, digest, body(archive)), {
      slug: "po-check",
      created: true,
    });
    const dir = join(skillRoot(state, digest), "po-check");
    assert.match(
      await readFile(join(dir, "SKILL.md"), "utf8"),
      /BODY-po-check/,
    );
    assert.equal(
      await readFile(join(dir, "references", "detail.md"), "utf8"),
      "REFERENCE-BODY-po-check",
    );
    assert.ok((await stat(join(dir, "scripts", "hello.sh"))).mode & 0o100);
    assert.equal((await stat(join(dir, "SKILL.md"))).mode & 0o100, 0);
    assert.deepEqual(await writeSkill(state, digest, body(archive)), {
      slug: "po-check",
      created: false,
    });
    // No temporary directories are left behind.
    assert.deepEqual(
      (await readdir(skillsRoot(state))).filter((n) => n.startsWith(".")),
      [],
    );
  });

  test("two concurrent writes of the same digest both succeed", async () => {
    const archive = sampleSkill("gl-close", "Month-end close.");
    const digest = sha256(archive);
    const results = await Promise.all([
      writeSkill(state, digest, body(archive)),
      writeSkill(state, digest, body(archive)),
      writeSkill(state, digest, body(archive)),
    ]);
    assert.equal(results.filter((r) => r.created).length, 1);
    assert.ok(results.every((r) => r.slug === "gl-close"));
  });

  test("missingSkills reports skills not unpacked, or under another slug", async () => {
    const archive = sampleSkill();
    const digest = sha256(archive);
    await writeSkill(state, digest, body(archive));
    const absent = "a".repeat(64);
    assert.deepEqual(
      await missingSkills(state, [
        { sha256: digest, slug: "po-check" },
        { sha256: absent, slug: "other" },
        { sha256: digest, slug: "wrong-slug" },
      ]),
      [
        { sha256: absent, slug: "other" },
        { sha256: digest, slug: "wrong-slug" },
      ],
    );
  });

  test("linkSkills names each skill by its slug, relatively, and keeps only the current set", async () => {
    const po = sampleSkill();
    const gl = sampleSkill("gl-close", "Month-end close.");
    await writeSkill(state, sha256(po), body(po));
    await writeSkill(state, sha256(gl), body(gl));
    const dir = join(state, "t", "tenant1", "c", "chat1", "skills");
    await linkSkills(state, dir, [
      { sha256: sha256(po), slug: "po-check" },
      { sha256: sha256(gl), slug: "gl-close" },
    ]);
    assert.deepEqual((await readdir(dir)).sort(), ["gl-close", "po-check"]);
    const target = await readlink(join(dir, "po-check"));
    assert.ok(!target.startsWith("/"), target);
    assert.ok(!target.includes(state), "no state path in the link");
    assert.match(
      await readFile(join(dir, "po-check", "SKILL.md"), "utf8"),
      /BODY-po-check/,
    );
    // A later run with fewer skills leaves only its own links.
    await linkSkills(state, dir, [{ sha256: sha256(gl), slug: "gl-close" }]);
    assert.deepEqual(await readdir(dir), ["gl-close"]);
    assert.deepEqual(
      (await readdir(join(dir, ".."))).filter((n) => n !== "skills"),
      [],
      "no temporary directories are left behind",
    );
    await refused(
      linkSkills(state, dir, [{ sha256: sha256(gl), slug: "../x" }]),
      "INVALID_REQUEST",
    );
    assert.deepEqual(
      await readdir(dir),
      ["gl-close"],
      "a refusal keeps the old links",
    );
  });

  test("refuses a digest mismatch and a malformed digest", async () => {
    const archive = sampleSkill();
    await refused(
      writeSkill(state, "b".repeat(64), body(archive)),
      "INVALID_REQUEST",
    );
    await refused(writeSkill(state, "../x", body(archive)), "INVALID_REQUEST");
    await refused(
      writeSkill(state, "A".repeat(64), body(archive)),
      "INVALID_REQUEST",
    );
  });

  test("refuses an archive over the byte limit", async () => {
    const big = Buffer.alloc(MAX_SKILL_ARCHIVE_BYTES + 1);
    await refused(
      writeSkill(state, sha256(big), body(big)),
      "PAYLOAD_TOO_LARGE",
    );
  });

  test("refuses a decompression bomb", async () => {
    const bomb = gzipSync(
      tarOf([
        { path: "bomb", type: "5" },
        { path: "bomb/SKILL.md", data: "x" },
        { path: "bomb/big", data: Buffer.alloc(26 * 1024 * 1024) },
      ]),
    );
    assert.ok(bomb.length < MAX_SKILL_ARCHIVE_BYTES);
    await refused(
      writeSkill(state, sha256(bomb), body(bomb)),
      "INVALID_REQUEST",
    );
  });

  const bad: Array<[string, ArchiveEntry[]]> = [
    [
      "a symlink",
      [
        { path: "s", type: "5" },
        { path: "s/SKILL.md", data: "x" },
        { path: "s/link", type: "2", linkName: "/etc/passwd" },
      ],
    ],
    [
      "a hard link",
      [
        { path: "s", type: "5" },
        { path: "s/SKILL.md", data: "x" },
        { path: "s/link", type: "1", linkName: "s/SKILL.md" },
      ],
    ],
    [
      "a .. segment",
      [
        { path: "s", type: "5" },
        { path: "s/SKILL.md", data: "x" },
        { path: "s/../escape", data: "x" },
      ],
    ],
    [
      "an absolute path",
      [
        { path: "/s", type: "5" },
        { path: "/s/SKILL.md", data: "x" },
      ],
    ],
    [
      "two top-level directories",
      [
        { path: "s", type: "5" },
        { path: "s/SKILL.md", data: "x" },
        { path: "t", type: "5" },
      ],
    ],
    ["a top-level file", [{ path: "SKILL.md", data: "x" }]],
    [
      "no SKILL.md",
      [
        { path: "s", type: "5" },
        { path: "s/README.md", data: "x" },
      ],
    ],
    [
      "a file before its directory",
      [
        { path: "s", type: "5" },
        { path: "s/SKILL.md", data: "x" },
        { path: "s/refs/a.md", data: "x" },
      ],
    ],
    [
      "a duplicate path",
      [
        { path: "s", type: "5" },
        { path: "s/SKILL.md", data: "x" },
        { path: "s/SKILL.md", data: "y" },
      ],
    ],
    [
      "an uppercase slug",
      [
        { path: "Skill", type: "5" },
        { path: "Skill/SKILL.md", data: "x" },
      ],
    ],
    [
      "a control character",
      [
        { path: "s", type: "5" },
        { path: "s/SKILL.md", data: "x" },
        { path: "s/a\u0001b", data: "x" },
      ],
    ],
  ];
  for (const [what, entries] of bad)
    test(`refuses ${what} and leaves nothing behind`, async () => {
      const archive = archiveOf(entries);
      const digest = sha256(archive);
      await refused(
        writeSkill(state, digest, body(archive)),
        "INVALID_REQUEST",
      );
      await assert.rejects(stat(skillRoot(state, digest)));
    });

  test("refuses bytes that are not gzip", async () => {
    const plain = Buffer.from("not an archive");
    await refused(
      writeSkill(state, sha256(plain), body(plain)),
      "INVALID_REQUEST",
    );
  });
});

describe("run request skills", () => {
  const { limits } = loadConfig({
    RUNTIME_ADAPTER_TOKEN: "t".repeat(32),
    RUNTIME_STATE_DIR: tmpdir(),
  });
  const base = {
    runId: "run1",
    tenantId: "t1",
    chatId: "c1",
    threadId: null,
    input: { text: "hi", clientMessageId: "m1" },
    agentPrompt: "You help.",
    model: {
      modelName: "m",
      gatewayUrl: "http://127.0.0.1:1/v1",
      gatewayToken: "x".repeat(32),
      contextWindow: 100_000,
      autoCompactTokenLimit: 80_000,
    },
  };
  const skill = (slug: string, digest = "c".repeat(64)) => ({
    sha256: digest,
    slug,
  });

  test("accepts up to ten skills and keeps them in order", () => {
    const skills = Array.from({ length: 10 }, (_, i) =>
      skill(`s${i}`, String(i).repeat(64)),
    );
    assert.deepEqual(parseStartRun({ ...base, skills }, limits).skills, skills);
    assert.equal(parseStartRun(base, limits).skills, undefined);
  });

  for (const [what, skills] of [
    ["eleven skills", Array.from({ length: 11 }, (_, i) => skill(`s${i}`))],
    ["a bad digest", [skill("a", "z".repeat(64))]],
    ["a bad slug", [skill("A b")]],
    ["a slug twice", [skill("a", "1".repeat(64)), skill("a", "2".repeat(64))]],
    ["an unknown field", [{ ...skill("a"), path: "/etc" }]],
    ["a non-list", { sha256: "c".repeat(64), slug: "a" }],
  ] as const)
    test(`refuses ${what}`, () => {
      assert.throws(
        () => parseStartRun({ ...base, skills }, limits),
        (error: unknown) =>
          error instanceof AdapterError && error.code === "INVALID_REQUEST",
      );
    });
});

// One rollout line for a function call, as Codex writes it.
function call(name: string, namespace: string | undefined, args: unknown) {
  return JSON.stringify({
    timestamp: "2026-10-23T09:06:57.001Z",
    type: "response_item",
    payload: {
      type: "function_call",
      name,
      ...(namespace ? { namespace } : {}),
      arguments: typeof args === "string" ? args : JSON.stringify(args),
      call_id: "call_1",
    },
  });
}

describe("skill use from the rollout", () => {
  test("skillRead takes the slug from a skills.read package only", () => {
    assert.equal(
      skillRead(call("read", "skills", { package: "e0/po-check" })),
      "po-check",
    );
    assert.equal(
      skillRead(call("read", "skills", { package: "po-check" })),
      "po-check",
    );
    assert.equal(
      skillRead(
        call("read", "skills", {
          package: "e0/po-check",
          resource: "skill://x/y",
        }),
      ),
      "po-check",
    );
    for (const line of [
      call("list", "skills", {}),
      call("read", "other", { package: "e0/po-check" }),
      call("read", "skills", "{not json"),
      call("read", "skills", { package: 7 }),
      call("read", "skills", null),
      '{"type":"response_item","namespace":"skills"', // cut short
      JSON.stringify({ type: "event_msg", payload: { namespace: "skills" } }),
      "",
    ])
      assert.equal(skillRead(line), undefined, line);
  });

  test("reports each known slug once, only from lines appended after begin", async () => {
    const dir = await mkdtemp(join(tmpdir(), "adapter-rollout-"));
    const path = join(dir, "rollout.jsonl");
    try {
      // An earlier turn's read.
      await writeFile(
        path,
        call("read", "skills", { package: "e0/po-check" }) + "\n",
      );
      const used: string[] = [];
      const watcher = new SkillUseWatcher(
        path,
        new Set(["po-check", "gl-close"]),
        (slug) => used.push(slug),
      );
      await watcher.begin();
      await watcher.poll();
      assert.deepEqual(used, []);

      // A line split across two polls is read once whole.
      const line = call("read", "skills", { package: "e0/gl-close" });
      await appendFile(path, line.slice(0, 40));
      await watcher.poll();
      assert.deepEqual(used, []);
      await appendFile(
        path,
        line.slice(40) +
          "\n" +
          call("read", "skills", { package: "e0/gl-close" }) +
          "\n" +
          call("read", "skills", { package: "e0/not-ours" }) +
          "\n" +
          call("read", "skills", { package: "e0/po-check" }) +
          "\n",
      );
      await Promise.all([watcher.poll(), watcher.poll()]);
      assert.deepEqual(used, ["gl-close", "po-check"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a missing or truncated rollout reports nothing and recovers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "adapter-rollout-"));
    const path = join(dir, "rollout.jsonl");
    try {
      const used: string[] = [];
      const watcher = new SkillUseWatcher(path, new Set(["po-check"]), (slug) =>
        used.push(slug),
      );
      await watcher.begin(); // file absent: offset 0
      await watcher.poll();
      await writeFile(path, "x".repeat(500) + "\n");
      await watcher.poll();
      await writeFile(path, "y\n"); // replaced by a shorter file
      await watcher.poll();
      await appendFile(
        path,
        call("read", "skills", { package: "po-check" }) + "\n",
      );
      await watcher.poll();
      assert.deepEqual(used, ["po-check"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
