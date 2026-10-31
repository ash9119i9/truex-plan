import { imageSrc } from "./docx.ts";
import { OFFICE_LIMITS, PreviewError, type OfficeLimits } from "./limits.ts";
import { mainPart, readRels } from "./package.ts";
import { NS, parseXml } from "./xml.ts";
import { openZip } from "./zip.ts";

// A PowerPoint deck as one card per slide: its title, its text in reading
// order and its raster images. Layouts, themes and positions are not drawn;
// the download has those. Every part is read through the bounded unzip, and
// an image is kept only when its bytes are PNG, JPEG, GIF or WebP.

export type Slide = {
  title: string;
  paragraphs: string[];
  // data: URLs from imageSrc only.
  images: string[];
};
export type Deck = {
  slides: Slide[];
  // More slides than the preview shows.
  truncated: boolean;
};

const SLIDE_REL = "/slide";

export function parsePptx(
  bytes: Uint8Array,
  limits: OfficeLimits = OFFICE_LIMITS,
): Deck {
  const zip = openZip(bytes, limits);
  const main = mainPart(zip, "ppt/presentation.xml");
  if (!zip.has(main))
    throw new PreviewError("corrupt", "Not a readable file: no presentation.");
  const rels = readRels(zip, main);
  // Slides in the deck's order, as presentation.xml lists them.
  const order: string[] = [];
  parseXml(zip.text(main), {
    open: (el) => {
      if (el.local !== "sldId" || el.uri !== NS.slide) return;
      const rel = rels.get(el.attr("id", NS.rels) ?? "");
      if (rel && rel.type.endsWith(SLIDE_REL) && zip.has(rel.target))
        order.push(rel.target);
    },
  });
  const shown = order.slice(0, limits.slides);
  let images = 0;
  let imageBytes = 0;
  let chars = 0;
  const slides = shown.map((part) => {
    const slideRels = readRels(zip, part);
    const slide: Slide = { title: "", paragraphs: [], images: [] };
    // The shape being read, when inside one; text outside a shape (a table
    // cell) is body text.
    let shape: { title: boolean; paragraphs: string[] } | null = null;
    let paragraph: string | null = null;
    let inText = false;
    const add = (text: string) => {
      chars += text.length;
      if (chars > limits.docxHtmlChars)
        throw new PreviewError(
          "too-large",
          "The presentation has too much text to preview.",
        );
      (shape?.paragraphs ?? slide.paragraphs).push(text);
    };
    parseXml(zip.text(part), {
      open: (el) => {
        if (el.uri === NS.slide && el.local === "sp")
          shape = { title: false, paragraphs: [] };
        else if (el.uri === NS.slide && el.local === "ph" && shape) {
          const type = el.attr("type");
          if (type === "title" || type === "ctrTitle") shape.title = true;
        } else if (el.uri === NS.drawing && el.local === "p") paragraph = "";
        else if (el.uri === NS.drawing && el.local === "t") inText = true;
        else if (el.uri === NS.drawing && el.local === "br" && paragraph)
          paragraph += " ";
        else if (el.uri === NS.drawing && el.local === "blip") {
          const rel = slideRels.get(el.attr("embed", NS.rels) ?? "");
          if (!rel || !zip.has(rel.target)) return;
          // Read through the bounded unzip; only a picture that is shown
          // (a raster image) counts toward the image limits.
          const data = zip.read(rel.target);
          const src = imageSrc(data);
          if (!src) return;
          if (++images > limits.images)
            throw new PreviewError(
              "too-large",
              "The presentation has too many images to preview.",
            );
          imageBytes += data.length;
          if (
            data.length > limits.imageBytes ||
            imageBytes > limits.imagesTotalBytes
          )
            throw new PreviewError(
              "too-large",
              "The presentation's images are too large to preview.",
            );
          slide.images.push(src);
        }
      },
      text: (text) => {
        if (inText && paragraph !== null) paragraph += text;
      },
      close: (local, uri) => {
        if (uri === NS.drawing && local === "t") inText = false;
        else if (uri === NS.drawing && local === "p") {
          const text = paragraph?.trim();
          paragraph = null;
          if (text) add(text);
        } else if (uri === NS.slide && local === "sp" && shape) {
          const done: { title: boolean; paragraphs: string[] } = shape;
          shape = null;
          if (done.title && !slide.title)
            slide.title = done.paragraphs.join(" ");
          else slide.paragraphs.push(...done.paragraphs);
        }
      },
    });
    return slide;
  });
  return { slides, truncated: order.length > shown.length };
}
