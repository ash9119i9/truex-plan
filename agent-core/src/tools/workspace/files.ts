import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { HttpError } from "../../errors";
import { MB, workspaceLimits as L, ajv, validators } from "./specs";
import { PARTIAL, segments, code, toolError } from "./paths";
import { globRegex, searchRegex, matchLines } from "./search";

// ignoreBOM keeps a leading BOM in the text so edits and appends preserve it.
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function lines(text: string) {
  if (!text) return [];
  const all = text.split("\n");
  if (all[all.length - 1] === "") all.pop();
  return all;
}
function count(text: string, search: string) {
  let n = 0;
  for (
    let i = text.indexOf(search);
    i >= 0;
    i = text.indexOf(search, i + search.length)
  )
    n++;
  return n;
}
type Entry = { path: string; type: "file" | "folder"; size: number };

export class WorkspaceFiles {
  private queues = new Map<string, Promise<unknown>>();
  constructor(
    private readonly workspace: (threadId: string) => string,
    private readonly publish: (
      threadId: string,
      name: string,
      data: Buffer,
    ) => Promise<{ id: string; name: string }>,
  ) {}
  private async root(threadId: string) {
    const root = resolve(this.workspace(threadId), "work");
    await mkdir(root, { recursive: true, mode: 0o700 });
    if (!(await lstat(root)).isDirectory())
      throw new HttpError(400, "Workspace is unavailable");
    return root;
  }
  private queue<T>(threadId: string, task: () => Promise<T>): Promise<T> {
    const operation = (this.queues.get(threadId) || Promise.resolve())
      .catch(() => {})
      .then(task);
    this.queues.set(threadId, operation);
    return operation.finally(() => {
      if (this.queues.get(threadId) === operation) this.queues.delete(threadId);
    });
  }
  /** Resolves a path inside root, refusing symlinks and non-folder parents. */
  private async locate(
    root: string,
    value: unknown,
    allowRoot = false,
    anyLeaf = false,
  ) {
    const parts = segments(value, allowRoot);
    const target = resolve(root, ...parts);
    if (target !== root && !target.startsWith(root + sep))
      throw new HttpError(400, "Path escapes the workspace");
    let current = root,
      exists: "file" | "folder" | null = "folder";
    for (let i = 0; i < parts.length; i++) {
      current = join(current, parts[i]);
      try {
        const stat = await lstat(current);
        // delete_file may remove a planted link or special file itself (never its target).
        if (
          anyLeaf &&
          i === parts.length - 1 &&
          !stat.isFile() &&
          !stat.isDirectory()
        ) {
          exists = "file";
          break;
        }
        if (stat.isSymbolicLink())
          throw new HttpError(
            400,
            "Symbolic links are not allowed in the workspace",
          );
        if (!stat.isFile() && !stat.isDirectory())
          throw new HttpError(
            400,
            "Only regular files and folders are supported",
          );
        if (i < parts.length - 1 && !stat.isDirectory())
          throw new HttpError(
            400,
            `${parts.slice(0, i + 1).join("/")} is a file, not a folder`,
          );
        exists = stat.isDirectory() ? "folder" : "file";
      } catch (error) {
        if (code(error) !== "ENOENT") throw error;
        exists = null;
        break;
      }
    }
    return { target, rel: parts.join("/"), parts, exists };
  }
  private async walk(root: string, start: string, limit = Infinity) {
    const entries: Entry[] = [];
    const stack = [start];
    let truncated = false;
    while (stack.length) {
      const dir = stack.pop()!;
      let items;
      try {
        items = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
          a.name.localeCompare(b.name),
        );
      } catch (error) {
        // A folder a script made unreadable (or removed) must not break every tool.
        if (
          dir !== start &&
          ["EACCES", "EPERM", "ENOENT"].includes(code(error)!)
        )
          continue;
        throw error;
      }
      const folders: string[] = [];
      for (const item of items) {
        if (item.name.startsWith(PARTIAL)) continue;
        const full = join(dir, item.name),
          rel = full
            .slice(root.length + 1)
            .split(sep)
            .join("/");
        if (item.isDirectory()) {
          folders.push(full);
          entries.push({ path: rel, type: "folder", size: 0 });
        } else if (item.isFile())
          entries.push({
            path: rel,
            type: "file",
            size: (await lstat(full).catch(() => ({ size: 0 }))).size,
          });
        if (entries.length >= limit) {
          truncated = true;
          return {
            entries: entries.sort((a, b) => a.path.localeCompare(b.path)),
            truncated,
          };
        }
      }
      stack.push(...folders.reverse());
    }
    return {
      entries: entries.sort((a, b) => a.path.localeCompare(b.path)),
      truncated,
    };
  }
  private async usage(root: string) {
    const { entries } = await this.walk(root, root);
    const files = entries.filter((e) => e.type === "file");
    return {
      files: files.length,
      folders: entries.length - files.length,
      bytes: files.reduce((sum, f) => sum + f.size, 0),
    };
  }
  private async readBytes(target: string, rel: string) {
    let handle;
    try {
      // O_NONBLOCK: opening a FIFO swapped in after locate() must not hang.
      handle = await open(
        target,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      if (code(error) === "ENOENT")
        throw new HttpError(404, `File not found: ${rel}`);
      if (code(error) === "ELOOP")
        throw new HttpError(
          400,
          "Symbolic links are not allowed in the workspace",
        );
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (stat.isDirectory())
        throw new HttpError(400, `${rel} is a folder, not a file`);
      if (!stat.isFile())
        throw new HttpError(400, "Only regular files are supported");
      // A hard link (e.g. created by a script) may point at a file outside the workspace.
      if (stat.nlink > 1)
        throw new HttpError(
          400,
          `${rel} is a hard link; only plain workspace files can be read`,
        );
      if (stat.size > L.fileBytes)
        throw new HttpError(
          413,
          `${rel} exceeds the ${L.fileBytes / MB} MB file limit`,
        );
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  }
  private async readText(target: string, rel: string) {
    const data = await this.readBytes(target, rel);
    try {
      if (data.includes(0)) throw new Error();
      return decoder.decode(data);
    } catch {
      throw new HttpError(400, `${rel} is not a UTF-8 text file`);
    }
  }
  private async save(
    root: string,
    file: Awaited<ReturnType<WorkspaceFiles["locate"]>>,
    text: string,
  ) {
    const data = Buffer.from(text, "utf8");
    if (data.length > L.fileBytes)
      throw new HttpError(
        413,
        `${file.rel} would be ${(data.length / MB).toFixed(2)} MB; files are limited to ${L.fileBytes / MB} MB. Split it into several files.`,
      );
    if (file.exists === "folder")
      throw new HttpError(400, `${file.rel} is a folder, not a file`);
    const use = await this.usage(root);
    const previous = file.exists ? (await lstat(file.target)).size : 0;
    if (!file.exists && use.files >= L.files)
      throw new HttpError(413, `The workspace is limited to ${L.files} files`);
    if (use.bytes - previous + data.length > L.totalBytes)
      throw new HttpError(
        413,
        `The workspace is limited to ${L.totalBytes / MB} MB in total`,
      );
    const parent = resolve(file.target, "..");
    if (parent !== root) {
      const missing =
        file.parts.length - 1 - (await this.existingDepth(root, file.parts));
      if (use.folders + missing > L.folders)
        throw new HttpError(
          413,
          `The workspace is limited to ${L.folders} folders`,
        );
      try {
        await mkdir(parent, { recursive: true, mode: 0o700 });
      } catch (error) {
        if (["ENOTDIR", "EEXIST"].includes(code(error)!))
          throw new HttpError(
            400,
            `A parent of ${file.rel} is a file, not a folder`,
          );
        throw error;
      }
    }
    const partial = join(parent, `${PARTIAL}${randomUUID()}`);
    const handle = await open(
      partial,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(data);
      await handle.close();
      await rename(partial, file.target);
    } catch (error) {
      await handle.close().catch(() => {});
      await rm(partial, { force: true });
      throw error;
    }
    return { path: file.rel, bytes: data.length, lines: lines(text).length };
  }
  private async existingDepth(root: string, parts: string[]) {
    let depth = 0,
      current = root;
    for (const part of parts.slice(0, -1)) {
      current = join(current, part);
      try {
        await lstat(current);
        depth++;
      } catch {
        break;
      }
    }
    return depth;
  }
  async execute(threadId: string, name: string, args: any): Promise<unknown> {
    const validate = validators.get(name);
    if (!validate) throw new HttpError(400, `Unknown workspace tool: ${name}`);
    if (!validate(args))
      throw new HttpError(
        400,
        `Invalid workspace tool arguments: ${ajv.errorsText(validate.errors)}`,
      );
    for (const key of ["content", "old_string", "new_string"])
      if (
        typeof args[key] === "string" &&
        Buffer.byteLength(args[key]) > L.contentBytes
      )
        throw new HttpError(
          413,
          `${key} is limited to 1 MB per call; send large files in parts with append_file`,
        );
      // A lone surrogate (e.g. an emoji split across append calls) would be saved as U+FFFD.
      else if (
        typeof args[key] === "string" &&
        /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(
          args[key],
        )
      )
        throw new HttpError(
          400,
          `${key} contains a broken character (lone UTF-16 surrogate); send whole characters in each call`,
        );
    return this.queue(threadId, () => this.run(threadId, name, args)).catch(
      toolError,
    );
  }
  private async run(
    threadId: string,
    name: string,
    args: any,
  ): Promise<unknown> {
    const root = await this.root(threadId);
    if (name === "list_files") {
      const at = await this.locate(root, args.path ?? "", true);
      if (!at.exists) throw new HttpError(404, `Not found: ${at.rel}`);
      const use = await this.usage(root);
      const listing =
        at.exists === "file"
          ? {
              entries: [
                {
                  path: at.rel,
                  type: "file",
                  size: (await lstat(at.target)).size,
                },
              ],
              truncated: false,
            }
          : await this.walk(root, at.target, L.listEntries);
      return {
        path: at.rel || ".",
        ...listing,
        usage: {
          ...use,
          limits: {
            files: L.files,
            bytes: L.totalBytes,
            fileBytes: L.fileBytes,
          },
        },
      };
    }
    if (name === "search_files") {
      const regex = searchRegex(args.pattern, args.literal, args.ignore_case);
      const glob = args.glob ? globRegex(args.glob) : null;
      const at = await this.locate(root, args.path ?? "", true);
      if (!at.exists) throw new HttpError(404, `Not found: ${at.rel}`);
      const files =
        at.exists === "file"
          ? [
              {
                path: at.rel,
                type: "file",
                size: (await lstat(at.target)).size,
              } as Entry,
            ]
          : (await this.walk(root, at.target)).entries.filter(
              (e) => e.type === "file",
            );
      const matches: string[] = [],
        skipped: string[] = [];
      let truncated = false;
      const budget = { ms: L.searchMs };
      // Globs such as *a*a*a*a*b backtrack badly too, so they share the vm budget.
      const globbed = glob
        ? new Set(
            matchLines(
              glob,
              files.map((f) =>
                args.glob.includes("/") ? f.path : f.path.split("/").pop()!,
              ),
              Infinity,
              budget,
            ),
          )
        : null;
      for (const [index, file] of files.entries()) {
        if (globbed && !globbed.has(index)) continue;
        if (file.size > L.fileBytes) {
          skipped.push(file.path);
          continue;
        }
        let text: string;
        try {
          text = await this.readText(
            join(root, ...file.path.split("/")),
            file.path,
          );
        } catch {
          skipped.push(file.path);
          continue;
        }
        // CRLF files: search the line without its \r so $ matches the line end.
        const all = lines(text).map((l) =>
          l.endsWith("\r") ? l.slice(0, -1) : l,
        );
        for (const i of matchLines(
          regex,
          all,
          L.searchMatches - matches.length,
          budget,
        )) {
          const line = all[i].slice(0, L.searchLineChars + 1);
          if (matches.length >= L.searchMatches) {
            truncated = true;
            break;
          }
          const shown =
            line.length > L.searchLineChars
              ? line.slice(0, L.searchLineChars) + "…"
              : line;
          matches.push(`${file.path}:${i + 1}:${shown}`);
        }
        if (truncated) break;
      }
      return {
        matches,
        count: matches.length,
        truncated,
        ...(skipped.length ? { skipped } : {}),
      };
    }
    const file = await this.locate(
      root,
      args.path,
      false,
      name === "delete_file",
    );
    if (name === "write_file") return this.save(root, file, args.content);
    if (name === "append_file") {
      const existing = file.exists
        ? await this.readText(file.target, file.rel)
        : "";
      const result = await this.save(root, file, existing + args.content);
      return { ...result, appendedBytes: Buffer.byteLength(args.content) };
    }
    if (name === "edit_file") {
      if (!file.exists) throw new HttpError(404, `File not found: ${file.rel}`);
      const text = await this.readText(file.target, file.rel);
      if (args.old_string === args.new_string)
        throw new HttpError(400, "old_string and new_string are identical");
      const found = count(text, args.old_string);
      if (!found)
        throw new HttpError(
          400,
          `old_string was not found in ${file.rel}; read the file and copy the exact text including whitespace`,
        );
      if (found > 1 && !args.replace_all)
        throw new HttpError(
          400,
          `old_string matches ${found} times in ${file.rel}; include more surrounding text to make it unique, or set replace_all`,
        );
      const updated = args.replace_all
        ? text.split(args.old_string).join(args.new_string)
        : text.replace(args.old_string, () => args.new_string);
      return {
        ...(await this.save(root, file, updated)),
        replacements: args.replace_all ? found : 1,
      };
    }
    if (name === "read_file") {
      if (!file.exists) throw new HttpError(404, `File not found: ${file.rel}`);
      const all = lines(await this.readText(file.target, file.rel));
      const offset = args.offset ?? 1,
        limit = args.limit ?? L.readLines;
      if (offset > Math.max(all.length, 1))
        throw new HttpError(
          400,
          `offset ${offset} is beyond the end of ${file.rel} (${all.length} lines)`,
        );
      const out: string[] = [];
      let chars = 0,
        end = offset - 1;
      for (
        let i = offset - 1;
        i < Math.min(all.length, offset - 1 + limit);
        i++
      ) {
        const line =
          all[i].length > L.lineChars
            ? all[i].slice(0, L.lineChars) +
              ` … [line truncated, ${all[i].length} characters]`
            : all[i];
        const entry = `${String(i + 1).padStart(6)}\t${line}`;
        if (out.length && chars + entry.length > L.readChars) break;
        out.push(entry);
        chars += entry.length + 1;
        end = i + 1;
      }
      const truncated = end < all.length;
      return {
        path: file.rel,
        content: out.join("\n"),
        startLine: offset,
        endLine: end,
        totalLines: all.length,
        truncated,
        nextOffset: truncated ? end + 1 : null,
      };
    }
    if (name === "delete_file") {
      if (!file.exists) throw new HttpError(404, `Not found: ${file.rel}`);
      // A script may have locked the folder (mode 000); it is ours, so unlock it first.
      if (file.exists === "folder")
        await chmod(file.target, 0o700).catch(() => {});
      await rm(file.target, { recursive: true, force: true });
      return { path: file.rel, deleted: file.exists };
    }
    if (name === "export_workspace_file") {
      if (!file.exists) throw new HttpError(404, `File not found: ${file.rel}`);
      const download = args.name ?? file.parts[file.parts.length - 1];
      if (/[\/\\\x00-\x1f]/.test(download) || download.startsWith("."))
        throw new HttpError(400, "Use a download name without folders");
      return this.publish(
        threadId,
        download,
        await this.readBytes(file.target, file.rel),
      );
    }
    throw new HttpError(400, `Unknown workspace tool: ${name}`);
  }
  clearTemp(threadId: string): Promise<void> {
    return this.queue(threadId, async () => {
      const root = await this.root(threadId);
      await rm(join(root, "tmp"), { recursive: true, force: true });
    });
  }
  copy(fromThreadId: string, toThreadId: string): Promise<void> {
    if (fromThreadId === toThreadId)
      return Promise.reject(
        new HttpError(400, "Cannot copy a workspace onto itself"),
      );
    // Hold both threads' queues, in a fixed order so opposite copies can't deadlock,
    // so writes or clearTemp on the source can't remove entries mid-copy.
    const [first, second] = [fromThreadId, toThreadId].sort();
    return this.queue(first, () =>
      this.queue(second, async () => {
        const from = await this.root(fromThreadId),
          to = await this.root(toThreadId);
        await cp(from, to, {
          recursive: true,
          filter: async (source) => {
            if (source.split(sep).pop()!.startsWith(PARTIAL)) return false;
            // An entry removed while copying (e.g. a finished partial write) is skipped.
            const stat = await lstat(source).catch(() => null);
            if (!stat) return false;
            // Hard links would copy outside content into a plain file; unreadable
            // files and folders (made by a script) would make the whole copy fail.
            if (stat.isFile() && stat.nlink !== 1) return false;
            if (!stat.isFile() && !stat.isDirectory()) return false;
            const mode = stat.isFile()
              ? constants.R_OK
              : constants.R_OK | constants.X_OK;
            return access(source, mode).then(
              () => true,
              () => false,
            );
          },
        });
      }),
    );
  }
}
