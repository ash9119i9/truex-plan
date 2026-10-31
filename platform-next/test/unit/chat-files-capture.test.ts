import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import { ObjectId } from "mongodb";
import type { DatabaseService } from "../../src/database/database.service";
import {
  ChatFilesService,
  MAX_FILES_PER_RUN,
  MAX_RUN_FILE_BYTES,
  MAX_UNSAVED,
  MemoryFileStore,
  type CaptureTarget,
  type ChatFileDoc,
} from "../../src/modules/chats/chat-files";
import {
  AdapterRefusal,
  AdapterUnreachable,
  type RuntimeClient,
} from "../../src/modules/chats/runtime-client";

// A reply's files reach the member only through capture: anything in the
// workspace that capture neither stores nor reports as unsaved is invisible,
// while the reply may still say it made it. These pin that every new file
// is either stored or unsaved, whether an edit or a command wrote it.

const MTIME = 1_700_000_000_000;
const DATA = Buffer.from("data");

// The chat's stored versions: `latest` seeds earlier ones by path.
function fakeDatabase(latest: Partial<ChatFileDoc>[] = []) {
  const inserted: ChatFileDoc[] = [];
  const touched: unknown[] = [];
  const collection = {
    aggregate: () => ({ toArray: async () => latest }),
    updateOne: async (filter: unknown) => {
      touched.push(filter);
    },
    insertOne: async (doc: ChatFileDoc) => {
      inserted.push(doc);
    },
  };
  const database = {
    tenantDb: () => ({ collection: () => collection }),
  } as unknown as DatabaseService;
  return { database, inserted, touched };
}

interface Listed {
  path: string;
  size?: number;
}

// The runtime's workspace. `read` overrides a file's bytes or failure.
function fakeRuntime(
  entries: Array<string | Listed>,
  read: (path: string) => Buffer | Error = () => DATA,
  truncated = false,
) {
  const listed = entries.map((e) => {
    const { path, size } = typeof e === "string" ? { path: e } : e;
    return { path, size: size ?? DATA.length, modifiedAt: MTIME };
  });
  const reads: string[] = [];
  const signals: Array<AbortSignal | undefined> = [];
  const client = {
    files: async (_ref: unknown, signal?: AbortSignal) => {
      signals.push(signal);
      return { files: listed, truncated };
    },
    file: async (_ref: unknown, path: string, signal?: AbortSignal) => {
      reads.push(path);
      signals.push(signal);
      const result = read(path);
      if (result === HANG) return untilAborted(signal);
      if (result instanceof Error) throw result;
      return result;
    },
  } as unknown as RuntimeClient;
  return { client, reads, signals };
}

// A read or upload that never finishes on its own: it ends only when the
// caller's signal aborts it (and never without one).
const HANG = Buffer.from("hang");
function untilAborted(signal?: AbortSignal): Promise<never> {
  return new Promise((_, reject) =>
    signal?.addEventListener("abort", () => reject(signal.reason)),
  );
}

const MiB = 1024 * 1024;

const target = (): CaptureTarget => ({
  dbName: "truex_next_t",
  tenantId: "t",
  chatId: new ObjectId(),
  ownerId: new ObjectId(),
  runId: new ObjectId(),
  ref: { tenantId: "t", chatId: "c" },
});

const names = (n: number, ext: string) =>
  Array.from(
    { length: n },
    (_, i) => `out/file${String(i + 1).padStart(3, "0")}.${ext}`,
  );

const service = (database: DatabaseService, store = new MemoryFileStore()) =>
  new ChatFilesService(database, store);

describe("file capture: every new file is stored or unsaved", () => {
  test("files an edit wrote past the per-run cap are unsaved", async () => {
    const { database } = fakeDatabase();
    const paths = names(MAX_FILES_PER_RUN + 5, "md");
    const { stored, unsaved } = await service(database).capture(
      target(),
      fakeRuntime(paths).client,
      { report: new Set(paths) },
    );
    assert.equal(stored.length, MAX_FILES_PER_RUN);
    assert.deepEqual(unsaved, paths.slice(MAX_FILES_PER_RUN));
  });

  // A script (python make_report.py) writes the files: the run has no edit
  // items, so `report` is empty.
  test("files a command wrote past the per-run cap are unsaved, not dropped", async () => {
    const { database } = fakeDatabase();
    const paths = names(MAX_FILES_PER_RUN + 5, "xlsx");
    const { stored, unsaved } = await service(database).capture(
      target(),
      fakeRuntime(paths).client,
      { report: new Set() },
    );
    assert.equal(stored.length, MAX_FILES_PER_RUN);
    assert.deepEqual(
      unsaved,
      paths.slice(MAX_FILES_PER_RUN),
      "5 files are in the workspace but neither shown nor reported",
    );
  });

  test("a command's file that fails to upload is unsaved, not dropped", async () => {
    const { database } = fakeDatabase();
    const store = new MemoryFileStore();
    store.failPuts = new Error("S3 unavailable");
    const { stored, unsaved } = await service(database, store).capture(
      target(),
      fakeRuntime(["report.docx"]).client,
      { report: new Set() },
    );
    assert.equal(stored.length, 0);
    assert.deepEqual(unsaved, ["report.docx"]);
  });

  test("a command's file the runtime can't read is unsaved", async () => {
    const { database } = fakeDatabase();
    const { client } = fakeRuntime(["a.xlsx", "b.xlsx"], (path) =>
      path === "b.xlsx" ? new AdapterUnreachable("timeout") : DATA,
    );
    const { stored, unsaved } = await service(database).capture(
      target(),
      client,
    );
    assert.deepEqual(
      stored.map((f) => f.path),
      ["a.xlsx"],
    );
    assert.deepEqual(unsaved, ["b.xlsx"]);
  });

  test("past the byte cap, the rest are unsaved and never read", async () => {
    const { database } = fakeDatabase();
    // Each at the per-file limit: five fill the run's 100 MiB.
    const block = Buffer.alloc(20 * MiB);
    const big = Array.from({ length: 6 }, (_, i) => ({
      path: `big${i + 1}.bin`,
      size: block.length,
    }));
    const { client, reads } = fakeRuntime(
      [...big, { path: "small.txt" }],
      (path) => (path === "small.txt" ? DATA : block),
    );
    const { stored, unsaved } = await service(database).capture(
      target(),
      client,
    );
    assert.equal(MAX_RUN_FILE_BYTES, 5 * block.length);
    assert.deepEqual(
      stored.map((f) => f.path),
      ["big1.bin", "big2.bin", "big3.bin", "big4.bin", "big5.bin"],
    );
    assert.deepEqual(unsaved, ["big6.bin", "small.txt"]);
    assert.ok(!reads.includes("big6.bin"), "a file over the cap is not read");
  });

  test("a file that grew past the run's remaining bytes after the listing is unsaved", async () => {
    const { database } = fakeDatabase();
    const full = Buffer.alloc(20 * MiB);
    const ten = Buffer.alloc(10 * MiB);
    // 90 MiB stored first; grew.csv was listed at 4 bytes but reads 15 MiB.
    const { client } = fakeRuntime(
      [
        ...Array.from({ length: 4 }, (_, i) => ({
          path: `a${i}.bin`,
          size: full.length,
        })),
        { path: "b.bin", size: ten.length },
        "grew.csv",
      ],
      (path) =>
        path === "grew.csv"
          ? Buffer.alloc(15 * MiB)
          : path === "b.bin"
            ? ten
            : full,
    );
    const { stored, unsaved } = await service(database).capture(
      target(),
      client,
    );
    assert.equal(stored.length, 5);
    assert.ok(
      stored.reduce((n, f) => n + f.size, 0) <= MAX_RUN_FILE_BYTES,
      "the run stays within its byte limit",
    );
    assert.deepEqual(unsaved, ["grew.csv"]);
  });

  // The deadline passes while the first file is being stored: that file and
  // every one after it are unsaved, none silently dropped. (A deadline that
  // passes before the version lookup answers reports only the run's edits:
  // which other files are new isn't known.)
  test("past the time limit, every file not yet stored is unsaved", async () => {
    const { database } = fakeDatabase();
    const paths = names(3, "pptx");
    const deadline = new AbortController();
    const { client, reads } = fakeRuntime(paths, () => {
      deadline.abort();
      return DATA;
    });
    const { stored, unsaved } = await service(database).capture(
      target(),
      client,
      {},
      deadline.signal,
    );
    assert.equal(stored.length, 0);
    assert.deepEqual(unsaved, paths);
    assert.deepEqual(reads, [paths[0]], "nothing is read after the deadline");
  });

  test("unsaved is bounded", async () => {
    const { database } = fakeDatabase();
    const paths = names(MAX_FILES_PER_RUN + MAX_UNSAVED + 10, "csv");
    const { stored, unsaved } = await service(database).capture(
      target(),
      fakeRuntime(paths).client,
    );
    assert.equal(stored.length, MAX_FILES_PER_RUN);
    assert.equal(unsaved.length, MAX_UNSAVED);
    assert.deepEqual(
      unsaved,
      paths.slice(MAX_FILES_PER_RUN, MAX_FILES_PER_RUN + MAX_UNSAVED),
    );
  });
});

describe("file capture: what is not unsaved", () => {
  test("an unchanged file is neither stored, read nor unsaved", async () => {
    const { database } = fakeDatabase([
      {
        _id: new ObjectId(),
        path: "old.xlsx",
        size: DATA.length,
        sourceModifiedAt: MTIME,
        version: 1,
      },
    ]);
    const { client, reads } = fakeRuntime(["old.xlsx"]);
    const store = new MemoryFileStore();
    store.failPuts = new Error("would fail");
    const result = await service(database, store).capture(target(), client);
    assert.deepEqual(result, {
      stored: [],
      unsaved: [],
      tooLarge: [],
      truncated: false,
    });
    assert.deepEqual(reads, []);
  });

  // Uploads are recorded with sourceModifiedAt 0, so each capture reads them
  // once and keeps the time.
  test("a file touched but not changed records its new time, nothing else", async () => {
    const { database, inserted, touched } = fakeDatabase([
      {
        _id: new ObjectId(),
        path: "uploads/in.csv",
        size: DATA.length,
        sourceModifiedAt: 0,
        version: 1,
        sha256: createHash("sha256").update(DATA).digest("hex"),
      },
    ]);
    const result = await service(database).capture(
      target(),
      fakeRuntime(["uploads/in.csv"]).client,
    );
    assert.deepEqual(result, {
      stored: [],
      unsaved: [],
      tooLarge: [],
      truncated: false,
    });
    assert.equal(inserted.length, 0);
    assert.equal(touched.length, 1);
  });

  test("a file deleted after the listing is neither stored nor unsaved", async () => {
    const { database } = fakeDatabase();
    const { client } = fakeRuntime(["gone.tmp", "kept.md"], (path) =>
      path === "gone.tmp"
        ? new AdapterRefusal(404, "FILE_NOT_FOUND", false)
        : DATA,
    );
    const { stored, unsaved } = await service(database).capture(
      target(),
      client,
      { report: new Set(["gone.tmp", "kept.md"]) },
    );
    assert.deepEqual(
      stored.map((f) => f.path),
      ["kept.md"],
    );
    assert.deepEqual(unsaved, []);
  });

  test("no file storage: nothing is stored or unsaved", async () => {
    const { database } = fakeDatabase();
    const files = new ChatFilesService(database, null);
    assert.equal(files.configured, false);
    assert.deepEqual(
      await files.capture(target(), fakeRuntime(["a.md"]).client, {
        report: new Set(["a.md"]),
      }),
      { stored: [], unsaved: [], tooLarge: [], truncated: false },
    );
  });
});

describe("file capture: listing failures and retries", () => {
  // The listing is the only way to see what a command wrote; when it fails,
  // only the edits' paths are known.
  test("a failed listing reports the files the edits wrote", async () => {
    const { database } = fakeDatabase();
    const client = {
      files: async () => {
        throw new AdapterUnreachable("down");
      },
    } as unknown as RuntimeClient;
    const { stored, unsaved } = await service(database).capture(
      target(),
      client,
      { report: new Set(["notes.md"]) },
    );
    assert.deepEqual(stored, []);
    assert.deepEqual(unsaved, ["notes.md"]);
  });

  test("a retry captures only its paths and leaves other new files alone", async () => {
    const { database } = fakeDatabase();
    const { client, reads } = fakeRuntime(["a.xlsx", "b.xlsx", "c.xlsx"]);
    const { stored, unsaved } = await service(database).capture(
      target(),
      client,
      { only: new Set(["b.xlsx", "missing.xlsx"]) },
    );
    assert.deepEqual(
      stored.map((f) => f.path),
      ["b.xlsx"],
    );
    assert.deepEqual(reads, ["b.xlsx"]);
    // A path no longer in the workspace is not unsaved.
    assert.deepEqual(unsaved, []);
  });

  test("a retry that fails again keeps the path unsaved", async () => {
    const { database } = fakeDatabase();
    const store = new MemoryFileStore();
    store.failPuts = new Error("still down");
    const { stored, unsaved } = await service(database, store).capture(
      target(),
      fakeRuntime(["a.xlsx", "b.xlsx"]).client,
      { only: new Set(["a.xlsx"]) },
    );
    assert.deepEqual(stored, []);
    assert.deepEqual(unsaved, ["a.xlsx"]);
  });
});

// R1: a command that writes many files (a build, a clone) must not push the
// files the run's edits wrote out of the run's limits or the unsaved list.
describe("file capture: the run's edits come first", () => {
  test("an edited file listed after many command files is stored", async () => {
    const { database } = fakeDatabase();
    const built = Array.from(
      { length: 70 },
      (_, i) => `build/obj${String(i).padStart(2, "0")}.o`,
    );
    const { stored, unsaved } = await service(database).capture(
      target(),
      fakeRuntime([...built, "out/report.docx"]).client,
      { report: new Set(["out/report.docx"]) },
    );
    assert.equal(stored[0]?.path, "out/report.docx");
    assert.equal(stored.length, MAX_FILES_PER_RUN);
    assert.ok(!unsaved.includes("out/report.docx"));
    // The rest of the command's files are still accounted for, up to the cap.
    assert.equal(unsaved.length, MAX_UNSAVED);
  });

  test("edited files past the cap head the unsaved list, ahead of command files", async () => {
    const { database } = fakeDatabase();
    const built = Array.from({ length: 80 }, (_, i) => `a/gen${i}.txt`);
    const edited = names(MAX_FILES_PER_RUN + 5, "md");
    const { stored, unsaved } = await service(database).capture(
      target(),
      fakeRuntime([...built, ...edited]).client,
      { report: new Set(edited) },
    );
    assert.deepEqual(
      stored.map((f) => f.path),
      edited.slice(0, MAX_FILES_PER_RUN),
    );
    assert.equal(unsaved.length, MAX_UNSAVED);
    assert.deepEqual(unsaved.slice(0, 5), edited.slice(MAX_FILES_PER_RUN));
    assert.deepEqual(unsaved.slice(5), built.slice(0, MAX_UNSAVED - 5));
  });
});

// R3: a file over the runtime's per-file limit can never be stored, so it is
// not offered for retry. It is shown once, by the run that wrote it.
describe("file capture: files too large to store", () => {
  const BIG = 20 * MiB + 1;

  test("a new file over the per-file limit is too large: not read, not unsaved", async () => {
    const { database } = fakeDatabase();
    const { client, reads } = fakeRuntime([
      { path: "data/dump.sqlite", size: BIG },
      "report.xlsx",
    ]);
    const result = await service(database).capture(
      { ...target(), since: MTIME - 1 },
      client,
    );
    assert.deepEqual(
      result.stored.map((f) => f.path),
      ["report.xlsx"],
    );
    assert.deepEqual(result.unsaved, []);
    assert.deepEqual(result.tooLarge, ["data/dump.sqlite"]);
    assert.deepEqual(reads, ["report.xlsx"]);
  });

  test("a file at exactly the per-file limit is stored", async () => {
    const { database } = fakeDatabase();
    const { client } = fakeRuntime([{ path: "at.bin", size: 20 * MiB }], () =>
      Buffer.alloc(20 * MiB),
    );
    const result = await service(database).capture(target(), client);
    assert.deepEqual(
      result.stored.map((f) => f.path),
      ["at.bin"],
    );
    assert.deepEqual(result.tooLarge, []);
  });

  test("a too-large file an earlier run made is not reported again", async () => {
    const { database } = fakeDatabase();
    const { client, reads } = fakeRuntime([
      { path: "data/dump.sqlite", size: BIG },
    ]);
    const result = await service(database).capture(
      { ...target(), since: MTIME + 1 },
      client,
    );
    assert.deepEqual(result, {
      stored: [],
      unsaved: [],
      tooLarge: [],
      truncated: false,
    });
    assert.deepEqual(reads, []);
  });

  test("an old too-large file the run edited is reported", async () => {
    const { database } = fakeDatabase();
    const result = await service(database).capture(
      { ...target(), since: MTIME + 1 },
      fakeRuntime([{ path: "log.txt", size: BIG }]).client,
      { report: new Set(["log.txt"]) },
    );
    assert.deepEqual(result.tooLarge, ["log.txt"]);
    assert.deepEqual(result.unsaved, []);
  });

  test("a file that grew past the limit after the listing is too large, not unsaved", async () => {
    const { database } = fakeDatabase();
    const { client } = fakeRuntime(["grew.csv"], () =>
      Object.assign(new AdapterRefusal(413, "PAYLOAD_TOO_LARGE", false)),
    );
    const result = await service(database).capture(target(), client);
    assert.deepEqual(result.tooLarge, ["grew.csv"]);
    assert.deepEqual(result.unsaved, []);
  });

  test("too large is bounded", async () => {
    const { database } = fakeDatabase();
    const big = Array.from({ length: MAX_UNSAVED + 10 }, (_, i) => ({
      path: `big${i}.bin`,
      size: BIG,
    }));
    const result = await service(database).capture(
      target(),
      fakeRuntime(big).client,
    );
    assert.equal(result.tooLarge.length, MAX_UNSAVED);
  });
});

// R2: the runtime lists at most 500 files. A cut-short listing is reported,
// and an edited file it missed is still captured by its path.
describe("file capture: a truncated listing", () => {
  test("a truncated listing is reported", async () => {
    const { database } = fakeDatabase();
    const result = await service(database).capture(
      target(),
      fakeRuntime(["a.md"], undefined, true).client,
    );
    assert.equal(result.truncated, true);
    assert.deepEqual(
      result.stored.map((f) => f.path),
      ["a.md"],
    );
  });

  test("an edited file the truncated listing missed is read by path and stored", async () => {
    const { database } = fakeDatabase();
    const { client, reads } = fakeRuntime(["a.md"], undefined, true);
    const result = await service(database).capture(target(), client, {
      report: new Set(["deep/z/report.md"]),
    });
    assert.deepEqual(result.stored.map((f) => f.path).sort(), [
      "a.md",
      "deep/z/report.md",
    ]);
    assert.equal(reads[0], "deep/z/report.md", "the edit is read first");
    assert.deepEqual(result.unsaved, []);
  });

  test("an edited file missed by the listing and since deleted is neither", async () => {
    const { database } = fakeDatabase();
    const { client } = fakeRuntime(
      ["a.md"],
      (path) =>
        path === "gone.md"
          ? new AdapterRefusal(404, "FILE_NOT_FOUND", false)
          : DATA,
      true,
    );
    const result = await service(database).capture(target(), client, {
      report: new Set(["gone.md"]),
    });
    assert.deepEqual(result.unsaved, []);
    assert.deepEqual(result.tooLarge, []);
  });

  test("an edited path the runtime never lists is not read or unsaved", async () => {
    const { database } = fakeDatabase();
    const { client, reads } = fakeRuntime(["a.md"], undefined, true);
    const result = await service(database).capture(target(), client, {
      report: new Set([".gitignore", "src/.env", "node_modules/x/i.js"]),
    });
    assert.deepEqual(reads, ["a.md"]);
    assert.deepEqual(result.unsaved, []);
  });

  test("a retry reads its path when the truncated listing misses it", async () => {
    const { database } = fakeDatabase();
    const result = await service(database).capture(
      target(),
      fakeRuntime(["a.md"], undefined, true).client,
      { only: new Set(["deep/z/report.md"]) },
    );
    assert.deepEqual(
      result.stored.map((f) => f.path),
      ["deep/z/report.md"],
    );
    assert.deepEqual(result.unsaved, []);
  });

  test("a complete listing never reads an unlisted path", async () => {
    const { database } = fakeDatabase();
    const { client, reads } = fakeRuntime(["a.md"]);
    const result = await service(database).capture(target(), client, {
      report: new Set(["deleted.md"]),
    });
    assert.deepEqual(reads, ["a.md"]);
    assert.deepEqual(result.unsaved, []);
  });
});

// R4: capture is bounded by its signal: a read, an upload or the listing
// that never finishes is cut short, and what it held is unsaved.
describe("file capture: bounded in time", () => {
  const fast = () => AbortSignal.timeout(150);

  test(
    "a read that never finishes is cut short and its file is unsaved",
    { timeout: 5_000 },
    async () => {
      const { database } = fakeDatabase();
      const { client } = fakeRuntime(["a.xlsx", "b.xlsx"], (path) =>
        path === "a.xlsx" ? HANG : DATA,
      );
      const started = Date.now();
      const result = await service(database).capture(
        target(),
        client,
        {},
        fast(),
      );
      assert.ok(Date.now() - started < 2_000, "returns soon after the signal");
      assert.deepEqual(result.stored, []);
      assert.deepEqual(result.unsaved, ["a.xlsx", "b.xlsx"]);
    },
  );

  test(
    "an upload that never finishes is cut short and its file is unsaved",
    { timeout: 5_000 },
    async () => {
      const { database, inserted } = fakeDatabase();
      const store = new MemoryFileStore();
      store.holdPuts = true;
      const started = Date.now();
      const result = await service(database, store).capture(
        target(),
        fakeRuntime(["a.docx"]).client,
        {},
        fast(),
      );
      assert.ok(Date.now() - started < 2_000, "returns soon after the signal");
      assert.deepEqual(result.unsaved, ["a.docx"]);
      assert.equal(inserted.length, 0, "no version without its object");
    },
  );

  test(
    "the listing that never finishes is cut short; the edits are unsaved",
    { timeout: 5_000 },
    async () => {
      const { database } = fakeDatabase();
      const client = {
        files: (_ref: unknown, signal?: AbortSignal) => untilAborted(signal),
      } as unknown as RuntimeClient;
      const result = await service(database).capture(
        target(),
        client,
        { report: new Set(["notes.md"]) },
        fast(),
      );
      assert.deepEqual(result.unsaved, ["notes.md"]);
    },
  );

  test("the capture signal reaches the listing and every read", async () => {
    const { database } = fakeDatabase();
    const { client, signals } = fakeRuntime(["a.md", "b.md"]);
    const signal = AbortSignal.timeout(10_000);
    await service(database).capture(target(), client, {}, signal);
    assert.equal(signals.length, 3);
    assert.ok(signals.every((s) => s === signal));
  });
});

// Hardening findings (2026-10-31). Each test states the rule; a failing one
// is a confirmed finding, kept as its regression test until it is fixed.
describe("file capture: hardening", () => {
  // P9: an attached upload is the member's file, never a reply's.
  test("a member's upload is never reported as the reply's unsaved file", async () => {
    const { database } = fakeDatabase([
      {
        _id: new ObjectId(),
        path: "uploads/brief.pdf",
        size: DATA.length,
        // markCopied failed, so the copy's time was never recorded.
        sourceModifiedAt: 0,
        version: 1,
        source: "upload",
      },
    ]);
    const paths = [...names(MAX_FILES_PER_RUN, "md"), "uploads/brief.pdf"];
    const { unsaved } = await service(database).capture(
      target(),
      fakeRuntime(paths).client,
    );
    assert.ok(!unsaved.includes("uploads/brief.pdf"), unsaved.join(","));
  });

  // P3: a missed edit is read before it is judged; the cap alone doesn't
  // make an unchanged or deleted file unsaved.
  test("an edit the truncated listing missed isn't unsaved when it no longer exists", async () => {
    const { database } = fakeDatabase();
    const paths = names(MAX_FILES_PER_RUN, "md");
    const { client } = fakeRuntime(
      paths,
      (path) =>
        path === "gone/report.md"
          ? new AdapterRefusal(404, "FILE_NOT_FOUND", false)
          : DATA,
      true,
    );
    const { unsaved } = await service(database).capture(target(), client, {
      report: new Set([...paths, "gone/report.md"]),
    });
    assert.ok(!unsaved.includes("gone/report.md"), unsaved.join(","));
  });

  // P7: a path the runtime can never read isn't offered for Retry.
  for (const path of ["a\\b.md", `${"x".repeat(1025)}.md`])
    test(`an edit path the runtime refuses (${path.length} chars) isn't unsaved`, async () => {
      const { database } = fakeDatabase();
      const { client } = fakeRuntime(
        ["a.md"],
        (p) =>
          p === path ? new AdapterRefusal(400, "INVALID_REQUEST", false) : DATA,
        true,
      );
      const { unsaved } = await service(database).capture(target(), client, {
        report: new Set([path]),
      });
      assert.deepEqual(unsaved, []);
    });

  // P10: the capture's deadline covers its database calls too.
  // The refusal check alone: a listed file the runtime then refuses.
  test("a listed file the runtime refuses to read isn't unsaved", async () => {
    const { database } = fakeDatabase();
    const { client } = fakeRuntime(
      ["odd.md"],
      () => new AdapterRefusal(400, "INVALID_REQUEST", false),
    );
    const { stored, unsaved } = await service(database).capture(
      target(),
      client,
    );
    assert.deepEqual(stored, []);
    assert.deepEqual(unsaved, []);
  });

  // The path check alone: a missed edit the runtime would never list is
  // never read.
  for (const path of ["a\\b.md", `${"x".repeat(1025)}.md`])
    test(`a missed edit the runtime can't list (${path.length} chars) is never read`, async () => {
      const { database } = fakeDatabase();
      const { client, reads } = fakeRuntime(["a.md"], undefined, true);
      await service(database).capture(target(), client, {
        report: new Set([path]),
      });
      assert.ok(!reads.includes(path), "read a path the runtime can't list");
    });

  test("a version lookup that never answers is cut short by the signal", async () => {
    const { database } = fakeDatabase();
    (
      database.tenantDb("x").collection("y") as unknown as {
        aggregate: () => unknown;
      }
    ).aggregate = () => ({ toArray: () => new Promise(() => undefined) });
    // Capture's own deadline is 150 ms; 2 s later it has hung.
    const hung = new Promise<"hung">((resolve) => {
      const timer = setTimeout(() => resolve("hung"), 2_000);
      timer.unref();
    });
    const outcome = await Promise.race([
      service(database).capture(
        target(),
        fakeRuntime(["a.md"]).client,
        { report: new Set(["a.md"]) },
        AbortSignal.timeout(150),
      ),
      hung,
    ]);
    assert.notEqual(outcome, "hung", "capture ignored its deadline");
    assert.deepEqual((outcome as { unsaved: string[] }).unsaved, ["a.md"]);
  });
});
