import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { loadConfig } from "../../src/config";
import { threadResumeParams, threadStartParams } from "../../src/codex/config";
import type { ModelSettings } from "../../src/contract";
import { CodexProcess, type Notification } from "../../src/codex/rpc";
import { ModelFixture, sleep } from "../support/model-fixture";
import { TOKEN } from "../support/harness";

// Task 1 of tasks/goal-mode-todo.md: Codex goals (ext/goal) on the pin,
// observed directly with the fixture model. No adapter code uses goals yet;
// these assertions are the facts Tasks 3-5 and 9 build on.
//
// Findings (copied to the Risks table in tasks/goal-mode-plan.md):
// 1. Where goals are switched on. `features.goals` is stable and on by
//    default for the process; thread/goal/set|get|clear check only the
//    process config ("goals feature is disabled" only under
//    `-c features.goals=false`). The THREAD config's `features.goals` decides
//    whether the model is offered get_goal, create_goal and update_goal
//    (plain functions, next to update_plan) and whether Codex runs goal
//    turns. On today's text-only thread (features.goals false) a set is
//    accepted and stored as active, and nothing ever runs: the adapter must
//    refuse goal requests for a chat without `goals` itself.
// 2. The budget maximum is `goals.max_goal_token_budget`. In the thread
//    config it holds only while the thread is loaded; a set on an unloaded
//    thread reads the process config, which has none, so any budget passes.
//    As a process argument (`-c goals.max_goal_token_budget=N`, one process
//    per chat) it always holds. A goal set or created with no budget gets
//    the maximum; with no maximum a model-created goal has no budget. Codex
//    refuses objectives over 4000 characters.
// 3. A goal without a budget continues as fast as the model answers (at
//    least 10 fixture turns within 5 s; over 100 in 3 s in one run). Every
//    goal needs a budget.
// 4. `set {objective, status: active}` on an idle loaded thread starts a goal
//    turn inside the set: thread/goal/updated (turnId null), then
//    turn/started, with no client request. turn/started carries nothing that
//    marks it as a goal turn. Each goal turn's model request carries the
//    hidden continuation prompt; there is no userMessage item. Codex keeps
//    starting turns until the model's update_goal complete, reported as
//    thread/goal/updated with that turn's id; then nothing more starts.
// 5. A budget running out: tokensUsed counts non-cached input plus output.
//    The turn that reaches the budget completes normally, the goal becomes
//    budgetLimited, and no turn follows.
// 6. Interrupt alone ends the turn as interrupted and nothing continues, but
//    the goal stays active: the member's next turn is counted towards it and
//    Codex continues the goal after that turn. Pause, then interrupt: the
//    goal is paused, nothing continues, and later turns are not counted.
//    Stop must pause first (Task 5).
// 7. A model create_goal in a member's turn is reported (thread/goal/updated
//    with the member's turn id, active) before that turn completes, and
//    Codex continues the goal after it. A set paused while the member's turn
//    is still running prevents any continuation (Task 5 is feasible).
// 8. turn/start during a running goal turn is steered into it: the answer
//    names the goal turn's id and no turn/started follows. The answer to
//    every turn/start, steered or not, arrives before that turn's
//    turn/started. Codex handles one thread's requests in the order written:
//    set first, then turn/start: the goal turn starts and the member's text
//    is steered into it; turn/start first: the member's turn starts, is
//    counted towards the goal, and Codex continues after it. There is never
//    a second concurrent turn, but neither the order of events nor their
//    content tells the adapter that its turn/start was steered (Task 4).
// 9. On an unloaded thread, thread/goal/get and set (paused and active,
//    with a budget) work and start nothing. thread/resume sends a goal
//    snapshot (thread/goal/updated, turnId null) and then, finding the
//    thread idle with an active goal, starts a goal turn by itself: resuming
//    continues the goal.
// 10. The protocol goal has no goal id: threadId, objective, status,
//    tokenBudget, tokensUsed, timeUsedSeconds, createdAt, updatedAt, with
//    the timestamps in whole seconds. A goal the adapter set cannot be told
//    from a model-created one by id, and two updates in one second share an
//    updatedAt.

type Body = Record<string, unknown>;
type Item = Record<string, unknown>;

interface Goal {
  readonly threadId: string;
  readonly objective: string;
  readonly status: string;
  readonly tokenBudget: number | null;
  readonly tokensUsed: number;
  readonly timeUsedSeconds: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

// One Codex process and everything it said, in arrival order.
interface Proc {
  readonly codex: CodexProcess;
  readonly notes: Notification[];
  // stdout lines in the order Codex wrote them: a notification as its
  // method (and turn id), a response to turn/start as `response turn/start
  // <turnId>`. CodexProcess settles a request's promise a microtask after
  // reading its line, so promise order alone cannot say whether a
  // notification came first.
  readonly order: string[];
}

const PROMPT = "PROBE_GOAL_PROMPT";
const OBJECTIVE = "PROBE_OBJECTIVE: write the quarterly summary.";
const CONTINUATION = "Continue working toward the active thread goal.";

const goalsOn = (max?: number): Record<string, unknown> => ({
  "features.goals": true,
  ...(max ? { "goals.max_goal_token_budget": max } : {}),
});

const toolNames = (body: Body): string[] =>
  ((body.tools as Item[] | undefined) ?? []).map((t) =>
    String(t.name ?? t.type),
  );

describe("pinned Codex goals", () => {
  const model = new ModelFixture();
  let root = "";
  let workspace = "";
  let binary = "";
  let settings: ModelSettings;
  const procs: CodexProcess[] = [];

  before(async () => {
    await model.start();
    root = await mkdtemp(join(tmpdir(), "runtime-adapter-goals-"));
    workspace = join(root, "workspace");
    await mkdir(workspace);
    binary = loadConfig({
      RUNTIME_ADAPTER_TOKEN: TOKEN,
      RUNTIME_STATE_DIR: root,
    }).codexBinary;
    settings = {
      modelName: "fixture-model",
      gatewayUrl: model.url,
      gatewayToken: model.token,
      contextWindow: 100_000,
      autoCompactTokenLimit: 80_000,
    };
  });

  const defaultReply = model.defaultBehavior;
  beforeEach(() => {
    model.script.length = 0;
    model.router = undefined;
    model.defaultBehavior = defaultReply;
  });

  after(async () => {
    for (const codex of procs) await codex.stop();
    await model.close();
    await rm(root, { recursive: true, force: true });
  });

  // Every process shares one Codex home, so a later process sees an earlier
  // one's threads and goals (an adapter restart).
  async function launch(configArgs: string[] = []): Promise<Proc> {
    const codex = new CodexProcess({
      binary,
      home: root,
      workspace,
      rpcMs: 10_000,
      configArgs,
    });
    const notes: Notification[] = [];
    const order: string[] = [];
    codex.setListener((n) => notes.push(n));
    const target = codex as unknown as { handleLine(line: string): void };
    const read = target.handleLine.bind(codex);
    target.handleLine = (line: string) => {
      try {
        const m = JSON.parse(line) as {
          method?: string;
          params?: { turn?: { id?: string } };
          result?: { turn?: { id?: string } };
        };
        if (m.method) order.push(`${m.method} ${m.params?.turn?.id ?? ""}`);
        else if (m.result?.turn?.id)
          order.push(`response turn/start ${m.result.turn.id}`);
      } catch {
        // CodexProcess handles the fault.
      }
      read(line);
    };
    await codex.initialize();
    procs.push(codex);
    return { codex, notes, order };
  }

  async function startThread(p: Proc, extra = goalsOn()) {
    const params = threadStartParams(settings, PROMPT, workspace);
    const started = await p.codex.request<{ thread: { id: string } }>(
      "thread/start",
      { ...params, config: { ...params.config, ...extra } },
    );
    return started.thread.id;
  }

  async function resumeThread(p: Proc, threadId: string, extra = goalsOn()) {
    const params = threadResumeParams(threadId, settings, workspace);
    await p.codex.request("thread/resume", {
      ...params,
      config: { ...params.config, ...extra },
    });
  }

  const setGoal = (p: Proc, threadId: string, fields: Body) =>
    p.codex
      .request<{ goal: Goal }>("thread/goal/set", {
        threadId,
        origin: "user",
        ...fields,
      })
      .then((r) => r.goal);

  const getGoal = (p: Proc, threadId: string) =>
    p.codex
      .request<{ goal: Goal | null }>("thread/goal/get", { threadId })
      .then((r) => r.goal);

  const startTurn = (p: Proc, threadId: string, text: string) =>
    p.codex
      .request<{ turn: { id: string } }>("turn/start", {
        threadId,
        input: [{ type: "text", text, text_elements: [] }],
      })
      .then((r) => r.turn.id);

  const errorOf = (promise: Promise<unknown>) =>
    promise.then(
      () => "",
      (error: Error) => error.message,
    );

  async function until(check: () => boolean, ms = 20_000) {
    const deadline = Date.now() + ms;
    while (!check() && Date.now() < deadline) await sleep(20);
    return check();
  }

  const turnsStarted = (p: Proc, threadId: string) =>
    p.notes
      .filter(
        (n) => n.method === "turn/started" && n.params.threadId === threadId,
      )
      .map((n) => (n.params.turn as { id: string }).id);

  const completedTurn = (p: Proc, threadId: string, turnId: string) =>
    p.notes
      .filter(
        (n) =>
          n.method === "turn/completed" &&
          n.params.threadId === threadId &&
          (n.params.turn as { id: string }).id === turnId,
      )
      .map((n) => n.params.turn as { id: string; status: string })[0];

  const goalUpdates = (p: Proc, threadId: string) =>
    p.notes
      .filter(
        (n) =>
          n.method === "thread/goal/updated" && n.params.threadId === threadId,
      )
      .map((n) => ({
        turnId: n.params.turnId as string | null,
        goal: n.params.goal as Goal,
      }));

  const lastStatus = (p: Proc, threadId: string) =>
    goalUpdates(p, threadId).at(-1)?.goal.status;

  // Waits for `ms` and returns the turns that started meanwhile: the only way
  // to observe that Codex did NOT start a turn by itself.
  async function turnsDuring(p: Proc, threadId: string, ms: number) {
    const before = turnsStarted(p, threadId).length;
    await sleep(ms);
    return turnsStarted(p, threadId).slice(before);
  }

  const isContinuation = (body: Body) =>
    JSON.stringify(body.input ?? []).includes(CONTINUATION);

  test("goals are switched on per thread; the process default already allows the goal requests", async () => {
    const p = await launch();

    // Today's text-only thread (features.goals false in its thread config).
    const off = await startThread(p, {});
    const offSet = await errorOf(
      setGoal(p, off, { objective: OBJECTIVE, status: "active" }),
    );
    const offTurn = await startTurn(p, off, "hello");
    assert.ok(await until(() => !!completedTurn(p, off, offTurn)));
    const offTools = toolNames(model.lastRequest().body);
    const offAfter = await turnsDuring(p, off, 2000);

    // features.goals true in the thread config only.
    const on = await startThread(p, goalsOn());
    const onTurn = await startTurn(p, on, "hello");
    assert.ok(await until(() => !!completedTurn(p, on, onTurn)));
    const onTools = toolNames(model.lastRequest().body);

    // Goals off for the whole process (`-c features.goals=false`).
    const q = await launch(["features.goals=false"]);
    const qThread = await startThread(q, goalsOn());
    const qSet = await errorOf(
      setGoal(q, qThread, { objective: OBJECTIVE, status: "paused" }),
    );

    assert.equal(offSet, "", "set on a goals-off thread is accepted");
    assert.deepEqual(offAfter, [], "a goals-off thread starts no goal turn");
    assert.deepEqual(offTools.sort(), ["update_plan"]);
    assert.deepEqual(onTools.sort(), [
      "create_goal",
      "get_goal",
      "update_goal",
      "update_plan",
    ]);
    assert.match(qSet, /goals feature is disabled/);
    await q.codex.stop();
    await p.codex.stop();
  });

  test("the thread config's budget maximum holds only while the thread is loaded; a process argument always holds", async () => {
    const p = await launch();
    const threadId = await startThread(p, goalsOn(1000));
    const over = await errorOf(
      setGoal(p, threadId, {
        objective: OBJECTIVE,
        status: "paused",
        tokenBudget: 2000,
      }),
    );
    assert.match(over, /exceeds the maximum allowed goal token budget of 1000/);
    // No budget given: the maximum becomes the goal's budget.
    const paused = await setGoal(p, threadId, {
      objective: OBJECTIVE,
      status: "paused",
    });
    assert.equal(paused.tokenBudget, 1000);
    assert.equal(paused.status, "paused");
    const tooLong = await errorOf(
      setGoal(p, threadId, { objective: "x".repeat(4001) }),
    );
    assert.match(tooLong, /at most 4000 characters/);
    await p.codex.stop();

    // Unloaded (a new process, no resume): the process config has no
    // maximum, so a larger budget is accepted.
    const q = await launch();
    const raised = await setGoal(q, threadId, { tokenBudget: 2000 });
    assert.equal(raised.tokenBudget, 2000);
    await q.codex.stop();

    // The same maximum as a process argument holds for an unloaded thread.
    const r = await launch(["goals.max_goal_token_budget=1000"]);
    const refused = await errorOf(setGoal(r, threadId, { tokenBudget: 3000 }));
    assert.match(refused, /maximum allowed goal token budget of 1000/);
    await r.codex.stop();
  });

  test("an active set on an idle thread starts goal turns until update_goal complete", async () => {
    const p = await launch();
    const threadId = await startThread(p);
    model.script.push(
      { kind: "reply", text: "PROBE_STEP_ONE" },
      { kind: "call", name: "update_goal", args: { status: "complete" } },
      { kind: "reply", text: "PROBE_DONE" },
    );
    const firstRequest = model.requests.length;
    const goal = await setGoal(p, threadId, {
      objective: OBJECTIVE,
      status: "active",
      tokenBudget: 10_000,
    });
    assert.equal(goal.status, "active");
    assert.ok(await until(() => lastStatus(p, threadId) === "complete"));
    const turns = turnsStarted(p, threadId);
    assert.equal(turns.length, 2, "two goal turns, no client turn/start");
    assert.ok(await until(() => !!completedTurn(p, threadId, turns[1]!)));
    assert.deepEqual(await turnsDuring(p, threadId, 2000), []);

    // The set's goal update comes before the turn Codex started.
    const first = p.order.findIndex((l) => l.startsWith("turn/started"));
    assert.ok(
      p.order.indexOf("thread/goal/updated ") < first,
      p.order.join("\n"),
    );

    // Each goal turn's model request carries the hidden continuation prompt
    // with the objective; there is no user message item.
    const requests = model.requests.slice(firstRequest).map((r) => r.body);
    assert.ok(requests.every(isContinuation));
    assert.ok(JSON.stringify(requests[0]!.input).includes("PROBE_OBJECTIVE"));
    const itemTypes = p.notes
      .filter(
        (n) =>
          n.method === "item/started" &&
          n.params.threadId === threadId &&
          n.params.turnId === turns[0],
      )
      .map((n) => (n.params.item as Item).type);
    assert.ok(!itemTypes.includes("userMessage"), itemTypes.join(","));

    // The complete update is tagged with the turn whose tool call made it.
    const updates = goalUpdates(p, threadId);
    assert.equal(updates[0]!.turnId, null, "the set's update has no turn");
    assert.equal(updates.at(-1)!.turnId, turns[1]);
    assert.deepEqual(
      [...new Set(updates.map((u) => u.goal.status))],
      ["active", "complete"],
    );
    // The protocol goal has no goal id; createdAt/updatedAt are seconds.
    assert.deepEqual(Object.keys(goal).sort(), [
      "createdAt",
      "objective",
      "status",
      "threadId",
      "timeUsedSeconds",
      "tokenBudget",
      "tokensUsed",
      "updatedAt",
    ]);
    assert.ok(goal.createdAt < 10_000_000_000, "seconds, not milliseconds");
    await p.codex.stop();
  });

  test("a budget running out ends the loop as budgetLimited", async () => {
    const p = await launch();
    const threadId = await startThread(p);
    // Each fixture reply costs 20 input - 5 cached + 10 output = 25 tokens.
    await setGoal(p, threadId, {
      objective: OBJECTIVE,
      status: "active",
      tokenBudget: 40,
    });
    assert.ok(await until(() => lastStatus(p, threadId) === "budgetLimited"));
    const turns = turnsStarted(p, threadId);
    assert.ok(await until(() => !!completedTurn(p, threadId, turns.at(-1)!)));
    assert.deepEqual(await turnsDuring(p, threadId, 2000), []);
    assert.equal(turns.length, 2);
    for (const turn of turns)
      assert.equal(completedTurn(p, threadId, turn)!.status, "completed");
    const final = goalUpdates(p, threadId).at(-1)!.goal;
    assert.ok(final.tokensUsed >= 40, String(final.tokensUsed));
    await p.codex.stop();
  });

  test("interrupt alone leaves the goal active for the next turn; pause then interrupt stops it", async () => {
    const p = await launch();

    // Interrupt only.
    const alone = await startThread(p);
    model.script.push({ kind: "hangAfterCreated" });
    const sent = model.requests.length;
    await setGoal(p, alone, { objective: OBJECTIVE, status: "active" });
    assert.ok(await until(() => model.requests.length > sent));
    const [hung] = turnsStarted(p, alone);
    await p.codex.request("turn/interrupt", { threadId: alone, turnId: hung });
    assert.ok(await until(() => !!completedTurn(p, alone, hung!)));
    assert.equal(completedTurn(p, alone, hung!)!.status, "interrupted");
    // Nothing continues, but the goal stays active: the member's next turn
    // is counted towards it, and Codex continues the goal after that turn.
    assert.deepEqual(await turnsDuring(p, alone, 3000), []);
    assert.equal((await getGoal(p, alone))!.status, "active");
    model.script.push(
      { kind: "reply", text: "PROBE_MEMBER" },
      { kind: "call", name: "update_goal", args: { status: "complete" } },
      { kind: "reply", text: "PROBE_DONE" },
    );
    const member = await startTurn(p, alone, "PROBE_MEMBER_ASK");
    assert.ok(await until(() => lastStatus(p, alone) === "complete"));
    const aloneTurns = turnsStarted(p, alone);
    assert.equal(aloneTurns.length, 3);
    assert.equal(aloneTurns[1], member);
    assert.ok(goalUpdates(p, alone).some((u) => u.turnId === member));

    // Pause, then interrupt (the TUI's order).
    model.script.length = 0;
    const paused = await startThread(p);
    model.script.push({ kind: "hangAfterCreated" });
    const sent2 = model.requests.length;
    await setGoal(p, paused, { objective: OBJECTIVE, status: "active" });
    assert.ok(await until(() => model.requests.length > sent2));
    const [running] = turnsStarted(p, paused);
    await setGoal(p, paused, { status: "paused" });
    await p.codex.request("turn/interrupt", {
      threadId: paused,
      turnId: running,
    });
    assert.ok(await until(() => !!completedTurn(p, paused, running!)));
    assert.deepEqual(await turnsDuring(p, paused, 5000), []);
    assert.equal((await getGoal(p, paused))!.status, "paused");
    // A later member turn is not counted and starts nothing after it.
    const next = await startTurn(p, paused, "PROBE_MEMBER_ASK");
    assert.ok(await until(() => !!completedTurn(p, paused, next)));
    assert.deepEqual(await turnsDuring(p, paused, 2000), []);
    assert.ok(!goalUpdates(p, paused).some((u) => u.turnId === next));
    await p.codex.stop();
  });

  test("a model create_goal during a member's turn continues after it, unless paused within the turn", async () => {
    const p = await launch();

    const free = await startThread(p);
    model.script.push(
      { kind: "call", name: "create_goal", args: { objective: OBJECTIVE } },
      { kind: "reply", text: "PROBE_MEMBER_ANSWER" },
      { kind: "call", name: "update_goal", args: { status: "complete" } },
      { kind: "reply", text: "PROBE_DONE" },
    );
    const member = await startTurn(p, free, "PROBE_MEMBER_ASK");
    assert.ok(await until(() => lastStatus(p, free) === "complete"));
    const created = goalUpdates(p, free)[0]!;
    assert.equal(created.turnId, member);
    assert.equal(created.goal.status, "active");
    assert.equal(created.goal.tokenBudget, null, "no budget without a maximum");
    const createdAt = p.notes.findIndex(
      (n) => n.method === "thread/goal/updated" && n.params.threadId === free,
    );
    const memberDone = p.notes.findIndex(
      (n) =>
        n.method === "turn/completed" &&
        (n.params.turn as { id: string }).id === member,
    );
    assert.ok(createdAt < memberDone, "reported inside the member's turn");
    const turns = turnsStarted(p, free);
    assert.equal(turns.length, 2, "one continuation after the member's turn");
    assert.equal(turns[0], member);

    // Paused as soon as it is reported, while the member's reply streams.
    model.script.length = 0;
    const guarded = await startThread(p);
    model.script.push(
      { kind: "call", name: "create_goal", args: { objective: OBJECTIVE } },
      {
        kind: "reply",
        text: "PROBE_MEMBER_ANSWER ".repeat(10),
        chunk: 4,
        delayMs: 40,
      },
    );
    const member2 = await startTurn(p, guarded, "PROBE_MEMBER_ASK");
    assert.ok(await until(() => lastStatus(p, guarded) === "active"));
    assert.equal(completedTurn(p, guarded, member2), undefined);
    await setGoal(p, guarded, { status: "paused" });
    assert.ok(await until(() => !!completedTurn(p, guarded, member2)));
    assert.deepEqual(await turnsDuring(p, guarded, 3000), []);
    assert.equal((await getGoal(p, guarded))!.status, "paused");
    await p.codex.stop();
  });

  test("turn/start during a goal turn is steered into it and answered with its id", async () => {
    const p = await launch();
    const threadId = await startThread(p);
    model.script.push(
      { kind: "reply", text: "PROBE_SLOW ".repeat(40), chunk: 4, delayMs: 50 },
      { kind: "call", name: "update_goal", args: { status: "complete" } },
      { kind: "reply", text: "PROBE_DONE" },
    );
    const sent = model.requests.length;
    await setGoal(p, threadId, { objective: OBJECTIVE, status: "active" });
    assert.ok(await until(() => model.requests.length > sent));
    const [goalTurn] = turnsStarted(p, threadId);
    const answered = await startTurn(p, threadId, "PROBE_STEER");
    assert.equal(answered, goalTurn, "steered, not a new turn");
    assert.ok(await until(() => lastStatus(p, threadId) === "complete"));
    assert.deepEqual(turnsStarted(p, threadId), [goalTurn]);
    // The steer reaches the goal turn's next model request.
    assert.ok(
      JSON.stringify(model.requests[sent + 1]!.body.input).includes(
        "PROBE_STEER",
      ),
    );
    await p.codex.stop();
  });

  test("turn/start racing the goal's own start is answered with the first turn's id", async (t) => {
    const p = await launch();
    // Any turn/start: the answer comes before the turn's turn/started.
    const plain = await startThread(p);
    const own = await startTurn(p, plain, "PROBE_PLAIN");
    assert.ok(await until(() => !!completedTurn(p, plain, own)));
    assert.ok(
      p.order.indexOf(`response turn/start ${own}`) <
        p.order.indexOf(`turn/started ${own}`),
    );

    const outcome = { goalFirst: 0, memberFirst: 0, answerFirst: 0 };
    for (let i = 0; i < 10; i++) {
      const threadId = await startThread(p);
      const sent = model.requests.length;
      const text = `PROBE_RACE_${i}`;
      const set = () =>
        setGoal(p, threadId, {
          objective: OBJECTIVE,
          status: "active",
          tokenBudget: 10_000,
        });
      model.script.push(
        { kind: "reply", text: "PROBE_RACE_REPLY" },
        { kind: "call", name: "update_goal", args: { status: "complete" } },
        { kind: "reply", text: "PROBE_DONE" },
      );
      // Alternate which request is written first.
      const answered =
        i % 2 === 0
          ? (await Promise.all([set(), startTurn(p, threadId, text)]))[1]
          : (await Promise.all([startTurn(p, threadId, text), set()]))[0];
      assert.ok(await until(() => lastStatus(p, threadId) === "complete"));
      const turns = turnsStarted(p, threadId);
      assert.ok(await until(() => !!completedTurn(p, threadId, turns.at(-1)!)));
      // Never a turn the answer does not name, and the member's text always
      // reaches the model.
      assert.equal(answered, turns[0], p.order.join("\n"));
      const bodies = model.requests.slice(sent).map((r) => r.body);
      assert.ok(bodies.some((b) => JSON.stringify(b.input).includes(text)));
      // A goal turn's first request carries the continuation prompt; a
      // member turn's carries the member's text and no continuation.
      if (isContinuation(bodies[0]!)) outcome.goalFirst++;
      else outcome.memberFirst++;
      assert.equal(isContinuation(bodies[0]!), i % 2 === 0, `race ${i}`);
      // Goal first: the member's text is steered into the goal turn (here
      // already its first request). Member first: the member's turn runs
      // and Codex continues the goal after it.
      assert.ok(JSON.stringify(bodies[0]!.input).includes(text), `race ${i}`);
      if (
        p.order.indexOf(`response turn/start ${answered}`) <
        p.order.indexOf(`turn/started ${answered}`)
      )
        outcome.answerFirst++;
      model.script.length = 0;
    }
    t.diagnostic(JSON.stringify(outcome));
    // Codex handles one thread's requests in the order they are written, so
    // the request written first decides which turn starts, and the other
    // never makes a second concurrent turn.
    assert.deepEqual(outcome, {
      goalFirst: 5,
      memberFirst: 5,
      answerFirst: 10,
    });
    await p.codex.stop();
  });

  test("a goal without a budget continues as fast as the model answers", async () => {
    const p = await launch();
    const threadId = await startThread(p);
    await setGoal(p, threadId, { objective: OBJECTIVE, status: "active" });
    assert.ok(await until(() => turnsStarted(p, threadId).length >= 10, 5000));
    assert.equal((await getGoal(p, threadId))!.tokenBudget, null);
    await setGoal(p, threadId, { status: "paused" });
    await p.codex.stop();
  });

  test("set works on an unloaded thread without running anything; resume continues an active goal by itself", async () => {
    const p = await launch();
    const threadId = await startThread(p);
    model.script.push({ kind: "hangAfterCreated" });
    const sent = model.requests.length;
    await setGoal(p, threadId, { objective: OBJECTIVE, status: "active" });
    assert.ok(await until(() => model.requests.length > sent));
    // The process stops mid goal turn (an adapter restart).
    await p.codex.stop();
    model.script.length = 0;

    const q = await launch();
    assert.equal((await getGoal(q, threadId))!.status, "active");
    assert.equal(
      (await setGoal(q, threadId, { status: "paused" })).status,
      "paused",
    );
    const reactivated = await setGoal(q, threadId, {
      status: "active",
      tokenBudget: 10_000,
    });
    assert.equal(reactivated.status, "active");
    assert.deepEqual(await turnsDuring(q, threadId, 2000), []);

    // thread/resume sends a goal snapshot and then, finding the thread idle
    // with an active goal, starts a goal turn with no client request.
    model.script.push(
      { kind: "call", name: "update_goal", args: { status: "complete" } },
      { kind: "reply", text: "PROBE_DONE" },
    );
    const resumedAt = model.requests.length;
    await resumeThread(q, threadId);
    assert.ok(await until(() => lastStatus(q, threadId) === "complete"));
    const turns = turnsStarted(q, threadId);
    assert.equal(turns.length, 1);
    const snapshot = goalUpdates(q, threadId)[2]!;
    assert.equal(snapshot.turnId, null);
    assert.equal(snapshot.goal.status, "active");
    assert.ok(
      q.order.indexOf("thread/goal/updated ") <
        q.order.indexOf(`turn/started ${turns[0]}`),
    );
    assert.ok(isContinuation(model.requests[resumedAt]!.body));
    await q.codex.stop();
  });
});
