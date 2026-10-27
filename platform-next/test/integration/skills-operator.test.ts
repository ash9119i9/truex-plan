import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ObjectId } from "mongodb";
import type { MongoMemoryReplSet } from "mongodb-memory-server";
import {
  parseOperatorCommand,
  runOperatorCommand,
  UsageError,
} from "../../src/cli/operator";
import { DomainError } from "../../src/common/domain-error";
import { DatabaseService } from "../../src/database/database.service";
import { AUDIT_COLLECTION, type AuditDoc } from "../../src/modules/audit/audit";
import { MemoryFileStore } from "../../src/modules/chats/chat-files";
import { OperatorService } from "../../src/modules/operator/operator.service";
import {
  SKILL_VERSIONS_COLLECTION,
  type SkillVersionDoc,
} from "../../src/modules/skills/skill";
import { SkillsService } from "../../src/modules/skills/skills.service";
import { resetOwnedData } from "../support/reset";
import {
  startApp,
  startReplicaSet,
  type RunningApp,
} from "../support/test-app";

function writeSkill(root: string, slug: string, body: string, extra = "") {
  const folder = join(root, slug);
  mkdirSync(join(folder, "references"), { recursive: true });
  writeFileSync(
    join(folder, "SKILL.md"),
    `---\nname: ${slug}\ndescription: Checks invoices.\n${extra}---\n${body}\n`,
  );
  writeFileSync(join(folder, "references", "rules.md"), "AP-01");
  return folder;
}

describe("skill catalog (operator)", () => {
  let mongo: MongoMemoryReplSet;
  let running: RunningApp;
  let database: DatabaseService;
  let operator: OperatorService;
  let skills: SkillsService;
  const store = new MemoryFileStore();

  before(async () => {
    mongo = await startReplicaSet();
    running = await startApp({
      mongodbUri: mongo.getUri(),
      files: { bucket: "b", region: "us-east-1", prefix: "", store },
    });
    database = running.app.get(DatabaseService);
    operator = running.app.get(OperatorService);
    skills = running.app.get(SkillsService);
  });

  after(async () => {
    await running?.close();
    await mongo?.stop();
  });

  beforeEach(async () => {
    await resetOwnedData(database);
    store.objects.clear();
    store.failPuts = null;
  });

  const put = (folder: string) =>
    operator.putSkill({ operator: "ops", folder, toolchain: new Set() });
  const versions = () =>
    database
      .catalog()
      .collection<SkillVersionDoc>(SKILL_VERSIONS_COLLECTION)
      .find({})
      .sort({ version: 1 })
      .toArray();
  const audit = () =>
    database
      .catalog()
      .collection<AuditDoc>(AUDIT_COLLECTION)
      .find({})
      .sort({ at: 1, _id: 1 })
      .toArray();

  test("publishes versions; unchanged content changes nothing", async () => {
    const root = mkdtempSync(join(tmpdir(), "skills-"));
    const folder = writeSkill(root, "invoice-check", "v1");
    const first = await put(folder);
    assert.equal(first.outcome, "created");
    assert.equal(first.skill.version, 1);
    assert.equal(first.skill.enabled, true);
    const key = `skills/${first.skill.id}/${first.skill.sha256}.tar.gz`;
    assert.equal(store.objects.get(key)?.contentType, "application/gzip");

    const again = await put(folder);
    assert.equal(again.outcome, "unchanged");
    assert.equal(again.skill.revision, 1);

    writeSkill(root, "invoice-check", "v2");
    const second = await put(folder);
    assert.equal(second.outcome, "updated");
    assert.equal(second.skill.version, 2);
    assert.equal(second.skill.id, first.skill.id);
    assert.notEqual(second.skill.sha256, first.skill.sha256);
    assert.equal(store.objects.size, 2);

    // Going back to v1's content makes v1 current again: no third version.
    writeSkill(root, "invoice-check", "v1");
    const back = await put(folder);
    assert.equal(back.outcome, "updated");
    assert.equal(back.skill.version, 1);
    assert.deepEqual(
      (await versions()).map((v) => v.version),
      [1, 2],
    );

    const events = await audit();
    assert.deepEqual(
      events.map((e) => [e.action, e.details?.outcome]),
      [
        ["skill.put", "created"],
        ["skill.put", "unchanged"],
        ["skill.put", "updated"],
        ["skill.put", "updated"],
      ],
    );
  });

  test("new chats snapshot the current version of enabled skills only", async () => {
    const root = mkdtempSync(join(tmpdir(), "skills-"));
    const a = await put(writeSkill(root, "alpha", "a"));
    const b = await put(writeSkill(root, "beta", "b"));
    const ids = [b.skill.id, a.skill.id].map((id) => new ObjectId(id));
    let snapshot = await skills.snapshot(ids);
    assert.deepEqual(
      snapshot.map((s) => s.slug),
      ["beta", "alpha"],
    );
    const archive = await skills.archive(snapshot[0]!);
    assert.equal(archive.length > 0, true);

    const disabled = await operator.setSkillEnabled({
      operator: "ops",
      slug: "beta",
      enabled: false,
    });
    assert.equal(disabled.changed, true);
    snapshot = await skills.snapshot(ids);
    assert.deepEqual(
      snapshot.map((s) => s.slug),
      ["alpha"],
    );
    const again = await operator.setSkillEnabled({
      operator: "ops",
      slug: "beta",
      enabled: false,
    });
    assert.equal(again.changed, false);
  });

  test("an archive that does not match its digest is never served", async () => {
    const root = mkdtempSync(join(tmpdir(), "skills-"));
    const { skill } = await put(writeSkill(root, "alpha", "a"));
    const key = `skills/${skill.id}/${skill.sha256}.tar.gz`;
    store.objects.set(key, {
      data: Buffer.from("tampered"),
      contentType: "application/gzip",
    });
    const [entry] = await skills.snapshot([new ObjectId(skill.id)]);
    await assert.rejects(skills.archive(entry!), /does not match/);
  });

  test("refusals are audited and leave nothing behind", async () => {
    const root = mkdtempSync(join(tmpdir(), "skills-"));
    await assert.rejects(
      put(writeSkill(root, "alpha", "a", "requires: pandas\n")),
      (error: unknown) =>
        error instanceof DomainError && /pandas/.test(error.message),
    );
    store.failPuts = new Error("S3 down");
    await assert.rejects(put(writeSkill(root, "beta", "b")), /S3 down/);
    assert.equal((await skills.listAll()).length, 0);
    assert.equal((await versions()).length, 0);
    assert.deepEqual(
      (await audit()).map((e) => [e.action, e.result]),
      [
        ["skill.put", "denied"],
        ["skill.put", "failed"],
      ],
    );
  });

  test("the CLI parses skill commands and lists skills", async () => {
    assert.deepEqual(
      parseOperatorCommand([
        "skill-put",
        "--operator",
        "ops",
        "--folder",
        "skills/alpha",
      ]),
      {
        command: "skill-put",
        operator: "ops",
        folder: "skills/alpha",
        toolchain: null,
      },
    );
    assert.deepEqual(
      parseOperatorCommand(["skill-disable", "--operator", "o", "--slug", "x"]),
      {
        command: "skill-set-enabled",
        operator: "o",
        slug: "x",
        enabled: false,
      },
    );
    assert.throws(
      () => parseOperatorCommand(["skill-put", "--operator", "o"]),
      UsageError,
    );
    const root = mkdtempSync(join(tmpdir(), "skills-"));
    await put(writeSkill(root, "alpha", "a"));
    const listed = (await runOperatorCommand(operator, {
      command: "skill-list",
      operator: "ops",
    })) as { skills: { slug: string; version: number }[] };
    assert.deepEqual(
      listed.skills.map((s) => [s.slug, s.version]),
      [["alpha", 1]],
    );
  });
});
