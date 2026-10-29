import { open } from "node:fs/promises";

// Which of a chat's skills the model opened during a turn. Codex emits no
// thread item for its `skills.list` / `skills.read` tools (skills probe,
// 2026-10-23); the call is visible only in the thread's rollout file, which
// Codex appends before the reply that follows it starts. This reads what was
// appended since the turn began and reports each `skills.read` of a known
// slug. Nothing the model wrote leaves here except a slug the platform sent.

// Bytes read per poll. A longer stretch (large tool output) is skipped
// rather than held in memory; a skill read cut out by it is not reported.
const MAX_POLL_BYTES = 4 * 1024 * 1024;

export class SkillUseWatcher {
  private offset = 0;
  // An unfinished last line from the previous poll.
  private partial = "";
  private readonly reported = new Set<string>();
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly slugs: ReadonlySet<string>,
    private readonly onUse: (slug: string) => void,
  ) {}

  // Skips the thread's earlier turns: only what is appended from here counts.
  // Queued like a poll, so a poll asked for before it finishes reads after.
  begin(): Promise<void> {
    this.queue = this.queue.then(async () => {
      this.offset = await fileSize(this.path);
    });
    return this.queue;
  }

  // Reads what was appended since the last poll. Polls run one at a time, in
  // call order; a failed read (file rotated or gone) reports nothing.
  poll(): Promise<void> {
    this.queue = this.queue.then(() => this.read().catch(() => undefined));
    return this.queue;
  }

  private async read(): Promise<void> {
    const handle = await open(this.path, "r");
    let text: string;
    try {
      const size = (await handle.stat()).size;
      if (size < this.offset) {
        // Truncated or replaced: start over from its end.
        this.offset = size;
        this.partial = "";
        return;
      }
      const length = size - this.offset;
      if (length === 0) return;
      if (length > MAX_POLL_BYTES) {
        this.offset = size;
        this.partial = "";
        return;
      }
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, this.offset);
      this.offset = size;
      text = this.partial + buffer.toString("utf8");
    } finally {
      await handle.close();
    }
    const lines = text.split("\n");
    this.partial = lines.pop() ?? "";
    if (this.partial.length > MAX_POLL_BYTES) this.partial = "";
    for (const line of lines) {
      const slug = skillRead(line);
      if (slug && this.slugs.has(slug) && !this.reported.has(slug)) {
        this.reported.add(slug);
        this.onUse(slug);
      }
    }
  }
}

// The skill a rollout line's `skills.read` call names, from its `package`
// (`e0/<slug>` or `<slug>`). Cheap test first: most lines are not calls.
export function skillRead(line: string): string | undefined {
  if (!line.includes('"namespace":"skills"')) return undefined;
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return undefined;
  }
  const payload = (record as { type?: unknown; payload?: unknown }).payload as
    Record<string, unknown> | undefined;
  if (
    (record as { type?: unknown }).type !== "response_item" ||
    !payload ||
    payload.type !== "function_call" ||
    payload.namespace !== "skills" ||
    payload.name !== "read" ||
    typeof payload.arguments !== "string"
  )
    return undefined;
  let args: unknown;
  try {
    args = JSON.parse(payload.arguments);
  } catch {
    return undefined;
  }
  const pkg = (args as { package?: unknown } | null)?.package;
  if (typeof pkg !== "string") return undefined;
  return pkg.split("/").pop();
}

async function fileSize(path: string): Promise<number> {
  try {
    const handle = await open(path, "r");
    try {
      return (await handle.stat()).size;
    } finally {
      await handle.close();
    }
  } catch {
    return 0;
  }
}
