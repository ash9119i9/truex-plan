import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { DomainError } from "../../src/common/domain-error";
import {
  packSkillFolder,
  parseFrontmatter,
  toolchainPackages,
} from "../../src/modules/skills/skill-bundle";

const TOOLCHAIN = toolchainPackages(
  "# libs\npython-docx==1.2.0\nopenpyxl==3.1.5\n",
);

function skillFolder(
  slug: string,
  files: Record<string, string>,
  root = mkdtempSync(join(tmpdir(), "skill-")),
): string {
  const folder = join(root, slug);
  for (const [path, text] of Object.entries(files)) {
    const full = join(folder, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, text);
  }
  return folder;
}

const SKILL_MD = (extra = "") =>
  `---\nname: demo\ndescription: Does a demo thing.\n${extra}---\n\n# Demo\n`;

async function refuses(promise: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(
    promise,
    (error: unknown) =>
      error instanceof DomainError &&
      error.code === "INVALID_INPUT" &&
      pattern.test(error.message),
  );
}

describe("skill bundle packing", () => {
  test("packs the standard layout into a gzip ustar the system tar reads", async () => {
    const folder = skillFolder("demo", {
      "SKILL.md": SKILL_MD(
        "title: Demo skill\nrequires: python-docx, OpenPyXL\n",
      ),
      "references/notes.md": "notes",
      "scripts/run.py": "print(1)",
      "assets/template.txt": "t",
      ".DS_Store": "junk",
    });
    chmodSync(join(folder, "scripts/run.py"), 0o755);
    const bundle = await packSkillFolder(folder, { toolchain: TOOLCHAIN });
    assert.equal(bundle.slug, "demo");
    assert.equal(bundle.displayName, "Demo skill");
    assert.equal(bundle.description, "Does a demo thing.");
    assert.equal(bundle.fileCount, 4);
    assert.equal(bundle.hasScripts, true);
    assert.deepEqual(bundle.requires, { python: ["python-docx", "OpenPyXL"] });
    assert.match(bundle.sha256, /^[0-9a-f]{64}$/);

    const out = mkdtempSync(join(tmpdir(), "skill-out-"));
    const archive = join(out, "a.tar.gz");
    writeFileSync(archive, bundle.archive);
    const listing = execFileSync("tar", ["-tzvf", archive], {
      encoding: "utf8",
    });
    assert.match(listing, /demo\/SKILL\.md/);
    assert.match(listing, /rwxr-xr-x.*demo\/scripts\/run\.py/);
    assert.doesNotMatch(listing, /DS_Store/);
    execFileSync("tar", ["-xzf", archive, "-C", out]);
    // Parents come before children (the adapter's unpacker relies on it).
    const names = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })
      .trim()
      .split("\n");
    assert.equal(names[0], "demo");
    assert.ok(
      names.indexOf("demo/scripts") < names.indexOf("demo/scripts/run.py"),
    );
  });

  test("the same folder always packs to the same bytes", async () => {
    const files = { "SKILL.md": SKILL_MD(), "references/a.md": "a" };
    const one = await packSkillFolder(skillFolder("demo", files), {
      toolchain: null,
    });
    const two = await packSkillFolder(skillFolder("demo", files), {
      toolchain: null,
    });
    assert.equal(one.sha256, two.sha256);
    // No timestamps or owners in the headers.
    const tar = gunzipSync(one.archive);
    assert.equal(tar.subarray(136, 147).toString("latin1"), "00000000000");
  });

  test("defaults the title from the slug and has no scripts", async () => {
    const folder = skillFolder("invoice-check", {
      "SKILL.md": "---\nname: invoice-check\ndescription: d\n---\n",
    });
    const bundle = await packSkillFolder(folder, { toolchain: null });
    assert.equal(bundle.displayName, "Invoice check");
    assert.equal(bundle.hasScripts, false);
  });

  test("refuses folders that are not skills", async () => {
    await refuses(
      packSkillFolder(skillFolder("Demo", { "SKILL.md": SKILL_MD() }), {
        toolchain: null,
      }),
      /named by its slug/,
    );
    await refuses(
      packSkillFolder(skillFolder("demo", { "notes.md": "x" }), {
        toolchain: null,
      }),
      /not part of a skill/,
    );
    await refuses(
      packSkillFolder(skillFolder("demo", { "references/a.md": "x" }), {
        toolchain: null,
      }),
      /needs a SKILL\.md/,
    );
    await refuses(
      packSkillFolder(
        skillFolder("demo", {
          "SKILL.md": SKILL_MD(),
          "references/.env": "SECRET=1",
        }),
        { toolchain: null },
      ),
      /not a plain file name/,
    );
    await refuses(
      packSkillFolder(
        skillFolder("other", {
          "SKILL.md": SKILL_MD(),
        }),
        { toolchain: null },
      ),
      /must be the folder name/,
    );
  });

  test("refuses links, so a bundle never reads outside its folder", async () => {
    const folder = skillFolder("demo", { "SKILL.md": SKILL_MD() });
    mkdirSync(join(folder, "references"));
    symlinkSync(resolve("/etc/hosts"), join(folder, "references/hosts"));
    await refuses(
      packSkillFolder(folder, { toolchain: null }),
      /link or special file/,
    );
  });

  test("refuses requires the runtime image does not ship", async () => {
    const folder = skillFolder("demo", {
      "SKILL.md": SKILL_MD("requires: pandas\n"),
    });
    await refuses(
      packSkillFolder(folder, { toolchain: TOOLCHAIN }),
      /does not ship the Python package "pandas"/,
    );
    await refuses(
      packSkillFolder(folder, { toolchain: null }),
      /toolchain list was not found/,
    );
  });

  test("refuses oversize bundles", async () => {
    const big = Array.from({ length: 30 }, (_, i) => [
      `assets/${i}.bin`,
      "x".repeat(1024 * 1024),
    ]);
    const folder = skillFolder("demo", {
      "SKILL.md": SKILL_MD(),
      ...Object.fromEntries(big),
    });
    await refuses(
      packSkillFolder(folder, { toolchain: null }),
      /larger than 25 MB/,
    );
  });
});

describe("SKILL.md frontmatter", () => {
  test("reads plain and quoted one-line values, ignoring other keys", () => {
    const meta = parseFrontmatter(
      '---\nname: demo\ndescription: "Checks a: thing"\nlicense: MIT\nmetadata:\n  a: b\n---\nbody',
    );
    assert.deepEqual(meta, {
      name: "demo",
      description: "Checks a: thing",
      requires: [],
    });
  });

  test("refuses values YAML would read differently", () => {
    for (const text of [
      "name: demo\ndescription: |\n  block",
      "name: demo\ndescription: has: colon",
      "name: demo\ndescription: has #comment",
      "name: demo\nname: again\ndescription: d",
      "name: demo\ndescription: d\nrequires: bad name",
      "name: demo\ndescription: d\nrequires: a, A",
      "name: Demo\ndescription: d",
      "name: demo",
    ])
      assert.throws(
        () => parseFrontmatter(`---\n${text}\n---\n`),
        (error: unknown) => error instanceof DomainError,
        text,
      );
    assert.throws(() => parseFrontmatter("# no frontmatter"), DomainError);
    assert.throws(() => parseFrontmatter("---\nname: demo\n"), DomainError);
  });

  test("normalizes toolchain package names", () => {
    assert.deepEqual(
      [...toolchainPackages("python_docx==1\n# c\nPyPDF[extra]>=2\n\n")],
      ["python-docx", "pypdf"],
    );
  });
});
