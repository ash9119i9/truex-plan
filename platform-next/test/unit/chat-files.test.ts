import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { loadFilesConfig } from "../../src/config/files-config";
import { contentTypeOf } from "../../src/modules/chats/chat-files";
import { contentDisposition } from "../../src/modules/chats/chats.controller";

describe("chat files", () => {
  test("types come from the extension; unknown ones are binary", () => {
    assert.equal(contentTypeOf("a/guide.MD"), "text/markdown; charset=utf-8");
    assert.equal(contentTypeOf("data.csv"), "text/csv; charset=utf-8");
    assert.equal(contentTypeOf("app.py"), "text/plain; charset=utf-8");
    assert.equal(contentTypeOf("page.html"), "text/html; charset=utf-8");
    assert.equal(
      contentTypeOf("plan.docx"),
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    assert.equal(contentTypeOf("Makefile"), "application/octet-stream");
    assert.equal(contentTypeOf("dir.md/file"), "application/octet-stream");
  });

  test("a download name is quoted safely and kept exactly in filename*", () => {
    assert.equal(
      contentDisposition("guide.md"),
      `attachment; filename="guide.md"; filename*=UTF-8''guide.md`,
    );
    assert.equal(
      contentDisposition('a"b\\c é.md'),
      `attachment; filename="a_b_c _.md"; filename*=UTF-8''a%22b%5Cc%20%C3%A9.md`,
    );
  });

  test("storage config is optional and validated when set", () => {
    const problems: string[] = [];
    assert.equal(loadFilesConfig({}, problems), undefined);
    assert.deepEqual(
      loadFilesConfig(
        { CHAT_FILES_S3_BUCKET: "truex-files", AWS_REGION: "us-east-1" },
        problems,
      ),
      { bucket: "truex-files", region: "us-east-1", prefix: "" },
    );
    assert.deepEqual(problems, []);
    loadFilesConfig(
      {
        CHAT_FILES_S3_BUCKET: "Bad.Bucket",
        CHAT_FILES_S3_REGION: "nowhere",
        CHAT_FILES_S3_PREFIX: "/abs",
      },
      problems,
    );
    assert.equal(problems.length, 3);
  });
});
