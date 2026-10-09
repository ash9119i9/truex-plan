import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationFiles } from "../src/file-tools";
import type { PageRenderer } from "../src/page-renderer";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46,
]);
const GIF = Buffer.from("GIF89a\x01\x00\x01\x00", "latin1");
const WEBP = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.from([4, 0, 0, 0]),
  Buffer.from("WEBPVP8 "),
]);
const b64 = (data: Buffer) => data.toString("base64");
// A valid PNG header padded to a size, for the bounds.
const bigPng = (bytes: number) =>
  Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(bytes - 8, 1)]);

async function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "truex-images-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const seen: { html: string; options: unknown }[] = [];
  const renderer: PageRenderer = {
    available: () => true,
    preview: async (html, options) => {
      seen.push({ html, options });
      return {
        width: options?.width ?? 728,
        appearance: options?.appearance ?? "light",
        contentHeight: 100,
        capturedHeight: 100,
        consoleMessages: [],
        blockedRequests: [],
        missingImages: [],
      };
    },
    measure: async (html) => {
      seen.push({ html, options: "measure" });
      return [[728, 100]] as never;
    },
  };
  return {
    files: new ConversationFiles((id) => join(root, id), renderer),
    seen,
  };
}

test("images upload when they really are what their name says", async (t) => {
  const { files } = await setup(t);
  for (const [name, data, type] of [
    ["a.png", PNG, "image/png"],
    ["b.jpg", JPEG, "image/jpeg"],
    ["c.JPEG", JPEG, "image/jpeg"],
    ["d.gif", GIF, "image/gif"],
    ["e.webp", WEBP, "image/webp"],
  ] as const) {
    const file = await files.upload("c", name, b64(data));
    assert.equal(file.mediaType, type, name);
  }
  // Wrong bytes for the name, text posing as an image, and SVG are refused.
  for (const [name, data] of [
    ["x.png", Buffer.from("<html><script>alert(1)</script>")],
    ["x.png", JPEG],
    ["x.jpg", PNG],
    ["x.gif", WEBP],
    ["x.webp", Buffer.from("RIFFxxxxWAVE")],
    ["x.png", Buffer.from("not an image")],
  ] as const)
    await assert.rejects(
      files.upload("c", name, b64(data)),
      /not a valid image/,
      name,
    );
  for (const name of ["logo.svg", "pic.bmp", "pic.tiff", "pic.png.exe"])
    await assert.rejects(
      files.upload("c", name, b64(PNG)),
      /Upload a PDF/,
      name,
    );
  // Only the five good images were stored.
  assert.equal((await files.list("c")).length, 5);
});

test("an image has no text, and the model is told how to show it", async (t) => {
  const { files } = await setup(t);
  const image = await files.upload("c", "logo.png", b64(PNG));
  const read = await files.read("c", image.id);
  assert.equal(read.text, "");
  assert.equal(read.nextOffset, null);
  assert.match(read.note, new RegExp(`src="truex-file:${image.id}"`));
});

test("a shown visual has its images put in; the saved source keeps the reference", async (t) => {
  const { files } = await setup(t);
  const logo = await files.upload("c", "logo.png", b64(PNG));
  const photo = await files.upload("c", "photo.jpg", b64(JPEG));
  const html =
    `<img src="truex-file:${logo.id}" alt="">` +
    `<div style="background:url(truex-file:${photo.id})"></div>` +
    `<script>const again = "truex-file:${logo.id}"</script>`;
  const created = (await files.execute("c", "create_visualization", {
    title: "Pics",
    description: "Pictures",
    html,
  })) as { id: string };
  const shown = await files.visualization("c", created.id);
  const png = `data:image/png;base64,${b64(PNG)}`;
  assert.ok(shown.html.includes(`<img src="${png}" alt="">`));
  assert.ok(
    shown.html.includes(`url(data:image/jpeg;base64,${b64(JPEG)})`),
    "css url",
  );
  assert.ok(shown.html.includes(`const again = "${png}"`), "js string");
  assert.equal(shown.html.includes("truex-file:"), false);
  // Revising starts from the reference, not megabytes of data.
  const source = await files.read("c", created.id);
  assert.equal(source.text, html);
});

test("only this conversation's image files are ever embedded", async (t) => {
  const { files } = await setup(t);
  const mine = await files.upload("c", "mine.png", b64(PNG));
  const theirs = await files.upload("other", "theirs.png", b64(PNG));
  const doc = await files.upload("c", "notes.txt", b64(Buffer.from("secret")));
  const missing = "00000000-0000-0000-0000-000000000000";
  const html = [mine.id, theirs.id, doc.id, missing]
    .map((id) => `<img src="truex-file:${id}">`)
    .join("");
  const created = (await files.execute("c", "create_visualization", {
    title: "T",
    description: "D",
    html,
  })) as { id: string; warnings?: string[] };
  const shown = await files.visualization("c", created.id);
  assert.ok(shown.html.includes(`data:image/png;base64,${b64(PNG)}`));
  // Another conversation's image, a document and an unknown id stay as written.
  for (const id of [theirs.id, doc.id, missing])
    assert.ok(shown.html.includes(`truex-file:${id}`), id);
  assert.equal(shown.html.includes("secret"), false);
  assert.equal(shown.html.includes(b64(Buffer.from("secret"))), false);
  // The model hears about each reference that could not be used.
  assert.deepEqual(
    created.warnings?.map((w) => w.split(" ")[0]).sort(),
    [doc.id, missing, theirs.id].map((id) => `truex-file:${id}`).sort(),
  );
});

test("embedded images are bounded in number and total size", async (t) => {
  const { files } = await setup(t);
  const ids: string[] = [];
  for (let n = 0; n < 5; n++)
    ids.push(
      (await files.upload("c", `big${n}.png`, b64(bigPng(1_000_000)))).id,
    );
  const created = (await files.execute("c", "create_visualization", {
    title: "T",
    description: "D",
    html: ids.map((id) => `<img src="truex-file:${id}">`).join(""),
  })) as { id: string };
  const shown = await files.visualization("c", created.id);
  const left = ids.filter((id) => shown.html.includes(`truex-file:${id}`));
  // 4 MiB allows four images of just under 1 MB, not the fifth.
  assert.deepEqual(left, [ids[4]]);
  assert.ok(shown.html.length < 6 * 1_048_576);
});

test("preview shows images and says which references did not resolve", async (t) => {
  const { files, seen } = await setup(t);
  const logo = await files.upload("c", "logo.png", b64(PNG));
  const missing = "11111111-1111-1111-1111-111111111111";
  const preview = (await files.execute("c", "preview_visualization", {
    html: `<img src="truex-file:${logo.id}"><img src="truex-file:${missing}">`,
    appearance: "dark",
  })) as { hint?: string };
  const sent = seen.at(-1)!;
  assert.ok(
    (sent.html as string).includes(`data:image/png;base64,${b64(PNG)}`),
  );
  assert.ok((sent.html as string).includes(`truex-file:${missing}`));
  assert.match(preview.hint!, new RegExp(`truex-file:${missing}`));
  assert.equal(preview.hint!.includes(logo.id), false);
  // Nothing to say when every reference worked.
  const clean = (await files.execute("c", "preview_visualization", {
    html: `<img src="truex-file:${logo.id}">`,
  })) as { hint?: string };
  assert.equal(clean.hint, undefined);
});

test("publishing measures with the images in place", async (t) => {
  const { files, seen } = await setup(t);
  const logo = await files.upload("c", "logo.png", b64(PNG));
  await files.execute("c", "create_visualization", {
    title: "T",
    description: "D",
    html: `<img src="truex-file:${logo.id}">`,
  });
  const measured = seen.find((call) => call.options === "measure")!;
  assert.ok((measured.html as string).includes("data:image/png;base64,"));
});
