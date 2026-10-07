import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  readdir,
  rename,
  cp,
  stat,
} from "node:fs/promises";
import Ajv from "ajv";
import { join, extname } from "node:path";
import { Document, Packer, Paragraph, HeadingLevel } from "docx";
import ExcelJS from "exceljs";
import PptxGenJS from "pptxgenjs";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { unzipSync, strFromU8 } from "fflate";
import type { DynamicToolSpec } from "../../shared/protocol/v2/DynamicToolSpec";
import type { ConversationFile } from "../../shared/assistant-capabilities";
import { HttpError } from "./errors";
import type {
  Visualization,
  VisualAttachment,
} from "../../shared/visualizations";
import { validateVisualizationDocument } from "../../shared/visualization-document";
import {
  isVisualAttachment,
  visualizationIdPattern,
} from "../../shared/visualizations";
import { log } from "../../shared/logging";

const MAX_FILE = 1_048_576;
const MAX_TEXT = 100_000;
const media: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  json: "application/json",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  sql: "application/sql",
  md: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  js: "text/javascript",
  ...Object.fromEntries(
    ["abap", "cds", "ts", "txt", "html", "properties", "java", "py", "sh"].map(
      (e) => [e, "text/plain"],
    ),
  ),
};
const textFile = (name: string) =>
  /^(text\/|application\/(json|xml|yaml|sql)$)/.test(
    media[extname(name).slice(1).toLowerCase()] || "",
  );
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
    "html_render",
    "Publish a complete self-contained HTML document directly in this conversation above your text reply. Use inline CSS, JavaScript and data; no remote resources or local files. Supply a title and frame height. Publication does not require a browser. Supply sourceId for an immutable revision. Do not output HTML or a display marker in the answer.",
    {
      title: { type: "string", minLength: 1, maxLength: 120 },
      html: { type: "string", minLength: 1, maxLength: 180000 },
      height: { type: "integer", minimum: 160, maximum: 900 },
      description: { type: "string", minLength: 1, maxLength: 1000 },
      sourceId: string,
    },
    ["title", "html", "height"],
  ),
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
const validators = new Map(
  fileTools.map((tool) => {
    if (tool.type !== "function") throw new Error("Expected function tool");
    return [tool.name, ajv.compile<any>(tool.inputSchema as object)] as const;
  }),
);

function filename(value: unknown): string {
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
function fileId(id: unknown): string {
  if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id))
    throw new HttpError(400, "Invalid file identifier");
  return id;
}
function text(value: unknown, label = "Text"): string {
  if (typeof value !== "string" || value.length > MAX_TEXT)
    throw new HttpError(
      400,
      `${label} must be text of at most ${MAX_TEXT} characters`,
    );
  return value;
}
function officeParts(data: Buffer) {
  let total = 0,
    count = 0;
  return unzipSync(data, {
    filter(entry) {
      total += entry.originalSize;
      if (++count > 3000 || total > 20 * MAX_FILE)
        throw new HttpError(400, "Document expands beyond the supported size");
      return /\.xml$/.test(entry.name);
    },
  });
}
function xmlText(xml: string): string {
  return (xml.match(/<(?:w|a):t(?:\s[^>]*)?>[\s\S]*?<\/(?:w|a):t>/g) || [])
    .map((x) =>
      x
        .replace(/<[^>]+>/g, "")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&"),
    )
    .join("\n");
}

interface PublicationRecord {
  turnId: string;
  callId: string;
  inputHash: string;
}
interface StoredConversationFile extends ConversationFile {
  publication?: PublicationRecord;
}
export interface VisualInvocation {
  turnId: string;
  callId: string;
}
export class ConversationFiles {
  private queues = new Map<string, Promise<unknown>>();
  constructor(private readonly workspace: (threadId: string) => string) {}
  private directory(threadId: string) {
    return join(this.workspace(threadId), "files");
  }
  private async records(threadId: string): Promise<StoredConversationFile[]> {
    const dir = this.directory(threadId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const names = await readdir(dir);
    const records = await Promise.all(
      names
        .filter((n) => /^[a-f0-9-]{36}\.json$/.test(n))
        .map(
          async (n) =>
            JSON.parse(
              await readFile(join(dir, n), "utf8"),
            ) as StoredConversationFile,
        ),
    );
    return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async list(threadId: string): Promise<ConversationFile[]> {
    return (await this.records(threadId)).map(
      ({ publication, ...file }) => file,
    );
  }
  async publications(threadId: string): Promise<VisualAttachment[]> {
    return (await this.publicationRecords(threadId)).map(
      (record) => record.visual,
    );
  }
  async publicationRecords(
    threadId: string,
  ): Promise<{ visual: VisualAttachment; at: string }[]> {
    const directory = this.directory(threadId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const result: { visual: VisualAttachment; at: string }[] = [];
    for (const name of await readdir(directory)) {
      const id = name.replace(/\.json$/, "");
      if (!name.endsWith(".json") || !visualizationIdPattern.test(id)) continue;
      try {
        if ((await stat(join(directory, name))).size > 16384)
          throw new Error("metadata-size");
        const file: StoredConversationFile = JSON.parse(
          await readFile(join(directory, name), "utf8"),
        );
        if (!file.publication) continue;
        const visual = this.attachment(file);
        if (
          file.id !== id ||
          file.kind !== "visualization" ||
          file.sourceFormat !== "document" ||
          !isVisualAttachment(visual) ||
          !/^[a-f0-9]{64}$/.test(file.publication.inputHash) ||
          typeof file.createdAt !== "string" ||
          Number.isNaN(Date.parse(file.createdAt)) ||
          !Number.isInteger(file.size) ||
          file.size < 1 ||
          file.size > MAX_FILE ||
          (await stat(join(directory, id + ".bin"))).size !== file.size
        )
          throw new Error("invalid-publication");
        result.push({ visual, at: file.createdAt });
      } catch {
        // Corrupt artifacts cannot authorize a public association or block
        // unrelated chat recovery. Keep the source for operator repair.
        log("warn", "visual publication recovery skipped invalid record", {
          threadId,
          fileId: id,
        });
      }
    }
    return result.sort((a, b) => a.at.localeCompare(b.at));
  }
  private attachment(file: StoredConversationFile): VisualAttachment {
    return {
      id: file.id,
      title: file.title!,
      description: file.description!,
      height: file.height!,
      turnId: file.publication!.turnId,
      callId: file.publication!.callId,
    };
  }
  async get(threadId: string, id: string) {
    const dir = this.directory(threadId),
      key = fileId(id);
    try {
      const { publication, ...metadata }: StoredConversationFile = JSON.parse(
        await readFile(join(dir, key + ".json"), "utf8"),
      );
      return { ...metadata, data: await readFile(join(dir, key + ".bin")) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new HttpError(404, "File not found in this conversation");
      throw error;
    }
  }
  async upload(threadId: string, name: unknown, base64: unknown) {
    filename(name);
    if (
      !/\.(pdf|docx|xlsx|pptx|txt|md|csv|tsv|abap|cds|json|xml|yaml|sql|js|ts)$/i.test(
        name as string,
      )
    )
      throw new HttpError(
        400,
        "Upload a PDF, Word, Excel, PowerPoint, text, or code document",
      );
    if (
      typeof base64 !== "string" ||
      base64.length > Math.ceil(MAX_FILE / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        base64,
      )
    )
      throw new HttpError(400, "Upload must be a base64 file of at most 1 MB");
    return this.save(threadId, name as string, Buffer.from(base64, "base64"));
  }
  publish(threadId: string, name: string, data: Buffer) {
    return this.save(threadId, name, data);
  }
  private async save(
    threadId: string,
    name: string,
    data: Buffer,
    source?: unknown,
    sourceId?: string,
    visualization?: Pick<
      ConversationFile,
      "kind" | "title" | "description" | "mode" | "sourceFormat" | "height"
    >,
    publication?: PublicationRecord,
  ): Promise<ConversationFile> {
    filename(name);
    if (!data.length || data.length > MAX_FILE)
      throw new HttpError(400, "Files must contain between 1 byte and 1 MB");
    if (sourceId) await this.get(threadId, sourceId);
    const previous = this.queues.get(threadId) || Promise.resolve();
    const operation = previous
      .catch(() => {})
      .then(async () => {
        const files = await this.records(threadId);
        if (publication) {
          const prior = files.find(
            (file) =>
              file.publication?.turnId === publication.turnId &&
              file.publication.callId === publication.callId,
          );
          if (prior) {
            if (prior.publication!.inputHash !== publication.inputHash)
              throw new HttpError(
                409,
                "This visual call was already published with different content",
              );
            const { publication: ignored, ...record } = prior;
            return record;
          }
        }
        if (
          files.length >= 50 ||
          files.reduce((sum, f) => sum + f.size, 0) + data.length >
            25 * MAX_FILE
        )
          throw new HttpError(
            400,
            "Conversation file limit reached (50 files / 25 MB)",
          );
        const id = randomUUID(),
          dir = this.directory(threadId);
        const record: StoredConversationFile = {
          id,
          name,
          size: data.length,
          createdAt: new Date().toISOString(),
          mediaType:
            media[extname(name).slice(1).toLowerCase()] ||
            "application/octet-stream",
          ...(sourceId ? { sourceId } : {}),
          ...visualization,
          ...(publication ? { publication } : {}),
        };
        await writeFile(join(dir, id + ".bin"), data, { mode: 0o600 });
        if (source)
          await writeFile(join(dir, id + ".source"), JSON.stringify(source), {
            mode: 0o600,
          });
        await writeFile(join(dir, id + ".pending"), JSON.stringify(record), {
          mode: 0o600,
        });
        await rename(join(dir, id + ".pending"), join(dir, id + ".json"));
        const { publication: ignored, ...file } = record;
        return file;
      });
    this.queues.set(threadId, operation);
    try {
      return await operation;
    } finally {
      if (this.queues.get(threadId) === operation) this.queues.delete(threadId);
    }
  }
  async copy(from: string, to: string) {
    await this.list(from);
    await cp(this.directory(from), this.directory(to), { recursive: true });
  }
  async read(threadId: string, id: string, offset = 0) {
    if (!Number.isInteger(offset) || offset < 0)
      throw new HttpError(400, "Offset must be a nonnegative integer");
    const file = await this.get(threadId, id),
      extension = extname(file.name).slice(1).toLowerCase();
    let content: string;
    try {
      content = await readFile(
        join(this.directory(threadId), fileId(id) + ".source"),
        "utf8",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (textFile(file.name)) {
        if (file.data.includes(0))
          throw new HttpError(400, "This text file contains binary data");
        content = new TextDecoder("utf-8", { fatal: true }).decode(file.data);
      } else if (extension === "pdf") {
        const { PDFParse } = await import("pdf-parse");
        const parser = new PDFParse({
          data: file.data,
          isEvalSupported: false,
        });
        try {
          content = (await parser.getText({ first: 100 })).text;
        } finally {
          await parser.destroy();
        }
      } else if (["docx", "pptx", "xlsx"].includes(extension)) {
        const parts = officeParts(file.data);
        if (extension === "xlsx") {
          const book = new ExcelJS.Workbook();
          await book.xlsx.load(file.data as any);
          const sheets: unknown[] = [];
          book.eachSheet((sheet) => {
            const rows: unknown[] = [];
            sheet.eachRow((row) => {
              if (rows.length < 2000)
                rows.push((row.values as ExcelJS.CellValue[]).slice(1));
            });
            sheets.push({ name: sheet.name, rows });
          });
          content = JSON.stringify(sheets);
        } else {
          const names = Object.keys(parts)
            .filter((n) =>
              extension === "docx"
                ? n === "word/document.xml"
                : /^ppt\/slides\/slide\d+\.xml$/.test(n),
            )
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
          content = names.map((n) => xmlText(strFromU8(parts[n]))).join("\n\n");
        }
      } else {
        if (file.data.includes(0))
          throw new HttpError(
            400,
            "This binary file type cannot be read as text",
          );
        content = new TextDecoder("utf-8", { fatal: true }).decode(file.data);
      }
    }
    return {
      id,
      name: file.name,
      text: content.slice(offset, offset + 20000),
      nextOffset: offset + 20000 < content.length ? offset + 20000 : null,
      totalCharacters: content.length,
      note: "Document text extraction may omit images and layout. PDF extraction is limited to the first 100 pages; spreadsheets to 2000 rows per sheet. Read remaining text using nextOffset.",
    };
  }
  async visualization(threadId: string, id: string): Promise<Visualization> {
    const file = await this.get(threadId, id);
    if (file.kind !== "visualization")
      throw new HttpError(404, "Visualization not found in this conversation");
    return {
      id: file.id,
      title: file.title!,
      description: file.description!,
      mode: file.mode || "inline",
      html: file.data.toString("utf8"),
      ...(file.sourceFormat ? { sourceFormat: file.sourceFormat } : {}),
      ...(file.height !== undefined ? { height: file.height } : {}),
    };
  }
  async execute(
    threadId: string,
    name: string,
    args: any,
    invocation?: VisualInvocation,
  ) {
    const validate = validators.get(name);
    if (!validate || !validate(args) || JSON.stringify(args).length > 200000)
      throw new HttpError(400, "Invalid document tool arguments");
    if (name === "conversation_files")
      return { files: await this.list(threadId) };
    if (name === "read_conversation_file")
      return this.read(threadId, args.id, args.offset);
    if (name === "html_render") {
      if (
        !invocation ||
        typeof invocation.turnId !== "string" ||
        !invocation.turnId ||
        invocation.turnId.length > 200 ||
        typeof invocation.callId !== "string" ||
        !invocation.callId ||
        invocation.callId.length > 200
      )
        throw new HttpError(
          400,
          "Visual publication requires a main conversation turn and tool call",
        );
      if (!args.title.trim() || !validateVisualizationDocument(args.html))
        throw new HttpError(
          400,
          "Supply a title and complete HTML document with html, head and body elements",
        );
      if (args.sourceId) await this.visualization(threadId, args.sourceId);
      const publication: PublicationRecord = {
        ...invocation,
        inputHash: createHash("sha256")
          .update(
            JSON.stringify({
              title: args.title.trim(),
              html: args.html,
              height: args.height,
              description: args.description?.trim() || args.title.trim(),
              sourceId: args.sourceId || null,
            }),
          )
          .digest("hex"),
      };
      const file = await this.save(
        threadId,
        "visualization.html",
        Buffer.from(args.html),
        undefined,
        args.sourceId,
        {
          kind: "visualization",
          title: args.title.trim(),
          description: args.description?.trim() || args.title.trim(),
          mode: "inline",
          sourceFormat: "document",
          height: args.height,
        },
        publication,
      );
      return {
        id: file.id,
        title: file.title,
        published: true,
        visual: this.attachment({ ...file, publication }),
      };
    }
    if (name === "create_visualization") {
      if (!args.title.trim() || !args.description.trim() || !args.html.trim())
        throw new HttpError(
          400,
          "Supply a title, description and visualization fragment",
        );
      if (args.sourceId) await this.visualization(threadId, args.sourceId);
      const file = await this.save(
        threadId,
        "visualization.html",
        Buffer.from(args.html),
        undefined,
        args.sourceId,
        {
          kind: "visualization",
          title: args.title.trim(),
          description: args.description.trim(),
          mode: args.mode || "inline",
        },
      );
      return {
        id: file.id,
        title: file.title,
        reference: `[truex-visualization:${file.id}]`,
      };
    }
    if (name !== "create_document")
      throw new HttpError(400, "Unknown conversation tool");
    const title = text(args.title || "Untitled", "Title"),
      format = args.format;
    if (title.length > 200)
      throw new HttpError(400, "Title is limited to 200 characters");
    const nameWithExtension =
      filename(args.name).replace(/\.(pdf|docx|xlsx|pptx)$/i, "") +
      "." +
      format;
    let data: Buffer;
    if (format === "docx" || format === "pdf") {
      if (!Array.isArray(args.paragraphs) || !args.paragraphs.length)
        throw new HttpError(400, "Supply document paragraphs");
      const paragraphs: string[] = args.paragraphs.map((p: unknown) => text(p));
      if (format === "docx") {
        data = await Packer.toBuffer(
          new Document({
            sections: [
              {
                children: [
                  new Paragraph({ text: title, heading: HeadingLevel.TITLE }),
                  ...paragraphs.map((p) => new Paragraph(p)),
                ],
              },
            ],
          }),
        );
      } else {
        const pdf = await PDFDocument.create(),
          font = await pdf.embedFont(StandardFonts.Helvetica);
        let page = pdf.addPage(),
          y = page.getHeight() - 55;
        for (const paragraph of [title, ...paragraphs]) {
          let line = "";
          const draw = () => {
            if (y < 55) {
              page = pdf.addPage();
              y = page.getHeight() - 55;
            }
            page.drawText(line, { x: 50, y, size: 11, font });
            y -= 16;
            line = "";
          };
          for (const character of paragraph.replace(/\t/g, "    ")) {
            if (character === "\n") {
              draw();
              continue;
            }
            if (
              font.widthOfTextAtSize(line + character, 11) >
              page.getWidth() - 100
            )
              draw();
            line += character;
          }
          draw();
          y -= 10;
        }
        data = Buffer.from(await pdf.save());
      }
    } else if (format === "xlsx") {
      if (!Array.isArray(args.sheets) || !args.sheets.length)
        throw new HttpError(400, "Supply workbook sheets");
      const book = new ExcelJS.Workbook();
      for (const sheet of args.sheets) {
        const tab = book.addWorksheet(sheet.name);
        tab.addRows(sheet.rows);
        tab.getRow(1).font = { bold: true };
        tab.columns.forEach((column) => {
          column.width = 24;
        });
      }
      data = Buffer.from(await book.xlsx.writeBuffer());
    } else if (format === "pptx") {
      if (!Array.isArray(args.slides) || !args.slides.length)
        throw new HttpError(400, "Supply presentation slides");
      const deck = new PptxGenJS();
      deck.layout = "LAYOUT_WIDE";
      deck.title = title;
      for (const s of args.slides) {
        if (
          s.title.length > 120 ||
          s.bullets.some((b: string) => b.length > 250)
        )
          throw new HttpError(
            400,
            "Keep slide titles under 120 characters and bullets under 250 characters",
          );
        const slide = deck.addSlide();
        slide.addText(s.title, {
          x: 0.6,
          y: 0.4,
          w: 12,
          h: 0.8,
          fontSize: 28,
          bold: true,
          color: "183153",
          breakLine: false,
        });
        slide.addText(
          s.bullets.map((b: string) => ({
            text: b,
            options: { bullet: true, breakLine: true },
          })),
          {
            x: 0.7,
            y: 1.5,
            w: 11.9,
            h: 5.2,
            fontSize: 20,
            paraSpaceAfter: 14,
            fit: "shrink",
            valign: "top",
          },
        );
      }
      data = (await deck.write({ outputType: "nodebuffer" })) as Buffer;
    } else throw new HttpError(400, "Unsupported document format");
    return this.save(threadId, nameWithExtension, data, args, args.sourceId);
  }
}
