import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  readdir,
  rename,
  cp,
} from "node:fs/promises";
import { join, extname } from "node:path";
import type { ConversationFile } from "../../../../shared/assistant-capabilities";
import type { Visualization } from "../../../../shared/visualizations";
import { HttpError } from "../../errors";
import { MAX_FILE, validators, filename, fileId, text } from "./specs";
import { media, readDocument, renderDocument } from "./formats";

export class ConversationFiles {
  private queues = new Map<string, Promise<unknown>>();
  constructor(private readonly workspace: (threadId: string) => string) {}
  private directory(threadId: string) {
    return join(this.workspace(threadId), "files");
  }
  async list(threadId: string): Promise<ConversationFile[]> {
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
            ) as ConversationFile,
        ),
    );
    return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async get(threadId: string, id: string) {
    const dir = this.directory(threadId),
      key = fileId(id);
    try {
      const metadata: ConversationFile = JSON.parse(
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
      "kind" | "title" | "description" | "mode"
    >,
  ): Promise<ConversationFile> {
    filename(name);
    if (!data.length || data.length > MAX_FILE)
      throw new HttpError(400, "Files must contain between 1 byte and 1 MB");
    if (sourceId) await this.get(threadId, sourceId);
    const previous = this.queues.get(threadId) || Promise.resolve();
    const operation = previous
      .catch(() => {})
      .then(async () => {
        const files = await this.list(threadId);
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
        const record: ConversationFile = {
          id,
          name,
          size: data.length,
          createdAt: new Date().toISOString(),
          mediaType:
            media[extname(name).slice(1).toLowerCase()] ||
            "application/octet-stream",
          ...(sourceId ? { sourceId } : {}),
          ...visualization,
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
        return record;
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
      content = await readDocument(file, extension);
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
    };
  }
  async execute(threadId: string, name: string, args: any) {
    const validate = validators.get(name);
    if (!validate || !validate(args) || JSON.stringify(args).length > 200000)
      throw new HttpError(400, "Invalid document tool arguments");
    if (name === "conversation_files")
      return { files: await this.list(threadId) };
    if (name === "read_conversation_file")
      return this.read(threadId, args.id, args.offset);
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
    const data = await renderDocument(args, title, format);
    return this.save(threadId, nameWithExtension, data, args, args.sourceId);
  }
}
