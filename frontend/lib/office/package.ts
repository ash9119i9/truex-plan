import { NS, parseXml } from "./xml.ts";
import type { Zip } from "./zip.ts";

// Parts of an Office package (OPC): where a relationship points, and the
// relationships a part has.

export type Rel = { type: string; target: string };

// A relationship target, relative to the part that declares it, as a path in
// the zip. Null when it leaves the package.
export function resolvePart(from: string, target: string): string | null {
  let decoded = target;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    return null;
  }
  const path = decoded.startsWith("/")
    ? decoded.slice(1)
    : from.slice(0, from.lastIndexOf("/") + 1) + decoded;
  const parts: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(segment);
  }
  return parts.join("/");
}

// A part's relationships by id. External targets are left out; so are targets
// outside the package.
export function readRels(zip: Zip, part: string): Map<string, Rel> {
  const slash = part.lastIndexOf("/") + 1;
  const path = `${part.slice(0, slash)}_rels/${part.slice(slash)}.rels`;
  const rels = new Map<string, Rel>();
  if (!zip.has(path)) return rels;
  parseXml(zip.text(path), {
    open: (el) => {
      if (el.local !== "Relationship" || el.uri !== NS.packageRels) return;
      const id = el.attr("Id");
      const target = el.attr("Target");
      if (!id || !target || el.attr("TargetMode") === "External") return;
      const resolved = resolvePart(part, target);
      if (resolved)
        rels.set(id, { type: el.attr("Type") ?? "", target: resolved });
    },
  });
  return rels;
}

// The package's main document (word/document.xml, xl/workbook.xml …).
export function mainPart(zip: Zip, fallback: string): string {
  for (const rel of readRels(zip, "").values())
    if (rel.type.endsWith("/officeDocument") && zip.has(rel.target))
      return rel.target;
  return fallback;
}
