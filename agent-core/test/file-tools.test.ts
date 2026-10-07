import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { unzipSync, strFromU8 } from "fflate";
import { ConversationFiles } from "../src/file-tools";

test("visualizations retain source, revisions and fork history without crossing conversation boundaries", async (t) => {
  const files = await fixture(t);
  const args = {
    title: "Scenario",
    description: "Adjust the scenario",
    html: '<div id="scenario"><input type="range" aria-label="Rate"></div>',
    mode: "wide",
  };
  const first = (await files.execute("a", "create_visualization", args)) as any;
  assert.equal(first.reference, `[truex-visualization:${first.id}]`);
  assert.deepEqual(await files.visualization("a", first.id), {
    id: first.id,
    ...args,
  });
  assert.equal((await files.read("a", first.id)).text, args.html);
  const revision = (await files.execute("a", "create_visualization", {
    ...args,
    html: '<div id="revised">Revised</div>',
    sourceId: first.id,
  })) as any;
  assert.notEqual(first.id, revision.id);
  assert.equal((await files.get("a", revision.id)).sourceId, first.id);
  assert.equal((await files.visualization("a", first.id)).html, args.html);
  await assert.rejects(files.visualization("b", first.id), /not found/);
  await assert.rejects(
    files.execute("b", "create_visualization", { ...args, sourceId: first.id }),
    /not found/,
  );
  await assert.rejects(
    files.execute("a", "create_visualization", {
      ...args,
      html: "x".repeat(180001),
    }),
    /Invalid/,
  );
  await assert.rejects(
    files.execute("a", "create_visualization", {
      ...args,
      path: "/tmp/test.html",
    }),
    /Invalid/,
  );
  const document = await files.upload("a", "notes.txt", "YQ==");
  await assert.rejects(files.visualization("a", document.id), /not found/);
  await files.copy("a", "fork");
  assert.deepEqual(
    await files.visualization("fork", first.id),
    await files.visualization("a", first.id),
  );
});

async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), "truex-documents-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return new ConversationFiles((id) => join(root, id));
}
test("HTML publication is scoped, replay-safe, crash-recoverable and immutable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "truex-publication-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = new ConversationFiles((id) => join(root, id));
  const args = {
    title: "Sales",
    html: "<!doctype html><html><head><title>Sales</title></head><body><button>Compare</button></body></html>",
    height: 420,
  };
  const invocation = { turnId: "turn-1", callId: "call-1" };
  await assert.rejects(
    files.execute("a", "html_render", args),
    /requires a main/,
  );
  await assert.rejects(
    files.execute("a", "html_render", args, { turnId: "", callId: "call" }),
    /requires a main/,
  );
  for (const invalid of [
    { ...args, height: 0 },
    { ...args, height: 901 },
    { ...args, height: 420.5 },
    { ...args, title: " " },
    { ...args, html: "<div>Fragment</div>" },
    { ...args, html: "<!-- <html><head></head><body></body></html> -->" },
    { ...args, html: "x".repeat(180001) },
    { ...args, path: "/etc/passwd" },
  ])
    await assert.rejects(
      files.execute("a", "html_render", invalid, invocation),
    );
  const [first, duplicate] = (await Promise.all([
    files.execute("a", "html_render", args, invocation),
    files.execute("a", "html_render", args, invocation),
  ])) as any[];
  assert.equal(first.id, duplicate.id);
  assert.equal((await files.list("a")).length, 1);
  assert.deepEqual(first.visual, {
    id: first.id,
    title: "Sales",
    description: "Sales",
    height: 420,
    ...invocation,
  });
  assert.equal(
    (await files.visualization("a", first.id)).sourceFormat,
    "document",
  );
  assert.equal((await files.visualization("a", first.id)).html, args.html);
  assert.ok(!(await files.list("a")).some((file) => "publication" in file));
  await assert.rejects(
    files.execute("a", "html_render", { ...args, height: 421 }, invocation),
    /different content/,
  );
  const separate = (await files.execute("a", "html_render", args, {
    ...invocation,
    callId: "call-2",
  })) as any;
  assert.notEqual(first.id, separate.id);
  const revision = (await files.execute(
    "a",
    "html_render",
    { ...args, sourceId: first.id },
    { ...invocation, callId: "call-3" },
  )) as any;
  assert.equal((await files.get("a", revision.id)).sourceId, first.id);
  await assert.rejects(
    files.execute(
      "b",
      "html_render",
      { ...args, sourceId: first.id },
      invocation,
    ),
    /not found/,
  );
  // A fresh process has no in-memory event/queue state: associations survive
  // source commit followed immediately by a crash before publication/spooling.
  const restarted = new ConversationFiles((id) => join(root, id));
  assert.equal((await restarted.publications("a")).length, 3);
  assert.equal(
    ((await restarted.execute("a", "html_render", args, invocation)) as any).id,
    first.id,
  );
  await restarted.copy("a", "fork");
  assert.deepEqual(
    await restarted.publications("fork"),
    await restarted.publications("a"),
  );
  // An uncommitted metadata file is never projected as a published artifact.
  await rename(
    join(root, "a", "files", separate.id + ".json"),
    join(root, "a", "files", separate.id + ".pending"),
  );
  assert.equal((await restarted.publications("a")).length, 2);
  const corruptId = "3bab68a9-ced4-4bdc-94fd-70ef6a5fb4e0";
  await writeFile(join(root, "a", "files", corruptId + ".json"), "{broken");
  assert.equal((await restarted.publications("a")).length, 2);
  await writeFile(
    join(root, "a", "files", corruptId + ".json"),
    JSON.stringify({
      id: corruptId,
      kind: "visualization",
      sourceFormat: "document",
      size: 10,
      title: { private: "invalid" },
      description: "Corrupt fixture",
      height: "420",
      createdAt: new Date().toISOString(),
      publication: { ...invocation, inputHash: "a".repeat(64) },
    }),
  );
  assert.equal((await restarted.publications("a")).length, 2);
});
test("uploads are isolated, persistent, validated, and readable in chunks", async (t) => {
  const files = await fixture(t);
  const content = "A".repeat(25000);
  const uploaded = await files.upload(
    "a",
    "notes.txt",
    Buffer.from(content).toString("base64"),
  );
  assert.equal((await files.list("a")).length, 1);
  assert.equal((await files.list("b")).length, 0);
  await assert.rejects(files.get("b", uploaded.id), /not found/);
  await assert.rejects(files.get("a", "../secret"), /Invalid file/);
  await assert.rejects(files.upload("a", "../notes.txt", "YQ=="), /filename/);
  await assert.rejects(files.upload("a", "run.exe", "YQ=="), /Upload a PDF/);
  await assert.rejects(files.upload("a", "notes.txt", "not base64"), /base64/);
  await assert.rejects(
    files.upload("a", "notes.txt", Buffer.alloc(1048577).toString("base64")),
    /1 MB/,
  );
  const first = await files.read("a", uploaded.id);
  const second = await files.read("a", uploaded.id, first.nextOffset!);
  assert.equal(first.text + second.text, content);
  assert.equal(second.nextOffset, null);
  await files.copy("a", "fork");
  assert.deepEqual(
    (await files.get("fork", uploaded.id)).data,
    Buffer.from(content),
  );
});

test("generates valid PDF, Word, Excel and PowerPoint binaries with editable source and immutable revisions", async (t) => {
  const files = await fixture(t);
  const original = await files.upload(
    "a",
    "notes.txt",
    Buffer.from("Original").toString("base64"),
  );
  for (const format of ["pdf", "docx", "xlsx", "pptx"]) {
    const args = {
      name: "Report",
      format,
      title: "Quarterly report",
      sourceId: original.id,
      ...(format === "xlsx"
        ? {
            sheets: [
              {
                name: "Sales",
                rows: [
                  ["Region", "Revenue"],
                  ["West", 42],
                ],
              },
            ],
          }
        : format === "pptx"
          ? {
              slides: [
                {
                  title: "Results",
                  bullets: ["Revenue increased", "Next steps"],
                },
              ],
            }
          : { paragraphs: ["Revenue increased", "Next steps"] }),
    };
    const result = (await files.execute("a", "create_document", args)) as any;
    const file = await files.get("a", result.id);
    assert.equal(file.name, "Report." + format);
    assert.equal(file.sourceId, original.id);
    if (format === "pdf")
      assert.equal((await PDFDocument.load(file.data)).getPageCount(), 1);
    else {
      const parts = unzipSync(file.data);
      assert.ok(parts["[Content_Types].xml"]);
      const part =
        format === "docx"
          ? "word/document.xml"
          : format === "xlsx"
            ? "xl/worksheets/sheet1.xml"
            : "ppt/slides/slide1.xml";
      assert.ok(strFromU8(parts[part]).length > 100);
    }
    const source = await files.read("a", file.id);
    assert.deepEqual(JSON.parse(source.text), args);
    // Re-upload to exercise extraction from the actual generated binary, not the saved source.
    const upload = await files.upload(
      "b",
      file.name,
      file.data.toString("base64"),
    );
    const extracted = await files.read("b", upload.id);
    assert.match(
      extracted.text,
      format === "xlsx" ? /West/ : /Revenue increased/,
    );
  }
  assert.equal((await files.get("a", original.id)).data.toString(), "Original");
  assert.equal((await files.list("a")).length, 5);
});

test("tool validation rejects unknown operations, cross-conversation revisions and excessive content", async (t) => {
  const files = await fixture(t);
  await assert.rejects(files.execute("a", "shell", {}), /Invalid/);
  await assert.rejects(
    files.execute("a", "conversation_files", { path: "/etc/passwd" }),
    /Invalid/,
  );
  await assert.rejects(
    files.execute("a", "create_document", { name: "Doc", format: "docx" }),
    /paragraphs/,
  );
  await assert.rejects(
    files.execute("a", "create_document", {
      name: "Doc",
      format: "docx",
      paragraphs: ["x".repeat(200001)],
    }),
    /Invalid/,
  );
  const original = await files.upload("a", "notes.txt", "YQ==");
  await assert.rejects(
    files.execute("b", "create_document", {
      name: "Doc",
      format: "docx",
      paragraphs: ["Revision"],
      sourceId: original.id,
    }),
    /not found/,
  );
  assert.equal((await files.list("b")).length, 0);
});

test("published and uploaded code files keep text media types and read as UTF-8", async (t) => {
  const files = await fixture(t);
  const abap = "REPORT zdemo.\nWRITE: / 'Grüße'.\n";
  const published = await files.publish("a", "zdemo.abap", Buffer.from(abap));
  assert.equal(published.mediaType, "text/plain");
  assert.deepEqual(
    (await files.list("a")).map((f) => f.id),
    [published.id],
  );
  assert.equal((await files.read("a", published.id)).text, abap);
  for (const [name, type] of [
    ["config.json", "application/json"],
    ["view.cds", "text/plain"],
    ["page.html", "text/plain"],
    ["query.sql", "application/sql"],
    ["app.yaml", "application/yaml"],
  ]) {
    const file = await files.publish("a", name, Buffer.from("x = 1"));
    assert.equal(file.mediaType, type);
    assert.equal((await files.read("a", file.id)).text, "x = 1");
  }
  const upload = await files.upload(
    "a",
    "Component.ts",
    Buffer.from("export {};").toString("base64"),
  );
  assert.equal((await files.read("a", upload.id)).text, "export {};");
  const binary = await files.publish("a", "bin.ts", Buffer.from([0x61, 0]));
  await assert.rejects(files.read("a", binary.id), /binary/);
  await assert.rejects(
    files.publish("a", "../x.ts", Buffer.from("a")),
    /filename/,
  );
  await assert.rejects(
    files.publish("a", "empty.ts", Buffer.alloc(0)),
    /1 byte/,
  );
});
