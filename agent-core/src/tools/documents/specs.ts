import Ajv from "ajv";
import type { DynamicToolSpec } from "../../../../shared/protocol/v2/DynamicToolSpec";
import { HttpError } from "../../errors";

export const MAX_FILE = 1_048_576;
const MAX_TEXT = 100_000;
const string = { type: "string" };
const tool = (
  name: string,
  description: string,
  properties: Record<string, any>,
  required: string[],
): DynamicToolSpec => ({
  type: "function",
  name,
  description,
  inputSchema: {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  },
});
export const fileTools: DynamicToolSpec[] = [
  tool(
    "create_visualization",
    "Create an interactive visual inside the conversation. Provide self-contained HTML/CSS/JavaScript with inline data, accessible controls, no external resources or document wrapper. Return the reference in the answer on its own line. Supply sourceId to create a revised version.",
    {
      title: { type: "string", minLength: 1, maxLength: 120 },
      description: { type: "string", minLength: 1, maxLength: 1000 },
      html: { type: "string", minLength: 1, maxLength: 180000 },
      mode: { type: "string", enum: ["inline", "wide"] },
      sourceId: string,
    },
    ["title", "description", "html"],
  ),
  tool(
    "conversation_files",
    "List uploaded files and generated documents available in this conversation.",
    {},
    [],
  ),
  tool(
    "read_conversation_file",
    "Read text from a conversation file by its id. PDF text extraction does not include OCR. Office extraction does not preserve visual layout. Generated documents include their editable source. Use offset for long files.",
    { id: string, offset: { type: "integer", minimum: 0 } },
    ["id"],
  ),
  tool(
    "create_document",
    "Create a downloadable document, or revised content as a new version. Does not preserve original Office/PDF formatting. For pdf/docx supply title and paragraphs. For xlsx supply sheets with name and rows of string/number/boolean/null cells. For pptx supply slides with title and bullets (up to 8 short bullets per slide). Supply sourceId when revising. PDF supports Western European text.",
    {
      name: string,
      format: { type: "string", enum: ["pdf", "docx", "xlsx", "pptx"] },
      title: string,
      paragraphs: { type: "array", items: string, maxItems: 1000 },
      sheets: {
        type: "array",
        maxItems: 20,
        items: {
          type: "object",
          properties: {
            name: string,
            rows: {
              type: "array",
              maxItems: 2000,
              items: {
                type: "array",
                maxItems: 100,
                items: { type: ["string", "number", "boolean", "null"] },
              },
            },
          },
          required: ["name", "rows"],
          additionalProperties: false,
        },
      },
      slides: {
        type: "array",
        maxItems: 50,
        items: {
          type: "object",
          properties: {
            title: string,
            bullets: { type: "array", items: string, maxItems: 8 },
          },
          required: ["title", "bullets"],
          additionalProperties: false,
        },
      },
      sourceId: string,
    },
    ["name", "format"],
  ),
];
const ajv = new Ajv({ strict: false });
export const validators = new Map(
  fileTools.map((tool) => {
    if (tool.type !== "function") throw new Error("Expected function tool");
    return [tool.name, ajv.compile<any>(tool.inputSchema as object)] as const;
  }),
);

export function filename(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[\p{L}\p{N}][\p{L}\p{N} ._()-]{0,119}$/u.test(value) ||
    value.includes("..")
  )
    throw new HttpError(
      400,
      "Use a filename of up to 120 characters without directories",
    );
  return value;
}
export function fileId(id: unknown): string {
  if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id))
    throw new HttpError(400, "Invalid file identifier");
  return id;
}
export function text(value: unknown, label = "Text"): string {
  if (typeof value !== "string" || value.length > MAX_TEXT)
    throw new HttpError(
      400,
      `${label} must be text of at most ${MAX_TEXT} characters`,
    );
  return value;
}
