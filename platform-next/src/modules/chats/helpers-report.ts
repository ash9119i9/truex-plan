// Read-only helper-agent report for operators (sub-agents plan, Phase 5).
// Derived from what settle already writes: the run (helperCount, status,
// error, usage, timings) and one `agent` tool row per helper. Output is
// counts and rates only: never a helper's task, result or a member's text.
import { ObjectId, type Db } from "mongodb";
import { toWireId } from "../../database/object-id";
import {
  CHATS_COLLECTION,
  MESSAGES_COLLECTION,
  RUNS_COLLECTION,
  isSettled,
  type ChatDoc,
  type MessageDoc,
  type RunDoc,
  type RunUsage,
} from "./chat";
import { percentile, rate } from "./followups-report";

// Ids per $in query, so a large tenant never builds one huge query.
const CHUNK = 500;

export interface HelpersReportOptions {
  since: Date;
  now?: Date;
}

interface Spread {
  count: number;
  p50: number | null;
  p90: number | null;
}

export interface HelpersReport {
  since: string;
  generatedAt: string;
  tenantDatabases: number;
  // Chats whose agent allowed helpers and that had a run in the window.
  chats: number;
  runs: {
    // Every run of those chats in the window, settled or not.
    total: number;
    settled: number;
    // Rates below are over settled runs unless named otherwise.
    withHelpers: number;
    spawnRate: number | null;
    completed: number;
    stopped: number;
    failed: number;
    // The runtime lost track of the run; not part of `settled`.
    uncertain: number;
    // Runs ended by the per-run helper limit, and their share of runs that
    // used helpers.
    helperLimit: number;
    helperLimitRate: number | null;
    // The runtime refused helpers (a coding runtime, or an old adapter).
    helpersDisabled: number;
  };
  helpers: {
    total: number;
    completed: number;
    failed: number;
    // Still working when the run settled (the lead answered, the member
    // stopped, or a wait timed out): stopped with the run.
    stopped: number;
    failureRate: number | null;
    stoppedRate: number | null;
    perRun: Spread & { max: number | null };
  };
  // Accepted to completed, completed runs only.
  latencyMs: { withHelpers: Spread; withoutHelpers: Spread };
  // input + output per completed run (helpers included in a run's usage).
  tokens: {
    withHelpers: Spread;
    withoutHelpers: Spread;
    // Helper tokens over run tokens, for runs that used helpers.
    helperShare: number | null;
  };
  byModel: Array<{
    modelId: string;
    runs: number;
    settled: number;
    withHelpers: number;
    spawnRate: number | null;
    helpers: number;
    helperFailureRate: number | null;
  }>;
}

interface ScannedRun {
  modelId: string;
  status: RunDoc["status"];
  errorCode: string | null;
  helperCount: number;
  latencyMs: number | null;
  tokens: number | null;
  helperTokens: number;
  helperStatuses: Array<"completed" | "failed" | "stopped">;
}

export interface HelpersScan {
  chats: number;
  runs: ScannedRun[];
}

const tokensOf = (usage: RunUsage | undefined): number | null =>
  usage ? (usage.input ?? 0) + (usage.output ?? 0) : null;

const spread = (values: readonly number[]): Spread => ({
  count: values.length,
  p50: percentile(values, 0.5),
  p90: percentile(values, 0.9),
});

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK)
    out.push(items.slice(i, i + CHUNK));
  return out;
}

// Every read is indexed and bounded by the window: runs by their _id time
// (the default _id index), their chats by _id, and helper rows by runId and
// the `agent:` item prefix (`run_item_unique`). No chat outside the window is
// read, so the cost grows with the window's runs, not with the tenant. Goal
// runs are left out: their _id is a digest of their thread and turn, so its
// time is not theirs.
export async function scanHelpers(
  db: Db,
  options: HelpersReportOptions,
): Promise<HelpersScan> {
  const now = options.now ?? new Date();
  // A member run's _id is made when it is accepted, so its time is the run's.
  const from = ObjectId.createFromTime(
    Math.floor(options.since.getTime() / 1000),
  );
  const until = ObjectId.createFromTime(Math.floor(now.getTime() / 1000) + 1);
  const inWindow = await db
    .collection<RunDoc>(RUNS_COLLECTION)
    .find(
      { _id: { $gte: from, $lt: until }, trigger: { $ne: "goal" } },
      {
        projection: {
          chatId: 1,
          status: 1,
          "error.code": 1,
          helperCount: 1,
          usage: 1,
          timings: 1,
        },
      },
    )
    .toArray();

  // Only chats whose agent allowed helpers count, with the model they pin.
  const modelOf = new Map<string, string>();
  const chatIds = [
    ...new Map(
      inWindow.map((run) => [toWireId(run.chatId), run.chatId]),
    ).values(),
  ];
  for (const ids of chunks(chatIds))
    for (const chat of await db
      .collection<ChatDoc>(CHATS_COLLECTION)
      .find(
        { _id: { $in: ids }, helpers: true },
        { projection: { "model.id": 1 } },
      )
      .toArray())
      modelOf.set(toWireId(chat._id), toWireId(chat.model.id));
  const runs = inWindow.filter((run) => modelOf.has(toWireId(run.chatId)));

  const rows = new Map<string, MessageDoc["agent"][]>();
  const withHelpers = runs.filter((run) => (run.helperCount ?? 0) > 0);
  for (const ids of chunks(withHelpers.map((run) => run._id)))
    for (const row of await db
      .collection<MessageDoc>(MESSAGES_COLLECTION)
      .find(
        {
          runId: { $in: ids },
          // $type lets the partial run_item_unique index serve this.
          runtimeItemId: { $type: "string", $regex: /^agent:/ },
        },
        { projection: { runId: 1, "agent.status": 1, "agent.usage": 1 } },
      )
      .toArray()) {
      const key = toWireId(row.runId);
      rows.set(key, [...(rows.get(key) ?? []), row.agent]);
    }

  const chats = new Set(runs.map((run) => toWireId(run.chatId)));
  return {
    chats: chats.size,
    runs: runs.map((run) => {
      const agents = (rows.get(toWireId(run._id)) ?? []).filter(
        (agent) => agent !== undefined,
      );
      const t = run.timings;
      return {
        modelId: modelOf.get(toWireId(run.chatId))!,
        status: run.status,
        errorCode: run.error?.code ?? null,
        helperCount: run.helperCount ?? 0,
        latencyMs:
          run.status === "completed" && t?.completedAt
            ? t.completedAt.getTime() - t.acceptedAt.getTime()
            : null,
        tokens: run.status === "completed" ? tokensOf(run.usage) : null,
        helperTokens: agents.reduce((n, a) => n + (tokensOf(a.usage) ?? 0), 0),
        helperStatuses: agents.map((agent) => agent.status),
      };
    }),
  };
}

export function summarizeHelpers(
  scans: readonly HelpersScan[],
  options: HelpersReportOptions,
): HelpersReport {
  const runs = scans.flatMap((scan) => scan.runs);
  const settled = runs.filter((run) => isSettled(run.status));
  const used = settled.filter((run) => run.helperCount > 0);
  const statuses = runs.flatMap((run) => run.helperStatuses);
  const count = (status: string) =>
    statuses.filter((value) => value === status).length;
  const completed = runs.filter((run) => run.status === "completed");
  const values = (list: ScannedRun[], key: "latencyMs" | "tokens") =>
    list.flatMap((run) => (run[key] === null ? [] : [run[key]]));
  const helperRunsWithTokens = completed.filter(
    (run) => run.helperCount > 0 && run.tokens !== null,
  );
  const runTokens = helperRunsWithTokens.reduce((n, r) => n + r.tokens!, 0);

  const models = new Map<string, ScannedRun[]>();
  for (const run of runs)
    models.set(run.modelId, [...(models.get(run.modelId) ?? []), run]);

  return {
    since: options.since.toISOString(),
    generatedAt: (options.now ?? new Date()).toISOString(),
    tenantDatabases: scans.length,
    chats: scans.reduce((n, scan) => n + scan.chats, 0),
    runs: {
      total: runs.length,
      settled: settled.length,
      withHelpers: used.length,
      spawnRate: rate(used.length, settled.length),
      completed: completed.length,
      stopped: runs.filter((run) => run.status === "stopped").length,
      failed: runs.filter((run) => run.status === "failed").length,
      uncertain: runs.filter((run) => run.status === "uncertain").length,
      helperLimit: runs.filter((run) => run.errorCode === "SUBAGENT_LIMIT")
        .length,
      helperLimitRate: rate(
        used.filter((run) => run.errorCode === "SUBAGENT_LIMIT").length,
        used.length,
      ),
      helpersDisabled: runs.filter(
        (run) => run.errorCode === "SUBAGENTS_DISABLED",
      ).length,
    },
    helpers: {
      total: statuses.length,
      completed: count("completed"),
      failed: count("failed"),
      stopped: count("stopped"),
      failureRate: rate(count("failed"), statuses.length),
      stoppedRate: rate(count("stopped"), statuses.length),
      perRun: {
        ...spread(used.map((run) => run.helperCount)),
        max: used.length
          ? Math.max(...used.map((run) => run.helperCount))
          : null,
      },
    },
    latencyMs: {
      withHelpers: spread(
        values(
          completed.filter((run) => run.helperCount > 0),
          "latencyMs",
        ),
      ),
      withoutHelpers: spread(
        values(
          completed.filter((run) => run.helperCount === 0),
          "latencyMs",
        ),
      ),
    },
    tokens: {
      withHelpers: spread(
        values(
          completed.filter((run) => run.helperCount > 0),
          "tokens",
        ),
      ),
      withoutHelpers: spread(
        values(
          completed.filter((run) => run.helperCount === 0),
          "tokens",
        ),
      ),
      helperShare: rate(
        helperRunsWithTokens.reduce((n, r) => n + r.helperTokens, 0),
        runTokens,
      ),
    },
    byModel: [...models.entries()]
      .map(([modelId, list]) => {
        const done = list.filter((run) => isSettled(run.status));
        const helped = done.filter((run) => run.helperCount > 0);
        const states = list.flatMap((run) => run.helperStatuses);
        return {
          modelId,
          runs: list.length,
          settled: done.length,
          withHelpers: helped.length,
          spawnRate: rate(helped.length, done.length),
          helpers: states.length,
          helperFailureRate: rate(
            states.filter((s) => s === "failed").length,
            states.length,
          ),
        };
      })
      .sort((a, b) => b.runs - a.runs || a.modelId.localeCompare(b.modelId)),
  };
}

// Scans every tenant database and prints one aggregate. Read-only.
export async function buildHelpersReport(
  databases: readonly Db[],
  options: HelpersReportOptions,
): Promise<HelpersReport> {
  const scans: HelpersScan[] = [];
  for (const db of databases) scans.push(await scanHelpers(db, options));
  return summarizeHelpers(scans, options);
}
