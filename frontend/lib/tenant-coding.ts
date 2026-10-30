// Commands and file changes the assistant makes in a chat's workspace
// (platform-next coding profile). Wire parsers and plain-word labels; the
// transcript only renders. Everything here is model-written or derived from
// it, so it is bounded and rendered as plain text, never HTML.

// The connector name coding approvals carry. Not a valid connector slug, so
// it never collides with a real connector.
export const WORKSPACE = "@workspace";

// Kept in step with platform-next (run-executor / chat.ts).
export const MAX_COMMAND_CHARS = 4_000;
export const MAX_OUTPUT_CHARS = 16_000;
export const MAX_DIFF_CHARS = 16_000;
export const MAX_FILES = 50;
const MAX_PATH = 512;

export type ActivityStatus = "inProgress" | "completed" | "failed" | "declined";
export type FileKind = "add" | "update" | "delete" | "move";

export interface ActivityFile {
  path: string;
  kind: FileKind;
  movePath?: string;
}

export type ActivityDecision =
  "allow" | "allow_for_chat" | "deny" | "expired" | "cancelled";

export type Activity =
  | {
      type: "command";
      itemId: string;
      command: string;
      status: ActivityStatus;
      exitCode: number | null;
      durationMs: number | null;
      output: string;
      outputTruncated: boolean;
      approval: ActivityDecision | null;
    }
  | {
      type: "file_change";
      itemId: string;
      files: ActivityFile[];
      status: ActivityStatus;
      approval: ActivityDecision | null;
      // Set while the model is still writing the change, before it becomes
      // one: the lines written so far. Live only, never saved.
      writtenLines?: number;
      // A new file's text so far while it is written. Live only.
      preview?: FilePreview;
    };

export interface FilePreview {
  path: string;
  text: string;
  // The file is longer than the live text; the rest arrives with the file.
  truncated: boolean;
}

// Characters of live text kept per file (the platform's bound).
export const MAX_PREVIEW_CHARS = 256 * 1024;

const STATUSES: readonly ActivityStatus[] = [
  "inProgress",
  "completed",
  "failed",
  "declined",
];
const KINDS: readonly FileKind[] = ["add", "update", "delete", "move"];
const DECISIONS: readonly ActivityDecision[] = [
  "allow",
  "allow_for_chat",
  "deny",
  "expired",
  "cancelled",
];

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const oneOf = <T extends string>(
  value: unknown,
  all: readonly T[],
): T | null => (all.includes(value as T) ? (value as T) : null);
const int = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) ? value : null;

function files(value: unknown): ActivityFile[] {
  if (!Array.isArray(value)) return [];
  const out: ActivityFile[] = [];
  for (const raw of value) {
    const f = record(raw);
    const kind = oneOf(f?.kind, KINDS);
    if (!f || typeof f.path !== "string" || !f.path || !kind) continue;
    out.push({
      path: f.path.slice(0, MAX_PATH),
      kind,
      ...(typeof f.movePath === "string"
        ? { movePath: f.movePath.slice(0, MAX_PATH) }
        : {}),
    });
    if (out.length >= MAX_FILES) break;
  }
  return out;
}

// A live `activity` event or a snapshot/completed item of type command or
// file_change, or null when unreadable.
export function parseActivity(value: unknown): Activity | null {
  const a = record(value);
  const itemId = typeof a?.itemId === "string" ? a.itemId.slice(0, 200) : "";
  const status = oneOf(a?.status, STATUSES);
  if (!a || !itemId || !status) return null;
  const approval = oneOf(a.approval, DECISIONS);
  if (a.type === "command") {
    if (typeof a.command !== "string" || !a.command) return null;
    const output = typeof a.output === "string" ? a.output : "";
    return {
      type: "command",
      itemId,
      command: a.command.slice(0, MAX_COMMAND_CHARS),
      status,
      exitCode: int(a.exitCode),
      durationMs: int(a.durationMs),
      output: output.slice(0, MAX_OUTPUT_CHARS),
      outputTruncated:
        a.outputTruncated === true || output.length > MAX_OUTPUT_CHARS,
      approval,
    };
  }
  if (a.type === "file_change")
    return {
      type: "file_change",
      itemId,
      files: files(a.files),
      status,
      approval,
    };
  return null;
}

// A live `progress` event, or a snapshot's `writing` entry: a file change
// the model is still writing, or the end of one that never became a change.
// `piece` is the next part of a new file's text, starting at `offset` (0 in
// a snapshot, which carries all of it).
export function parseProgress(value: unknown):
  | {
      ended: false;
      activity: Activity;
      piece: (FilePreview & { offset: number }) | null;
    }
  | { ended: true; itemId: string }
  | null {
  const p = record(value);
  const itemId = typeof p?.itemId === "string" ? p.itemId.slice(0, 200) : "";
  if (!p || !itemId) return null;
  if (p.ended === true) return { ended: true, itemId };
  const lines = int(p.lines);
  const changed = files(p.files);
  if (lines === null || lines < 0 || changed.length === 0) return null;
  return {
    ended: false,
    activity: {
      type: "file_change",
      itemId,
      files: changed,
      status: "inProgress",
      approval: null,
      writtenLines: lines,
    },
    piece: previewPiece(p.preview),
  };
}

function previewPiece(
  value: unknown,
): (FilePreview & { offset: number }) | null {
  const p = record(value);
  const offset = int(p?.offset);
  if (
    !p ||
    typeof p.path !== "string" ||
    !p.path ||
    p.path.length > MAX_PATH ||
    typeof p.text !== "string" ||
    offset === null ||
    offset < 0 ||
    offset + p.text.length > MAX_PREVIEW_CHARS
  )
    return null;
  return {
    path: p.path,
    offset,
    text: p.text,
    truncated: p.truncated === true,
  };
}

// The live text after a piece: appended when it starts where the text so
// far ends, taken whole when it starts at 0 (a snapshot); anything else (a
// gap or another file) keeps what was there.
export function withPreviewPiece(
  current: FilePreview | undefined,
  piece: (FilePreview & { offset: number }) | null,
): FilePreview | undefined {
  if (!piece) return current;
  const { offset, ...next } = piece;
  if (offset === 0) return next;
  if (
    current &&
    !current.truncated &&
    current.path === piece.path &&
    current.text.length === offset
  )
    return { ...next, text: current.text + piece.text };
  return current;
}

// A saved tool message's `activity` payload ({kind: …}) as an Activity.
export function parseSavedActivity(
  value: unknown,
  itemId: string,
): Activity | null {
  const a = record(value);
  if (!a) return null;
  const type =
    a.kind === "command"
      ? "command"
      : a.kind === "file_change"
        ? "file_change"
        : null;
  return type ? parseActivity({ ...a, type, itemId }) : null;
}

// Appends live output to a command. Bounded like the platform's copy.
export function withOutput(activity: Activity, text: string): Activity {
  if (activity.type !== "command" || activity.outputTruncated || !text)
    return activity;
  const room = MAX_OUTPUT_CHARS - activity.output.length;
  return {
    ...activity,
    output: activity.output + text.slice(0, Math.max(0, room)),
    outputTruncated: text.length > room,
  };
}

// The row's one-line label, in plain words.
export function activityLabel(activity: Activity): string {
  if (activity.type === "command") {
    switch (activity.status) {
      case "inProgress":
        return "Running a command";
      case "declined":
        return "Command not run";
      case "failed":
        return activity.exitCode !== null
          ? `Command failed (exit ${activity.exitCode})`
          : "Command failed";
      default:
        return "Ran a command";
    }
  }
  const count = activity.files.length;
  const what = count === 1 ? activity.files[0].path : `${count} files`;
  const verbs = EDIT_VERBS[sharedKind(activity.files)];
  switch (activity.status) {
    case "inProgress":
      return `${verbs.doing} ${what}`;
    case "declined":
      return `${verbs.noun} ${what} not made`;
    case "failed":
      return `Couldn't ${verbs.base} ${what}`;
    default:
      return `${verbs.done} ${what}`;
  }
}

// One verb set per change kind; mixed or empty change sets read as edits.
const EDIT_VERBS: Record<
  FileKind | "mixed",
  { doing: string; done: string; base: string; noun: string }
> = {
  add: {
    doing: "Creating",
    done: "Created",
    base: "create",
    noun: "Creation of",
  },
  update: { doing: "Editing", done: "Edited", base: "edit", noun: "Edit to" },
  delete: {
    doing: "Deleting",
    done: "Deleted",
    base: "delete",
    noun: "Deletion of",
  },
  move: { doing: "Moving", done: "Moved", base: "move", noun: "Move of" },
  mixed: { doing: "Editing", done: "Edited", base: "edit", noun: "Edit to" },
};

function sharedKind(files: readonly ActivityFile[]): FileKind | "mixed" {
  const first = files[0]?.kind;
  if (!first) return "mixed";
  return files.every((file) => file.kind === first) ? first : "mixed";
}

// How much of a change the model has written so far ("120 lines"), or null
// when it is not being written or nothing is written yet.
export function writingNote(activity: Activity): string | null {
  if (activity.type !== "file_change" || !activity.writtenLines) return null;
  return activity.writtenLines === 1
    ? "1 line"
    : `${activity.writtenLines.toLocaleString("en-US")} lines`;
}

const FILE_VERB: Record<FileKind, string> = {
  add: "Added",
  update: "Changed",
  delete: "Deleted",
  move: "Moved",
};

export function fileLabel(file: ActivityFile): string {
  return file.movePath
    ? `${FILE_VERB[file.kind]} ${file.path} → ${file.movePath}`
    : `${FILE_VERB[file.kind]} ${file.path}`;
}

// What a coding request asks for, as its card and its record name it.
export function codingRequestName(type: "command" | "file_change"): string {
  return type === "command" ? "Run a command" : "Change files";
}

// What "Allow for this chat" means on this card, shown under the buttons.
export function allowForChatHint(tool: string): string | null {
  if (tool === "command")
    return "Allow for this chat allows only this exact command again.";
  return null;
}
