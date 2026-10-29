import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";

// A scripted stand-in for `codex app-server`, for orderings the real pin
// cannot be made to produce on demand (a goal turn starting at an exact
// moment). It speaks JSON lines on stdio like the real one. For each request
// method, the n-th call runs the n-th list of steps (the last list repeats);
// a method with no script is answered with `{}`. With `log`, each request is
// appended to that file as one JSON line `{method, params}` when read, and
// `{answering: method}` just before its answer is written.

export type Step =
  | { readonly respond: unknown }
  | { readonly notify: string; readonly params: Record<string, unknown> }
  | { readonly waitMs: number };

export type FakeScript = Readonly<Record<string, ReadonlyArray<Step[]>>>;

// Writes an executable fake into `dir` and returns its path.
export async function writeFakeCodex(
  dir: string,
  script: FakeScript,
  log?: string,
): Promise<string> {
  const path = join(dir, "fake-codex.mjs");
  await writeFile(
    path,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const script = ${JSON.stringify(script)};
const log = ${JSON.stringify(log ?? null)};
const calls = {};
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let queue = Promise.resolve();
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined || !message.method) return;
  if (log) appendFileSync(log, JSON.stringify({ method: message.method, params: message.params }) + "\\n");
  queue = queue.then(async () => {
    const lists = script[message.method];
    const n = calls[message.method] = (calls[message.method] ?? 0) + 1;
    const steps = lists ? lists[Math.min(n, lists.length) - 1] : [{ respond: {} }];
    for (const step of steps) {
      if ("waitMs" in step) await sleep(step.waitMs);
      else if ("notify" in step) write({ method: step.notify, params: step.params });
      else {
        // Before the answer: the adapter may end the process once it reads it.
        if (log) appendFileSync(log, JSON.stringify({ answering: message.method }) + "\\n");
        write({ id: message.id, result: step.respond });
      }
    }
  });
});
`,
  );
  await chmod(path, 0o755);
  return path;
}

// Codex's notifications for one lead turn, as the adapter reads them.
export const turnStarted = (threadId: string, turnId: string): Step => ({
  notify: "turn/started",
  params: { threadId, turn: { id: turnId, status: "inProgress" } },
});

export const replyText = (
  threadId: string,
  turnId: string,
  text: string,
): Step => ({
  notify: "item/completed",
  params: {
    threadId,
    turnId,
    item: { type: "agentMessage", id: `msg-${turnId}`, text },
  },
});

export const turnCompleted = (
  threadId: string,
  turnId: string,
  status = "completed",
): Step => ({
  notify: "turn/completed",
  params: { threadId, turn: { id: turnId, status, error: null } },
});
