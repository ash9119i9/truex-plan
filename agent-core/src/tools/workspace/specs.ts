import Ajv from "ajv";
import type { DynamicToolSpec } from "../../../../shared/protocol/v2/DynamicToolSpec";

export const MB = 1_048_576;
export const workspaceLimits = {
  fileBytes: 2 * MB,
  totalBytes: 50 * MB,
  files: 2000,
  folders: 1000,
  contentBytes: MB,
  pathLength: 300,
  readLines: 2000,
  readMaxLines: 5000,
  readChars: 200_000,
  lineChars: 4000,
  listEntries: 1000,
  searchMatches: 200,
  searchLineChars: 300,
  patternLength: 500,
  searchMs: 2000,
};
const L = workspaceLimits;
const path = { type: "string", minLength: 1, maxLength: L.pathLength };
const content = { type: "string" };
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
const intro =
  "Workspace paths are relative POSIX paths (e.g. src/zreport.abap) inside this conversation's private workspace. Files persist across turns and context compaction; tmp/ is scratch space that is cleared after each task.";
export const workspaceTools: DynamicToolSpec[] = [
  tool(
    "write_file",
    `${intro} Create or overwrite a UTF-8 text file (parent folders are created). At most 1 MB per call and 2 MB per file. For large files write the first part here, then add the rest with append_file. To fix an existing file use edit_file instead of rewriting it. For long jobs keep a plan/progress file (e.g. PLAN.md) and update it as you go.`,
    { path, content },
    ["path", "content"],
  ),
  tool(
    "append_file",
    `${intro} Append text to the end of a file, creating it if missing. Use this to build large files (thousands of lines) in parts across several calls or turns; include the trailing newline yourself. At most 1 MB per call and 2 MB per file.`,
    { path, content },
    ["path", "content"],
  ),
  tool(
    "edit_file",
    `${intro} Replace an exact string in a file. old_string must match the file text exactly (including whitespace) and be unique unless replace_all is true; include surrounding lines to make it unique. Prefer this over rewriting files. Returns the number of replacements.`,
    {
      path,
      old_string: { type: "string", minLength: 1 },
      new_string: content,
      replace_all: { type: "boolean" },
    },
    ["path", "old_string", "new_string"],
  ),
  tool(
    "read_file",
    `${intro} Read a text file with line numbers. offset is the 1-based first line (default 1); limit is the number of lines (default 2000, max 5000). When truncated, continue with nextOffset. Line numbers are not part of the file content.`,
    {
      path,
      offset: { type: "integer", minimum: 1 },
      limit: { type: "integer", minimum: 1, maximum: L.readMaxLines },
    },
    ["path"],
  ),
  tool(
    "list_files",
    `${intro} List files and folders recursively with sizes (up to 1000 entries), plus workspace usage. path defaults to the workspace root.`,
    { path },
    [],
  ),
  tool(
    "search_files",
    `${intro} Search file contents and return path:line:text matches (up to 200). pattern is a JavaScript regular expression unless literal is true. path limits the search to a folder or file; glob filters relative paths (* and ? within a segment, ** across folders; a glob without / matches file names).`,
    {
      pattern: { type: "string", minLength: 1, maxLength: L.patternLength },
      path,
      glob: { type: "string", minLength: 1, maxLength: 200 },
      literal: { type: "boolean" },
      ignore_case: { type: "boolean" },
    },
    ["pattern"],
  ),
  tool(
    "delete_file",
    `${intro} Delete a file, or a folder and everything in it.`,
    { path },
    ["path"],
  ),
  tool(
    "export_workspace_file",
    `${intro} Publish a workspace file to the conversation so the user can download it. name optionally sets the download file name (default: the file's own name). Mention the exported file in your answer.`,
    { path, name: { type: "string", minLength: 1, maxLength: 120 } },
    ["path"],
  ),
];
export const ajv = new Ajv({ strict: false });
export const validators = new Map(
  workspaceTools.map((tool) => {
    if (tool.type !== "function") throw new Error("Expected function tool");
    return [tool.name, ajv.compile<any>(tool.inputSchema as object)] as const;
  }),
);
