import { SaxesParser } from "saxes";
import { PreviewError } from "./limits.ts";

// Office XML, parsed as a stream of events with no DOM, so it runs the same in
// a Web Worker and in Node tests. Names are namespace-aware: `<x:row>` and
// `<row>` under the same namespace are the same element.

export const NS = {
  sheet: "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
  slide: "http://schemas.openxmlformats.org/presentationml/2006/main",
  drawing: "http://schemas.openxmlformats.org/drawingml/2006/main",
  rels: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  packageRels: "http://schemas.openxmlformats.org/package/2006/relationships",
};

export type XmlElement = {
  local: string;
  uri: string;
  // An attribute by local name; `uri` for a prefixed one such as `r:id`.
  attr: (local: string, uri?: string) => string | undefined;
};

// Thrown from a handler to end parsing early without an error, for example
// once a sheet passes its row cap.
export const STOP = Symbol("stop parsing");

export type XmlHandlers = {
  open?: (element: XmlElement) => void;
  close?: (local: string, uri: string) => void;
  text?: (text: string) => void;
};

export function parseXml(xml: string, handlers: XmlHandlers): void {
  const parser = new SaxesParser({ xmlns: true });
  // Office parts never declare a DOCTYPE; one here is an entity attack.
  parser.on("doctype", () => {
    throw new PreviewError(
      "corrupt",
      "Not a readable file: XML has a DOCTYPE.",
    );
  });
  const { open, close, text } = handlers;
  if (open)
    parser.on("opentag", (tag) => {
      const attributes = Object.values(tag.attributes);
      open({
        local: tag.local,
        uri: tag.uri,
        attr: (local, uri = "") =>
          attributes.find((a) => a.local === local && a.uri === uri)?.value,
      });
    });
  if (close) parser.on("closetag", (tag) => close(tag.local, tag.uri));
  if (text) {
    parser.on("text", text);
    parser.on("cdata", text);
  }
  try {
    parser.write(xml).close();
  } catch (error) {
    if (error === STOP) return;
    if (error instanceof PreviewError) throw error;
    throw new PreviewError("corrupt", "Not a readable file: broken XML.");
  }
}
