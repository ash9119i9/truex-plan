import { createHash } from "node:crypto";
import { join, relative, resolve, sep } from "node:path";

// What the adapter shows of Codex's commands and file changes, on approval
// cards and activity rows. Everything here is model-written or derived from
// it, so it is bounded and paths are made relative to the chat's workspace
// (absolute paths expose tenant and chat IDs).

// A command longer than this is declined, never shown cut short: the member
// must see everything they approve.
export const MAX_COMMAND_CHARS = 4000;
// Diff text an approval card shows; longer diffs are cut and flagged.
export const MAX_DIFF_CHARS = 16_000;
// Files listed per file change.
export const MAX_CHANGED_FILES = 50;
// Output kept per command for live events and the run's item list. Codex
// keeps the full output in its own history.
export const MAX_COMMAND_OUTPUT = 16_000;

// Control characters (except tab and newline) and bidi controls change how
// a command reads without changing what runs. A command containing them is
// declined rather than shown altered.
const HIDDEN =
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/;

export function hasHiddenCharacters(text: string): boolean {
  return HIDDEN.test(text);
}

// Codex runs every command as `<shell> -lc '<command>'`, or with double
// quotes when the command has a single quote. Inside single quotes nothing
// is special; inside double quotes only $, `, \ and " are. When the inner
// text has none of those it is exactly what runs, so the card shows just
// that; any other form is shown in full.
const SINGLE = /^(?:\/bin\/)?(?:ba|z)?sh -lc '([^']*)'$/s;
const DOUBLE = /^(?:\/bin\/)?(?:ba|z)?sh -lc "([^"$`\\]*)"$/s;

export function displayCommand(command: string): string {
  return SINGLE.exec(command)?.[1] ?? DOUBLE.exec(command)?.[1] ?? command;
}

// The key "Allow for this chat" stores for a command: the exact text Codex
// would run, so it re-allows only that same command.
export function commandScope(command: string): string {
  return createHash("sha256").update(command).digest("hex");
}

// Pushing publishes code, so it always asks and is never allowed for the chat.
// The rules file marks `git push` as prompt; this catches it inside chains too.
const PUSH = /\bgit\b[^\n;&|]*\bpush\b/;

export function isPush(command: string): boolean {
  return PUSH.test(command);
}

// Absolute paths in commands and their output name the tenant and chat
// (<state>/t/<tenant>/c/<chat>/…) and where the runtime keeps its state.
// Shown text names those places by the shell variables that hold them
// instead, so a shown command still means what ran.
export interface MaskedPlaces {
  readonly stateDir: string;
  // <state>/t/<tenant>/c/<chat>
  readonly chatRoot: string;
  readonly workspace: string; // $WORKSPACE
  readonly scratch: string; // $TMPDIR (and $HOME)
  readonly skillLinks: string; // $SKILLS
}

const SKILL_COPY = "[0-9a-f]{64}/";

export class PathMask {
  private readonly pattern: RegExp;
  private readonly labels: ReadonlyMap<string, string>;
  private readonly skillsRoots: readonly string[];

  // `aliases` are other spellings of the state directory (its real path).
  constructor(places: MaskedPlaces, aliases: readonly string[] = []) {
    const labels = new Map<string, string>();
    const skillsRoots: string[] = [];
    for (const state of new Set([places.stateDir, ...aliases])) {
      const swap = (path: string) =>
        state === places.stateDir
          ? path
          : join(state, relative(places.stateDir, path));
      labels.set(swap(places.workspace), "$WORKSPACE");
      labels.set(swap(places.scratch), "$TMPDIR");
      labels.set(swap(places.skillLinks), "$SKILLS");
      labels.set(swap(places.chatRoot), "<chat>");
      // A skill's stored copy, <state>/skills/<sha256>/<slug>, reads as the
      // $SKILLS link that points at it.
      skillsRoots.push(join(state, "skills") + "/");
      labels.set(state, "<state>");
    }
    this.labels = labels;
    this.skillsRoots = skillsRoots;
    const alternatives = [
      ...skillsRoots.map((root) => escape(root) + SKILL_COPY),
      // Longest first, so a chat's workspace wins over the chat itself.
      ...[...labels.keys()].sort((a, b) => b.length - a.length).map(escape),
    ];
    this.pattern = new RegExp(alternatives.join("|"), "g");
  }

  apply(text: string): string {
    if (!text) return text;
    return text.replace(this.pattern, (match) =>
      this.skillsRoots.some((root) => match.startsWith(root))
        ? "$SKILLS/"
        : (this.labels.get(match) ?? match),
    );
  }

  // Where unbroken streamed text can be cut so no place is split: at least
  // `longest` characters before the end (a place starting earlier is whole
  // in `text`), moved past any place that crosses that point.
  safeCut(text: string): number {
    let cut = text.length - this.longest;
    if (cut <= 0) return 0;
    for (const match of text.matchAll(this.pattern)) {
      const end = match.index + match[0].length;
      if (match.index < cut && end > cut) cut = end;
    }
    return cut;
  }

  // The longest text a place's name can span.
  private get longest(): number {
    return Math.max(
      ...[...this.labels.keys()].map((k) => k.length),
      ...this.skillsRoots.map((r) => r.length + 65),
    );
  }
}

// Unbroken command output held back while it might end inside a path.
export const OUTPUT_TAIL_LIMIT = 4096;

// Splits streamed output into what can be shown now (masked) and the tail
// to hold for the next delta. A path can arrive split across deltas, so
// output goes out a line at a time; a long unbroken tail goes out once it
// can no longer be the start of a masked place. `end` sends everything.
export function splitStreamed(
  mask: PathMask,
  text: string,
  end: boolean,
): { shown: string; tail: string } {
  const cut = end ? text.length : text.lastIndexOf("\n") + 1;
  let head = text.slice(0, cut);
  let tail = text.slice(cut);
  if (tail.length > OUTPUT_TAIL_LIMIT) {
    const safe = mask.safeCut(tail);
    head += tail.slice(0, safe);
    tail = tail.slice(safe);
  }
  return { shown: mask.apply(head), tail };
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Paths in a patch still being written are as the model wrote them, usually
// relative to the workspace (Codex's items carry absolute ones).
export function workspacePath(path: string, workspace: string): string {
  const rel = relative(workspace, resolve(workspace, path));
  if (rel === "") return ".";
  if (rel.startsWith("..") || rel.startsWith(sep)) return "(outside workspace)";
  return rel.split(sep).join("/");
}

export type ChangeKind = "add" | "update" | "delete" | "move";

export interface FileChange {
  readonly path: string;
  readonly kind: ChangeKind;
  readonly movePath?: string;
}

export interface ParsedChanges {
  readonly files: FileChange[];
  readonly diff: string;
  readonly diffTruncated: boolean;
}

// Codex's fileChange item `changes`: [{path, kind: {type, move_path?}, diff}].
export function parseChanges(raw: unknown, workspace: string): ParsedChanges {
  const files: FileChange[] = [];
  let diff = "";
  let diffTruncated = false;
  const list = Array.isArray(raw)
    ? (raw as Array<Record<string, unknown>>)
    : [];
  for (const change of list) {
    if (typeof change?.path !== "string") continue;
    const kindObj = (change.kind ?? {}) as Record<string, unknown>;
    const movePath =
      typeof kindObj.move_path === "string"
        ? workspacePath(kindObj.move_path, workspace)
        : undefined;
    const kind: ChangeKind =
      kindObj.type === "add"
        ? "add"
        : kindObj.type === "delete"
          ? "delete"
          : movePath
            ? "move"
            : "update";
    const path = workspacePath(change.path, workspace);
    if (files.length < MAX_CHANGED_FILES)
      files.push({ path, kind, ...(movePath ? { movePath } : {}) });
    const text = typeof change.diff === "string" ? change.diff : "";
    const section = `--- ${path}${movePath ? ` → ${movePath}` : ""} (${kind})\n${text}`;
    if (diff.length + section.length > MAX_DIFF_CHARS) {
      diff += section.slice(0, Math.max(0, MAX_DIFF_CHARS - diff.length));
      diffTruncated = true;
    } else diff += section.endsWith("\n") ? section : `${section}\n`;
  }
  if (list.length > MAX_CHANGED_FILES) diffTruncated = true;
  return { files, diff, diffTruncated };
}

// Lines written so far across a patch's changes: an added file's content, or
// an update's diff lines. For progress only.
export function changedLines(raw: unknown): number {
  if (!Array.isArray(raw)) return 0;
  let lines = 0;
  for (const change of raw as Array<Record<string, unknown>>) {
    const text = typeof change?.diff === "string" ? change.diff : "";
    if (!text) continue;
    lines += text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  }
  return lines;
}

// Characters of an added file's text sent as live preview, per patch.
export const MAX_PREVIEW_CHARS = 256 * 1024;
// Characters per update, so one event stays well under the platform's 1 MiB
// stream frame even when a whole file arrives at once (escaped JSON can be
// several times the text). The rest follows with the next update.
export const MAX_PREVIEW_PIECE_CHARS = 64 * 1024;

export interface PreviewState {
  readonly path: string;
  // Characters already sent.
  readonly sent: number;
  readonly truncated: boolean;
}

export interface PreviewUpdate {
  readonly path: string;
  // Where `text` starts in the file: always the previous update's end.
  readonly offset: number;
  readonly text: string;
  // The file is longer than the preview; the rest arrives with the file.
  readonly truncated: boolean;
}

// The next piece of the first added file's text in a patch the model is
// still writing, or null when there is nothing new. Only added files have
// their whole text in the patch; edits show progress without text.
export function previewUpdate(
  raw: unknown,
  workspace: string,
  prev: PreviewState | undefined,
): { update: PreviewUpdate; state: PreviewState } | null {
  if (!Array.isArray(raw) || prev?.truncated) return null;
  const change = (raw as Array<Record<string, unknown>>).find(
    (c) =>
      typeof c?.path === "string" &&
      (c.kind as Record<string, unknown> | undefined)?.type === "add" &&
      typeof c.diff === "string",
  );
  if (!change) return null;
  const path = workspacePath(change.path as string, workspace);
  if (path === "(outside workspace)") return null;
  if (prev && prev.path !== path) return null;
  const content = change.diff as string;
  const offset = prev?.sent ?? 0;
  if (content.length < offset) return null;
  const end = Math.min(MAX_PREVIEW_CHARS, offset + MAX_PREVIEW_PIECE_CHARS);
  let text = content.slice(offset, end);
  // Never end on half a surrogate pair; it is sent with the next piece.
  if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
  // This piece reaches the limit and the file goes on past it.
  const truncated =
    content.length > MAX_PREVIEW_CHARS &&
    offset + text.length >= MAX_PREVIEW_CHARS - 1;
  if (text === "" && !truncated) return null;
  return {
    update: { path, offset, text, truncated },
    state: { path, sent: offset + text.length, truncated },
  };
}
