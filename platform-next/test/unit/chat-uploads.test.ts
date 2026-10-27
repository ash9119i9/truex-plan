import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ObjectId, type ClientBulkWriteResult } from "mongodb";
import { DomainError } from "../../src/common/domain-error";
import { loadFilesConfig } from "../../src/config/files-config";
import {
  MAX_MESSAGE_ATTACHMENTS,
  parseSend,
  parseStartChat,
} from "../../src/modules/chats/chat";
import {
  AttachmentsGoneError,
  checkClaims,
  contentMatches,
  planAttachments,
  runtimeImages,
  runtimeText,
  uniqueNames,
  uploadName,
  type ChatUploadDoc,
} from "../../src/modules/chats/chat-uploads";

const refused = (fn: () => unknown) =>
  assert.throws(fn, (error: unknown) => error instanceof DomainError);

describe("attachment names", () => {
  test("keeps a normal name, NFC and trimmed", () => {
    assert.equal(uploadName("Report Q3.docx"), "Report Q3.docx");
    assert.equal(uploadName("  notes.md "), "notes.md");
    // macOS sends decomposed accents; the workspace gets one form.
    assert.equal(uploadName("Re\u0301sume\u0301.pdf"), "Résumé.pdf");
    assert.equal(uploadName("DATA.CSV"), "DATA.CSV");
  });

  test("refuses paths, hidden files, controls and unknown types", () => {
    for (const name of [
      undefined,
      "",
      "   ",
      ".env",
      "../a.pdf",
      "a/b.pdf",
      "a\\b.pdf",
      "a\nb.txt",
      "evil\u202Etxt.pdf",
      `${"x".repeat(252)}.pdf`,
      "run.exe",
      "archive.zip",
      "old.doc",
      "noextension",
    ])
      refused(() => uploadName(name));
  });
});

describe("attachment contents", () => {
  const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
  test("documents and images must start with their signature", () => {
    assert.ok(contentMatches("a.pdf", Buffer.from("%PDF-1.7\n")));
    assert.ok(!contentMatches("a.pdf", Buffer.from("MZ\x90\x00")));
    for (const name of ["a.docx", "a.xlsx", "a.pptx"]) {
      assert.ok(contentMatches(name, zip), name);
      assert.ok(!contentMatches(name, Buffer.from("%PDF-")), name);
    }
    assert.ok(
      contentMatches(
        "a.png",
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]),
      ),
    );
    assert.ok(contentMatches("a.JPG", Buffer.from([0xff, 0xd8, 0xff, 0xe0])));
    assert.ok(contentMatches("a.gif", Buffer.from("GIF89a")));
    assert.ok(contentMatches("a.webp", Buffer.from("RIFF\0\0\0\0WEBPVP8 ")));
    assert.ok(!contentMatches("a.webp", Buffer.from("RIFF\0\0\0\0AVI ")));
  });

  test("text and code must be UTF-8 without NUL bytes", () => {
    assert.ok(contentMatches("a.csv", Buffer.from("name,total\nÅsa,3\n")));
    assert.ok(contentMatches("a.py", Buffer.from("print('hi')\n")));
    assert.ok(!contentMatches("a.txt", Buffer.from([0x61, 0x00, 0x62])));
    assert.ok(!contentMatches("a.md", Buffer.from([0xc3, 0x28])));
    // A renamed binary is not text.
    assert.ok(!contentMatches("a.txt", zip));
  });
});

describe("attaching to a message", () => {
  const id = "cm_0123456789";
  const upload = () => new ObjectId().toHexString();

  test("attachments are optional, unique upload IDs, at most ten", () => {
    assert.deepEqual(
      parseSend({ clientMessageId: id, text: "hi" }).attachments,
      [],
    );
    const ids = [upload(), upload()];
    assert.deepEqual(
      parseSend({
        clientMessageId: id,
        text: "hi",
        attachments: ids,
      }).attachments.map((a) => a.toHexString()),
      ids,
    );
    refused(() =>
      parseSend({
        clientMessageId: id,
        text: "hi",
        attachments: [ids[0], ids[0]],
      }),
    );
    refused(() =>
      parseSend({ clientMessageId: id, text: "hi", attachments: ["x"] }),
    );
    refused(() =>
      parseSend({ clientMessageId: id, text: "hi", attachments: upload() }),
    );
    refused(() =>
      parseSend({
        clientMessageId: id,
        text: "hi",
        attachments: Array.from(
          { length: MAX_MESSAGE_ATTACHMENTS + 1 },
          upload,
        ),
      }),
    );
  });

  test("files can be sent without text; without files text is required", () => {
    const one = [upload()];
    assert.equal(parseSend({ clientMessageId: id, attachments: one }).text, "");
    assert.equal(
      parseSend({ clientMessageId: id, text: "  ", attachments: one }).text,
      "",
    );
    refused(() => parseSend({ clientMessageId: id, text: "  " }));
    refused(() => parseSend({ clientMessageId: id }));
    const start = parseStartChat({
      clientMessageId: id,
      agentId: new ObjectId().toHexString(),
      attachments: one,
    });
    assert.equal(start.text, "");
    assert.equal(start.attachments.length, 1);
  });

  test("names within one message are made unique", () => {
    assert.deepEqual(uniqueNames(["a.pdf", "A.pdf", "a.pdf", "b"]), [
      "a.pdf",
      "A (2).pdf",
      "a (3).pdf",
      "b",
    ]);
  });

  test("the model reads the text, then where the files are", () => {
    const attachments = [
      {
        fileId: new ObjectId(),
        name: "Report.docx",
        path: "uploads/Report.docx",
        size: 120 * 1024,
        contentType: "x",
      },
      {
        fileId: new ObjectId(),
        name: "big.pdf",
        path: "uploads/big.pdf",
        size: 3 * 1024 * 1024,
        contentType: "x",
      },
    ];
    assert.equal(runtimeText("hi", undefined), "hi");
    assert.equal(
      runtimeText("Summarize these", attachments),
      "Summarize these\n\nAttached files, in the chat's files:\n- uploads/Report.docx (120 KB)\n- uploads/big.pdf (3.0 MB)",
    );
    assert.match(runtimeText("", attachments), /^Attached files/);
  });

  test("attached images are also shown to the model as images", () => {
    const file = (name: string, path = `uploads/${name}`) => ({
      fileId: new ObjectId(),
      name,
      path,
      size: 10,
      contentType: "x",
    });
    assert.deepEqual(runtimeImages(undefined), []);
    assert.deepEqual(
      runtimeImages([
        file("Chart.PNG"),
        file("notes.txt"),
        file("photo.jpeg"),
        file("png"),
        file("notes.txt", "uploads/notes (2).txt"),
        file("logo.webp", "uploads/logo (2).webp"),
      ]),
      ["uploads/Chart.PNG", "uploads/photo.jpeg", "uploads/logo (2).webp"],
    );
  });

  test("each upload becomes the next version of its path and is claimed", () => {
    const ownerId = new ObjectId();
    const staged = (name: string): ChatUploadDoc => ({
      _id: new ObjectId(),
      ownerId,
      name,
      size: 10,
      sha256: "a".repeat(64),
      contentType: "application/pdf",
      storageKey: `k/${name}`,
      state: "staged",
      createdAt: new Date(),
    });
    const plan = planAttachments({
      uploads: [staged("a.pdf"), staged("a.pdf")],
      chatId: new ObjectId(),
      ownerId,
      runId: new ObjectId(),
      messageId: new ObjectId(),
      latest: new Map([["uploads/a.pdf", 2]]),
      now: new Date(),
      uploadsNamespace: "db.chat_uploads",
      filesNamespace: "db.chat_files",
      offset: 3,
    });
    assert.deepEqual(plan.paths, ["uploads/a.pdf", "uploads/a (2).pdf"]);
    assert.equal(plan.bytes, 20);
    assert.deepEqual(plan.claims, [4, 6]);
    const files = plan.writes.filter(
      (w) => w.name === "insertOne",
    ) as unknown as Array<{
      document: { version: number; source: string; storageKey: string };
    }>;
    assert.deepEqual(
      files.map((f) => [
        f.document.version,
        f.document.source,
        f.document.storageKey,
      ]),
      [
        [3, "upload", "k/a.pdf"],
        [1, "upload", "k/a.pdf"],
      ],
    );
    const result = (matched: number[]) =>
      ({
        updateResults: new Map(
          plan.claims.map((index, i) => [index, { matchedCount: matched[i] }]),
        ),
      }) as unknown as ClientBulkWriteResult;
    checkClaims(result([1, 1]), plan.claims);
    assert.throws(
      () => checkClaims(result([1, 0]), plan.claims),
      AttachmentsGoneError,
    );
  });
});

describe("uploads config", () => {
  const files = {
    CHAT_FILES_S3_BUCKET: "truex-files",
    CHAT_FILES_S3_REGION: "us-east-1",
  };
  test("off by default, on with CHAT_UPLOADS_ENABLED=1 and a bucket", () => {
    const problems: string[] = [];
    assert.equal(loadFilesConfig(files, problems)?.uploads, undefined);
    assert.equal(
      loadFilesConfig({ ...files, CHAT_UPLOADS_ENABLED: "1" }, problems)
        ?.uploads,
      true,
    );
    assert.deepEqual(problems, []);
  });

  test("needs a bucket, and only 0 or 1", () => {
    const problems: string[] = [];
    loadFilesConfig({ CHAT_UPLOADS_ENABLED: "1" }, problems);
    loadFilesConfig({ ...files, CHAT_UPLOADS_ENABLED: "yes" }, problems);
    assert.equal(problems.length, 2);
  });
});
