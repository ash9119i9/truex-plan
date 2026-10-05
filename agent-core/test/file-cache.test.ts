import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Document, Packer, Paragraph } from "docx";
import { ConversationFiles } from "../src/file-tools";
import { sweepWorkspaces } from "../src/workspace-sweeper";

async function fixture(t: any) {
  const previous = process.env.CACHE_RUNTIME_METADATA;
  process.env.CACHE_RUNTIME_METADATA = "on";
  const root = await mkdtemp(join(tmpdir(), "truex-file-cache-"));
  t.after(async () => {
    if (previous === undefined) delete process.env.CACHE_RUNTIME_METADATA;
    else process.env.CACHE_RUNTIME_METADATA = previous;
    await rm(root, { recursive: true, force: true });
  });
  return { root, files: new ConversationFiles((id) => join(root, id)) };
}

test("cached file lists remain isolated and detect writes, corrupt metadata and cleanup", async (t) => {
  const { root, files } = await fixture(t);
  const a = await files.publish("a", "one.txt", Buffer.from("first"));
  const first = await files.list("a");
  first[0].name = "mutated.txt";
  assert.equal((await files.list("a"))[0].name, "one.txt");
  assert.deepEqual(await files.list("b"), []);
  await files.publish("a", "two.txt", Buffer.from("second"));
  assert.equal((await files.list("a")).length, 2);
  await writeFile(join(root, "a", "files", a.id + ".json"), "{corrupt");
  await assert.rejects(files.list("a"), SyntaxError);
  await rm(join(root, "a"), { recursive: true });
  assert.deepEqual(await files.list("a"), []);
  await assert.rejects(files.read("a", a.id), /not found/);
});

test("quota admission bypasses a warm list including concurrent writers and copied files", async (t) => {
  const { root, files } = await fixture(t);
  await files.list("a");
  const dir = join(root, "a", "files");
  // Simulate an external restore after an empty list has been cached.
  await Promise.all(
    Array.from({ length: 49 }, async () => {
      const id = randomUUID();
      await writeFile(
        join(dir, id + ".json"),
        JSON.stringify({
          id,
          name: "restored.txt",
          size: 1,
          mediaType: "text/plain",
          createdAt: new Date().toISOString(),
        }),
      );
    }),
  );
  const results = await Promise.allSettled([
    files.publish("a", "last.txt", Buffer.from("a")),
    files.publish("a", "overflow.txt", Buffer.from("b")),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);
  assert.equal((await files.list("a")).length, 50);
  await files.copy("a", "fork");
  await assert.rejects(
    files.publish("fork", "overflow.txt", Buffer.from("b")),
    /limit reached/,
  );
  assert.equal((await files.list("fork")).length, 50);
});

test("parsed document cache checks authoritative bytes and editable source on every hit", async (t) => {
  const { root, files } = await fixture(t);
  const make = (value: string) =>
    Packer.toBuffer(
      new Document({ sections: [{ children: [new Paragraph(value)] }] }),
    );
  const original = await make("Original extracted document");
  const file = await files.upload(
    "a",
    "report.docx",
    original.toString("base64"),
  );
  assert.match((await files.read("a", file.id)).text, /Original/);
  assert.match((await files.read("a", file.id)).text, /Original/);
  const bin = join(root, "a", "files", file.id + ".bin");
  await writeFile(bin, await make("Restored extracted document"));
  assert.match((await files.read("a", file.id)).text, /Restored/);
  await writeFile(bin, "corrupt Office binary");
  await assert.rejects(files.read("a", file.id));
  await writeFile(bin, original);
  const source = join(root, "a", "files", file.id + ".source");
  await writeFile(source, "Editable source v1");
  assert.equal((await files.read("a", file.id)).text, "Editable source v1");
  await writeFile(source, "Editable source v2");
  assert.equal((await files.read("a", file.id)).text, "Editable source v2");
  await files.copy("a", "fork");
  await writeFile(
    join(root, "fork", "files", file.id + ".source"),
    "Fork only",
  );
  assert.equal((await files.read("fork", file.id)).text, "Fork only");
  assert.equal((await files.read("a", file.id)).text, "Editable source v2");
  await rm(bin);
  await assert.rejects(files.read("a", file.id), /not found/);
});

test("workspace sweeping invalidates retained derived content after successful removal", async (t) => {
  const { root, files } = await fixture(t);
  const id = randomUUID(),
    workspace = join(root, id);
  const file = await files.publish(
    id,
    "private.txt",
    Buffer.from("Private document"),
  );
  await files.list(id);
  await files.read(id, file.id);
  const removed: string[] = [];
  const result = await sweepWorkspaces(root, {
    tempTtlMs: 1,
    workspaceTtlMs: 1,
    now: Date.now() + 10_000,
    onWorkspaceRemoved: (path) => {
      removed.push(path);
      files.invalidate(path);
    },
  });
  assert.equal(result.workspacesRemoved, 1);
  assert.deepEqual(removed, [workspace]);
  await assert.rejects(files.read(id, file.id), /not found/);
  assert.deepEqual(await files.list(id), []);
});

test("warm metadata cannot bypass the authoritative 25 MB quota", async (t) => {
  const { root, files } = await fixture(t);
  await files.list("a");
  const dir = join(root, "a", "files");
  await Promise.all(
    Array.from({ length: 24 }, async () => {
      const id = randomUUID();
      await writeFile(
        join(dir, id + ".json"),
        JSON.stringify({
          id,
          name: "restored.txt",
          size: 1048576,
          mediaType: "text/plain",
          createdAt: new Date().toISOString(),
        }),
      );
    }),
  );
  await files.publish("a", "last.txt", Buffer.alloc(1048576, 65));
  await assert.rejects(
    files.publish("a", "overflow.txt", Buffer.from("a")),
    /limit reached/,
  );
  assert.equal((await files.list("a")).length, 25);
});

test("a parse finishing after invalidation cannot refill retained content", async (t) => {
  const { root, files } = await fixture(t);
  const file = await files.publish("a", "notes.txt", Buffer.from("Before"));
  const extractor = (files as any).extract.bind(files);
  let release!: () => void, started!: () => void;
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  (files as any).extract = async (input: any) => {
    calls++;
    if (calls === 1) {
      started();
      await barrier;
    }
    return extractor(input);
  };
  const old = files.read("a", file.id);
  await waiting;
  files.invalidate(join(root, "a"));
  release();
  assert.equal((await old).text, "Before");
  assert.equal((await files.read("a", file.id)).text, "Before");
  assert.equal(
    calls,
    2,
    "an invalidated in-flight parse was admitted to the cache",
  );
});
