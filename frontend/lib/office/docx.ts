import mammoth from "mammoth";
import { zipSync } from "fflate";
import { OFFICE_LIMITS, PreviewError, type OfficeLimits } from "./limits.ts";
import { mainPart } from "./package.ts";
import { openZip } from "./zip.ts";

// A Word document as HTML for the sandboxed frame. Every part is read through
// the bounded unzip first and handed to mammoth re-zipped without compression,
// so mammoth's own unzip never sees a size we haven't checked. Every link is
// removed and images are kept only when their bytes are a raster image.

export async function parseDocx(
  bytes: Uint8Array,
  limits: OfficeLimits = OFFICE_LIMITS,
): Promise<string> {
  const zip = openZip(bytes, limits);
  if (!zip.has(mainPart(zip, "word/document.xml")))
    throw new PreviewError("corrupt", "Not a readable file: no Word document.");
  const parts: Record<string, Uint8Array> = {};
  for (const name of zip.names) {
    if (name.endsWith("/")) continue;
    // Assigning it would set `parts`' prototype, and fflate would zip every
    // byte of the part as its own entry, past every check made above.
    if (name === "__proto__")
      throw new PreviewError(
        "corrupt",
        "Not a readable file: a part is named __proto__.",
      );
    const data = zip.read(name);
    // Word parts never declare a DOCTYPE; one here is an entity attack. Every
    // part is checked: the package's rels may point at any name as XML.
    if (hasDoctype(data))
      throw new PreviewError(
        "corrupt",
        "Not a readable file: XML has a DOCTYPE.",
      );
    parts[name] = data;
  }
  const stored = zipSync(parts, { level: 0 });

  // mammoth swallows a converter's error and leaves the image out, so a limit
  // is remembered here and thrown once it finishes.
  let overLimit: PreviewError | null = null;
  let images = 0;
  let imageBytes = 0;
  // Characters of image data in the HTML, which the length cap leaves out.
  let imageChars = 0;
  const convertImage = mammoth.images.imgElement(async (image) => {
    if (++images > limits.images)
      overLimit ??= new PreviewError(
        "too-large",
        "The document has too many images to preview.",
      );
    if (overLimit) throw overLimit;
    const data = new Uint8Array(await image.readAsArrayBuffer());
    imageBytes += data.length;
    if (data.length > limits.imageBytes || imageBytes > limits.imagesTotalBytes)
      throw (overLimit = new PreviewError(
        "too-large",
        "The document's images are too large to preview.",
      ));
    const src = imageSrc(data);
    if (!src) throw new Error("Not a raster image.");
    imageChars += src.length;
    return { src };
  });

  let html: string;
  try {
    ({ value: html } = await mammoth.convertToHtml(
      // Node's build reads `buffer`, the browser's `arrayBuffer`; JSZip takes
      // a Uint8Array for either.
      {
        arrayBuffer: stored.buffer,
        buffer: stored as unknown as Buffer,
      },
      {
        convertImage,
        // A style map in the file could map paragraphs to any element.
        includeEmbeddedStyleMap: false,
        externalFileAccess: false,
      },
    ));
  } catch (error) {
    if (error instanceof PreviewError) throw error;
    throw new PreviewError("corrupt", "Not a readable Word document.");
  }
  if (overLimit) throw overLimit;
  html = withoutLinks(html);
  if (html.length - imageChars > limits.docxHtmlChars)
    throw new PreviewError("too-large", "The document is too long to preview.");
  return html;
}

// Every <a> tag removed, keeping its text: body links, links in notes and
// comments, and mammoth's own note anchors. In a srcdoc frame even "#note-1"
// resolves against the app's address, so nothing in the frame may point
// anywhere. Safe as a pattern because mammoth escapes "<" in text and
// '"', "<" and ">" in attribute values.
function withoutLinks(html: string): string {
  return html.replace(/<\/?a(?=[\s>/])[^>]*>/g, "");
}

// "<!DOCTYPE" in any letter case, found in the bytes without decoding them.
function hasDoctype(bytes: Uint8Array): boolean {
  const word = "DOCTYPE";
  for (
    let at = bytes.indexOf(0x3c);
    at >= 0;
    at = bytes.indexOf(0x3c, at + 1)
  ) {
    if (bytes[at + 1] !== 0x21) continue;
    let i = 0;
    while (i < word.length && (bytes[at + 2 + i] & 0xdf) === word.charCodeAt(i))
      i++;
    if (i === word.length) return true;
  }
  return false;
}

// A data: URL for PNG, JPEG, GIF or WebP bytes; null for anything else,
// whatever the file says it is. SVG is left out: it can carry script.
export function imageSrc(bytes: Uint8Array): string | null {
  const starts = (at: number, ...head: number[]) =>
    head.every((byte, i) => bytes[at + i] === byte);
  const ascii = (at: number, text: string) =>
    starts(at, ...[...text].map((c) => c.charCodeAt(0)));
  const type = starts(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
    ? "png"
    : starts(0, 0xff, 0xd8, 0xff)
      ? "jpeg"
      : ascii(0, "GIF87a") || ascii(0, "GIF89a")
        ? "gif"
        : ascii(0, "RIFF") && ascii(8, "WEBP")
          ? "webp"
          : null;
  return type && `data:image/${type};base64,${base64(bytes)}`;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}
