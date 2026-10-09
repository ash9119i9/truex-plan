export type DocumentKind =
  "code" | "text" | "sheet" | "slides" | "document" | "image";

const kinds: Record<string, [DocumentKind, string]> = {
  pdf: ["document", "PDF"],
  docx: ["document", "Word"],
  xlsx: ["sheet", "Excel"],
  pptx: ["slides", "PowerPoint"],
  csv: ["sheet", "CSV"],
  tsv: ["sheet", "TSV"],
  txt: ["text", "Text"],
  md: ["text", "Markdown"],
  abap: ["code", "ABAP"],
  cds: ["code", "CDS"],
  js: ["code", "JavaScript"],
  ts: ["code", "TypeScript"],
  json: ["code", "JSON"],
  xml: ["code", "XML"],
  yaml: ["code", "YAML"],
  yml: ["code", "YAML"],
  sql: ["code", "SQL"],
  html: ["code", "HTML"],
  properties: ["code", "Properties"],
  java: ["code", "Java"],
  py: ["code", "Python"],
  sh: ["code", "Shell"],
  png: ["image", "PNG"],
  jpg: ["image", "JPEG"],
  jpeg: ["image", "JPEG"],
  gif: ["image", "GIF"],
  webp: ["image", "WebP"],
};

// Classifies a conversation file by extension for its icon and type label.
export function documentKind(name: string): {
  kind: DocumentKind;
  label: string;
} {
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1].toLowerCase() ?? "";
  const [kind, label] = kinds[extension] ?? [
    "document",
    extension ? extension.toUpperCase() : "File",
  ];
  return { kind, label };
}

export const uploadAccept =
  ".pdf,.docx,.xlsx,.pptx,.txt,.md,.csv,.tsv,.abap,.cds,.json,.xml,.yaml,.sql,.js,.ts,.png,.jpg,.jpeg,.gif,.webp";
