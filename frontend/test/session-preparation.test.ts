import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionPreparation } from "../lib/session-preparation.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("concurrent submissions share one pending conversation creation", async () => {
  const preparation = new SessionPreparation<{ id: string }>();
  const startup = deferred<{ id: string }>();
  let requests = 0;
  const create = () => {
    requests++;
    return startup.promise;
  };
  const opened = preparation.prepare("draft-a", create);
  const replayed = preparation.prepare("draft-a", create);
  const sending = preparation.prepare("draft-a", create);
  const messages: string[] = [];
  const send = sending.promise.then((session) => messages.push(session.id));
  await Promise.resolve();
  assert.equal(requests, 1);
  assert.deepEqual(messages, [], "Send waits for the actual chat's startup");
  assert.equal(opened, replayed);
  assert.equal(opened, sending);
  startup.resolve({ id: "conversation-a" });
  await send;
  assert.deepEqual(messages, ["conversation-a"]);
});

test("a later submission reuses the created conversation", async () => {
  const preparation = new SessionPreparation<string>();
  let requests = 0;
  const create = async () => `conversation-${++requests}`;
  await preparation.prepare("draft-a", create).promise;
  const ready = await preparation.prepare("draft-a", create).promise;
  assert.equal(ready, "conversation-1");
  assert.equal(requests, 1);
});

test("switching drafts ignores an old startup even if it finishes last", async () => {
  const preparation = new SessionPreparation<string>();
  const oldStartup = deferred<string>();
  const newStartup = deferred<string>();
  const old = preparation.prepare("agent-a", () => oldStartup.promise);
  preparation.reset();
  const current = preparation.prepare("agent-b", () => newStartup.promise);
  let attached = "";
  const attach = (attempt: typeof old) =>
    attempt.promise.then((session) => {
      if (preparation.isCurrent(attempt)) attached = session;
    });
  const oldDone = attach(old);
  const newDone = attach(current);
  newStartup.resolve("conversation-b");
  await newDone;
  oldStartup.resolve("conversation-a");
  await oldDone;
  assert.equal(attached, "conversation-b");
});

test("opening history invalidates a pending draft without cancelling its POST", async () => {
  const preparation = new SessionPreparation<string>();
  const startup = deferred<string>();
  const draft = preparation.prepare("draft-a", () => startup.promise);
  preparation.reset();
  startup.resolve("unused-conversation");
  assert.equal(await draft.promise, "unused-conversation");
  assert.equal(preparation.isCurrent(draft), false);
});

test("an explicit new chat with the same agent starts a fresh conversation", async () => {
  const preparation = new SessionPreparation<string>();
  const old = preparation.prepare("same-agent", async () => "old");
  preparation.reset();
  const next = preparation.prepare("same-agent", async () => "new");
  assert.equal(await next.promise, "new");
  assert.equal(preparation.isCurrent(old), false);
  assert.equal(preparation.isCurrent(next), true);
});

test("a changed draft configuration never reuses the previous conversation", async () => {
  const preparation = new SessionPreparation<string>();
  const old = preparation.prepare("project-a:explicit", async () => "old");
  const next = preparation.prepare("project-b:proactive", async () => "new");
  assert.equal(await next.promise, "new");
  assert.equal(preparation.isCurrent(old), false);
});

test("a timed-out creation is not retried by another submission", async () => {
  const preparation = new SessionPreparation<string>();
  const startup = deferred<string>();
  let requests = 0;
  const create = () => {
    requests++;
    return startup.promise;
  };
  const opened = preparation.prepare("draft-a", create);
  const timeout = new Error("REQUEST_TIMEOUT: check Recents before retrying");
  const failed = assert.rejects(opened.promise, timeout);
  startup.reject(timeout);
  await failed;
  const send = preparation.prepare("draft-a", create);
  await assert.rejects(send.promise, timeout);
  assert.equal(send, opened);
  assert.equal(requests, 1);
});

test("synchronous startup errors use the same failure path", async () => {
  const preparation = new SessionPreparation<string>();
  const attempt = preparation.prepare("draft-a", () => {
    throw new Error("Cannot start");
  });
  await assert.rejects(attempt.promise, /Cannot start/);
});
