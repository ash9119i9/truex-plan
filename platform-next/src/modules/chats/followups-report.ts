// Read-only Follow Up report for operators. Every signal is derived from
// runs, chats and messages the platform already writes; no event pipeline.
// Output is counts and rates only: never a row's text or a member's message.
import type { Db } from "mongodb";
import { toWireId } from "../../database/object-id";
import {
  CHATS_COLLECTION,
  MESSAGES_COLLECTION,
  RUNS_COLLECTION,
  isSettled,
  type ChatDoc,
  type MessageDoc,
  type RunDoc,
} from "./chat";
import type { FollowUpItem } from "./followups";

// 30 minutes: no next run within this window of a set means the member left.
// A set younger than this with no next run yet is pending, not counted.
export const LEFT_AFTER_MS = 30 * 60_000;
// A chat returned when it has a turn this long after it was created. Only
// chats at least this old by the report's end can have returned.
export const RETURN_AFTER_MS = 7 * 24 * 60 * 60_000;
// A clicked reply stopped this quickly, failed, or took a steer: it went
// badly for the member.
export const BAD_STOP_MS = 15_000;
export const DEFAULT_MIN_SETS = 200;
export const DEFAULT_CLOSE = 0.6;

export interface FollowUpsReportOptions {
  since: Date;
  now?: Date;
  // Cells with fewer sets are hidden rather than shown as tiny percentages.
  minSets?: number;
  // Word-overlap score at which a typed message counts as "close".
  close?: number;
}

export interface FollowUpsReport {
  since: string;
  generatedAt: string;
  tenantDatabases: number;
  totals: {
    sets: number;
    // Sets too recent to judge (no next run, under LEFT_AFTER_MS old); not
    // part of `sets` or any rate.
    pending: number;
    clicked: number;
    typed: number;
    typedClose: number;
    left: number;
    clickRate: number | null;
    typedRate: number | null;
    typedCloseRate: number | null;
    leftRate: number | null;
    clickedGoingBadly: number;
    clickedGoingBadlyRate: number | null;
    timeToClickMs: { count: number; p50: number | null; p90: number | null };
  };
  byAgentModel: Array<{
    agentId: string;
    modelId: string;
    sets: number;
    clicked: number;
    typed: number;
    typedClose: number;
    left: number;
    clickRate: number | null;
  }>;
  byIntent: Array<{
    shape: string;
    stage: string;
    intent: string;
    sets: number;
    clicked: number;
    clickRate: number | null;
  }>;
  bySlot: Array<{
    slot: number;
    sets: number;
    clicked: number;
    clickRate: number | null;
  }>;
  // The full cell: one agent and model, one answer shape and stage, one
  // intent. Answers "does this intent work for this agent?".
  cells: Array<{
    agentId: string;
    modelId: string;
    shape: string;
    stage: string;
    intent: string;
    sets: number;
    clicked: number;
    clickRate: number | null;
  }>;
  byModel: Array<{
    modelId: string;
    attempts: number;
    ok: number;
    none: number;
    missing: number;
    invalid: number;
    formatFailureRate: number | null;
  }>;
  holdout: Array<{
    assignment: "on" | "holdout";
    chats: number;
    turns: number;
    turnsPerChat: number | null;
    chatsWithTwoTurns: number;
    chatsWithTwoTurnsRate: number | null;
    stopRate: number | null;
    // Over chats at least RETURN_AFTER_MS old by the report's end.
    return7Chats: number;
    return7Rate: number | null;
  }>;
  hiddenCells: number;
  minSets: number;
  close: number;
}

interface ScannedSet {
  agentId: string;
  modelId: string;
  shape: string;
  stage: string;
  items: FollowUpItem[];
  completedAt: Date;
  outcome: "clicked" | "typed" | "left";
  // The slot of the verified click, for attribution; null otherwise.
  clickedSlot: number | null;
  typedClose: boolean;
  clickedBad: boolean;
  timeToClickMs: number | null;
}

interface FormatAttempt {
  agentId: string;
  modelId: string;
  status: "ok" | "none" | "missing" | "invalid";
}

interface HoldoutChat {
  assignment: "on" | "holdout";
  turns: number;
  settled: number;
  stopped: number;
  hasTwoTurns: boolean;
  // Old enough to have returned; returned7 is only counted when true.
  canReturn7: boolean;
  returned7: boolean;
}

export interface TenantScan {
  sets: ScannedSet[];
  pending: number;
  attempts: FormatAttempt[];
  holdout: HoldoutChat[];
}

// Words that carry no signal in "did the member type something close". English
// plus the most common question words in the other languages the prompt names.
const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "if",
  "then",
  "than",
  "that",
  "this",
  "these",
  "those",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "am",
  "do",
  "does",
  "did",
  "doing",
  "have",
  "has",
  "had",
  "having",
  "will",
  "would",
  "should",
  "could",
  "can",
  "may",
  "might",
  "must",
  "shall",
  "to",
  "of",
  "in",
  "on",
  "at",
  "by",
  "for",
  "with",
  "from",
  "into",
  "about",
  "as",
  "it",
  "its",
  "i",
  "me",
  "my",
  "we",
  "our",
  "you",
  "your",
  "he",
  "she",
  "they",
  "their",
  "them",
  "us",
  "what",
  "which",
  "who",
  "whom",
  "whose",
  "when",
  "where",
  "why",
  "how",
  "all",
  "any",
  "both",
  "each",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "no",
  "not",
  "only",
  "own",
  "same",
  "so",
  "too",
  "very",
  "just",
  "also",
  "there",
  "here",
  "up",
  "down",
  "out",
  "off",
  "over",
  "under",
  "again",
  "further",
  "once",
  "please",
  "show",
  "tell",
  "give",
  "make",
  "sure",
  "help",
  "want",
  "need",
]);

function wordsOf(text: string): Set<string> {
  const words = new Set<string>();
  for (const word of text
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u))
    if (word.length > 1 && !STOP_WORDS.has(word)) words.add(word);
  return words;
}

// Jaccard overlap of the two word sets: 1 is identical, 0 shares nothing.
export function overlapScore(left: string, right: string): number {
  const a = wordsOf(left);
  const b = wordsOf(right);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return shared / (a.size + b.size - shared);
}

function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function percentile(
  values: readonly number[],
  fraction: number,
): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * fraction) - 1),
  );
  return sorted[index]!;
}

function validStatus(value: unknown): FormatAttempt["status"] | null {
  return value === "ok" ||
    value === "none" ||
    value === "missing" ||
    value === "invalid"
    ? value
    : null;
}

function validItems(value: unknown): FollowUpItem[] {
  if (!Array.isArray(value)) return [];
  const items: FollowUpItem[] = [];
  for (const raw of value as Array<Record<string, unknown> | null>) {
    if (
      !raw ||
      typeof raw.slot !== "number" ||
      !Number.isInteger(raw.slot) ||
      raw.slot < 1 ||
      raw.slot > 3 ||
      typeof raw.intent !== "string" ||
      typeof raw.text !== "string"
    )
      continue;
    items.push({
      slot: raw.slot,
      intent: raw.intent as FollowUpItem["intent"],
      text: raw.text,
    });
  }
  return items;
}

// Scans one tenant database. The runs with a Follow Up set come from the
// partial index; everything else is bounded by `since` and chat IDs.
export async function scanTenant(
  db: Db,
  options: FollowUpsReportOptions,
): Promise<TenantScan> {
  const since = options.since;
  const now = options.now ?? new Date();
  const runs = db.collection<RunDoc>(RUNS_COLLECTION);
  const chats = db.collection<ChatDoc>(CHATS_COLLECTION);
  const messages = db.collection<MessageDoc>(MESSAGES_COLLECTION);

  // Projections keep the scan to the fields read below; a projected
  // document is still typed as the full one, so read only these fields.
  const suggesting = await runs
    .find(
      {
        createdAt: { $gte: since, $lte: now },
        followUps: { $exists: true },
      },
      {
        projection: {
          chatId: 1,
          status: 1,
          followUps: 1,
          timings: 1,
          createdAt: 1,
        },
      },
    )
    .sort({ createdAt: 1 })
    .toArray();
  // One read for every chat named by a set: the report never reads a chat
  // per run (the partial index scans can reach thousands of sets).
  const chatIds = [
    ...new Map(
      suggesting.map((run) => [toWireId(run.chatId), run.chatId]),
    ).values(),
  ];
  const chatDocs = chatIds.length
    ? await chats
        .find(
          { _id: { $in: chatIds } },
          { projection: { "agent.id": 1, "model.id": 1 } },
        )
        .toArray()
    : [];
  const chatsById = new Map(chatDocs.map((chat) => [toWireId(chat._id), chat]));
  const attempts: FormatAttempt[] = [];
  const setRuns: RunDoc[] = [];
  for (const run of suggesting) {
    const status = validStatus(run.followUps?.status);
    if (!status) continue;
    const chat = chatsById.get(toWireId(run.chatId));
    if (!chat) continue;
    attempts.push({
      agentId: toWireId(chat.agent.id),
      modelId: toWireId(chat.model.id),
      status,
    });
    if (run.status === "completed" && status === "ok" && run.followUps)
      setRuns.push(run);
  }
  if (setRuns.length === 0) {
    return {
      sets: [],
      pending: 0,
      attempts,
      holdout: await holdoutOf(db, since, now),
    };
  }

  // One read of the runs after the earliest suggestion, for every chat with
  // a set; each set's next run is then picked in memory. A chat's runs
  // before its own first set are read too and never match.
  const earliest = setRuns
    .map((run) => run.timings.completedAt?.getTime() ?? Infinity)
    .reduce((a, b) => Math.min(a, b), Infinity);
  const laterRuns = new Map<string, RunDoc[]>();
  if (Number.isFinite(earliest)) {
    const setChatIds = [
      ...new Map(
        setRuns.map((run) => [toWireId(run.chatId), run.chatId]),
      ).values(),
    ];
    for (const run of await runs
      .find(
        {
          chatId: { $in: setChatIds },
          createdAt: { $gt: new Date(earliest), $lte: now },
        },
        {
          projection: {
            chatId: 1,
            userMessageId: 1,
            status: 1,
            origin: 1,
            timings: 1,
            // Only the count is read; the steers' text is never fetched.
            "steers.createdAt": 1,
            createdAt: 1,
          },
        },
      )
      .sort({ createdAt: 1 })
      .toArray()) {
      const key = toWireId(run.chatId);
      const list = laterRuns.get(key) ?? [];
      list.push(run);
      laterRuns.set(key, list);
    }
  }

  const sets: ScannedSet[] = [];
  let pending = 0;
  const nextMessageIds: MessageDoc["_id"][] = [];
  const typedNext: Array<{ set: ScannedSet; next: RunDoc }> = [];
  for (const run of setRuns) {
    const chat = chatsById.get(toWireId(run.chatId));
    const followUps = run.followUps!;
    if (!chat || !run.timings.completedAt) continue;
    const completedAt = run.timings.completedAt;
    const items = validItems(followUps.items);
    const next = (laterRuns.get(toWireId(run.chatId)) ?? []).find(
      (candidate) => candidate.createdAt.getTime() > completedAt.getTime(),
    );
    // Not yet left: the member may still answer within the window.
    if (!next && now.getTime() - completedAt.getTime() <= LEFT_AFTER_MS) {
      pending++;
      continue;
    }
    const clicked =
      !!next?.origin &&
      next.origin.source === "suggestion" &&
      next.origin.fromRunId.equals(run._id) &&
      Number.isInteger(next.origin.slot) &&
      items.some((item) => item.slot === next.origin!.slot);
    const clickedSlot = clicked ? next!.origin!.slot : null;
    const outcome: ScannedSet["outcome"] =
      !next || next.createdAt.getTime() - completedAt.getTime() > LEFT_AFTER_MS
        ? "left"
        : clicked
          ? "clicked"
          : "typed";
    const clickedBad =
      outcome === "clicked" &&
      (next!.status === "failed" ||
        (next!.status === "stopped" &&
          !!next!.timings.completedAt &&
          next!.timings.completedAt.getTime() -
            next!.timings.acceptedAt.getTime() <=
            BAD_STOP_MS) ||
        (next!.steers?.length ?? 0) > 0);
    const set: ScannedSet = {
      agentId: toWireId(chat.agent.id),
      modelId: toWireId(chat.model.id),
      shape: followUps.shape,
      stage: followUps.stage,
      items,
      completedAt,
      outcome,
      clickedSlot,
      typedClose: false,
      clickedBad,
      timeToClickMs:
        outcome === "clicked"
          ? Math.max(
              0,
              next!.timings.acceptedAt.getTime() - completedAt.getTime(),
            )
          : null,
    };
    sets.push(set);
    if (outcome === "typed" && next) {
      nextMessageIds.push(next.userMessageId);
      typedNext.push({ set, next });
    }
  }

  if (typedNext.length) {
    const texts = new Map<string, string>();
    for (const message of await messages
      .find({ _id: { $in: nextMessageIds } }, { projection: { text: 1 } })
      .toArray())
      texts.set(toWireId(message._id), message.text);
    const close = options.close ?? DEFAULT_CLOSE;
    for (const { set, next } of typedNext) {
      const text = texts.get(toWireId(next.userMessageId)) ?? "";
      set.typedClose = overlapFor(text, set.items, close);
    }
  }

  return {
    sets,
    pending,
    attempts,
    holdout: await holdoutOf(db, since, now),
  };
}

// Applies the report option's threshold to the best-matching row. The score
// is computed here, never stored, so a later report can use a new threshold.
function overlapFor(
  text: string,
  items: readonly FollowUpItem[],
  close: number,
): boolean {
  let best = 0;
  for (const item of items)
    best = Math.max(best, overlapScore(text, item.text));
  return best >= close;
}

// Chats created in the window, by assignment, with their turns. Only the
// comparison groups on and holdout; off chats are not part of it.
async function holdoutOf(
  db: Db,
  since: Date,
  now: Date,
): Promise<HoldoutChat[]> {
  const chats = db.collection<ChatDoc>(CHATS_COLLECTION);
  const runs = db.collection<RunDoc>(RUNS_COLLECTION);
  const compared = await chats
    .find(
      {
        createdAt: { $gte: since, $lte: now },
        followUps: { $in: ["on", "holdout"] },
      },
      { projection: { followUps: 1, createdAt: 1 } },
    )
    .toArray();
  if (compared.length === 0) return [];
  const chatRuns = await runs
    .find(
      {
        chatId: { $in: compared.map((chat) => chat._id) },
        createdAt: { $gte: since, $lte: now },
      },
      { projection: { chatId: 1, status: 1, "timings.acceptedAt": 1 } },
    )
    .toArray();
  const byChat = new Map<string, RunDoc[]>();
  for (const run of chatRuns) {
    const key = toWireId(run.chatId);
    const list = byChat.get(key) ?? [];
    list.push(run);
    byChat.set(key, list);
  }
  return compared.map((chat) => {
    const list = byChat.get(toWireId(chat._id)) ?? [];
    const settled = list.filter((run) => isSettled(run.status));
    const stopped = settled.filter((run) => run.status === "stopped").length;
    const returnAt = chat.createdAt.getTime() + RETURN_AFTER_MS;
    const canReturn7 = returnAt <= now.getTime();
    const returned7 =
      canReturn7 &&
      list.some((run) => run.timings.acceptedAt.getTime() >= returnAt);
    return {
      assignment: chat.followUps as "on" | "holdout",
      turns: list.length,
      settled: settled.length,
      stopped,
      hasTwoTurns: list.length >= 2,
      canReturn7,
      returned7,
    };
  });
}

// Turns per-chat scans into the printed report. Cells below minSets are
// dropped; totals always stay.
export function summarizeReport(
  scans: readonly TenantScan[],
  options: FollowUpsReportOptions,
): FollowUpsReport {
  const minSets = options.minSets ?? DEFAULT_MIN_SETS;
  const close = options.close ?? DEFAULT_CLOSE;
  const sets = scans.flatMap((scan) => scan.sets);
  const attempts = scans.flatMap((scan) => scan.attempts);
  const holdoutChats = scans.flatMap((scan) => scan.holdout);

  let clicked = 0;
  let typed = 0;
  let typedCloseCount = 0;
  let left = 0;
  let clickedBad = 0;
  const clickTimes: number[] = [];
  const agentModel = new Map<
    string,
    {
      agentId: string;
      modelId: string;
      sets: number;
      clicked: number;
      typed: number;
      typedClose: number;
      left: number;
    }
  >();
  const intent = new Map<
    string,
    {
      shape: string;
      stage: string;
      intent: string;
      sets: number;
      clicked: number;
    }
  >();
  const slots = new Map<
    number,
    { slot: number; sets: number; clicked: number }
  >();
  const cells = new Map<
    string,
    {
      agentId: string;
      modelId: string;
      shape: string;
      stage: string;
      intent: string;
      sets: number;
      clicked: number;
    }
  >();
  for (const set of sets) {
    if (set.outcome === "clicked") {
      clicked++;
      if (set.timeToClickMs !== null) clickTimes.push(set.timeToClickMs);
      if (set.clickedBad) clickedBad++;
    } else if (set.outcome === "typed") {
      typed++;
      if (set.typedClose) typedCloseCount++;
    } else left++;

    const amKey = `${set.agentId}|${set.modelId}`;
    const am = agentModel.get(amKey) ?? {
      agentId: set.agentId,
      modelId: set.modelId,
      sets: 0,
      clicked: 0,
      typed: 0,
      typedClose: 0,
      left: 0,
    };
    am.sets++;
    am[set.outcome]++;
    if (set.outcome === "typed" && set.typedClose) am.typedClose++;
    agentModel.set(amKey, am);

    const intentsSeen = new Set<string>();
    for (const item of set.items) {
      if (intentsSeen.has(item.intent)) continue;
      intentsSeen.add(item.intent);
      const key = `${set.shape}|${set.stage}|${item.intent}`;
      const row = intent.get(key) ?? {
        shape: set.shape,
        stage: set.stage,
        intent: item.intent,
        sets: 0,
        clicked: 0,
      };
      row.sets++;
      intent.set(key, row);
      const cellKey = `${set.agentId}|${set.modelId}|${key}`;
      const cell = cells.get(cellKey) ?? {
        agentId: set.agentId,
        modelId: set.modelId,
        shape: set.shape,
        stage: set.stage,
        intent: item.intent,
        sets: 0,
        clicked: 0,
      };
      cell.sets++;
      cells.set(cellKey, cell);
    }
    for (const item of set.items) {
      const row = slots.get(item.slot) ?? {
        slot: item.slot,
        sets: 0,
        clicked: 0,
      };
      row.sets++;
      slots.set(item.slot, row);
    }
  }

  // Clicks attribute to the row's intent and slot. Recompute from the set's
  // clicked item, which `ScannedSet` keeps as its only slot bookkeeping.
  for (const set of sets) {
    if (set.outcome !== "clicked" || !set.clickedSlot) continue;
    const item = set.items.find((entry) => entry.slot === set.clickedSlot);
    if (!item) continue;
    const key = `${set.shape}|${set.stage}|${item.intent}`;
    const row = intent.get(key);
    if (row) row.clicked++;
    const slot = slots.get(item.slot);
    if (slot) slot.clicked++;
    const cell = cells.get(`${set.agentId}|${set.modelId}|${key}`);
    if (cell) cell.clicked++;
  }

  const model = new Map<
    string,
    {
      modelId: string;
      attempts: number;
      ok: number;
      none: number;
      missing: number;
      invalid: number;
    }
  >();
  for (const attempt of attempts) {
    const row = model.get(attempt.modelId) ?? {
      modelId: attempt.modelId,
      attempts: 0,
      ok: 0,
      none: 0,
      missing: 0,
      invalid: 0,
    };
    row.attempts++;
    row[attempt.status]++;
    model.set(attempt.modelId, row);
  }

  const holdout = new Map<
    "on" | "holdout",
    {
      assignment: "on" | "holdout";
      chats: number;
      turns: number;
      chatsWithTwoTurns: number;
      settled: number;
      stopped: number;
      canReturn7: number;
      returned7: number;
    }
  >();
  for (const chat of holdoutChats) {
    const row = holdout.get(chat.assignment) ?? {
      assignment: chat.assignment,
      chats: 0,
      turns: 0,
      chatsWithTwoTurns: 0,
      settled: 0,
      stopped: 0,
      canReturn7: 0,
      returned7: 0,
    };
    row.chats++;
    row.turns += chat.turns;
    if (chat.hasTwoTurns) row.chatsWithTwoTurns++;
    row.settled += chat.settled;
    row.stopped += chat.stopped;
    if (chat.canReturn7) row.canReturn7++;
    if (chat.returned7) row.returned7++;
    holdout.set(chat.assignment, row);
  }

  const byAgentModel = [...agentModel.values()]
    .filter((row) => row.sets >= minSets)
    .map((row) => ({
      ...row,
      clickRate: rate(row.clicked, row.sets),
    }))
    .sort((a, b) => b.sets - a.sets);
  const byIntent = [...intent.values()]
    .filter((row) => row.sets >= minSets)
    .map((row) => ({
      ...row,
      clickRate: rate(row.clicked, row.sets),
    }))
    .sort((a, b) => b.sets - a.sets);
  const bySlot = [...slots.values()]
    .filter((row) => row.sets >= minSets)
    .sort((a, b) => a.slot - b.slot)
    .map((row) => ({ ...row, clickRate: rate(row.clicked, row.sets) }));
  const cellRows = [...cells.values()]
    .filter((row) => row.sets >= minSets)
    .map((row) => ({ ...row, clickRate: rate(row.clicked, row.sets) }))
    .sort((a, b) => b.sets - a.sets);
  const byModel = [...model.values()]
    .map((row) => ({
      ...row,
      formatFailureRate: rate(row.missing + row.invalid, row.attempts),
    }))
    .sort((a, b) => b.attempts - a.attempts);
  const hiddenCells =
    [...agentModel.values()].filter((row) => row.sets < minSets).length +
    [...intent.values()].filter((row) => row.sets < minSets).length +
    [...cells.values()].filter((row) => row.sets < minSets).length +
    [...slots.values()].filter((row) => row.sets < minSets).length;

  return {
    since: options.since.toISOString(),
    generatedAt: (options.now ?? new Date()).toISOString(),
    tenantDatabases: scans.length,
    totals: {
      sets: sets.length,
      pending: scans.reduce((sum, scan) => sum + scan.pending, 0),
      clicked,
      typed,
      typedClose: typedCloseCount,
      left,
      clickRate: rate(clicked, sets.length),
      typedRate: rate(typed, sets.length),
      typedCloseRate: rate(typedCloseCount, typed),
      leftRate: rate(left, sets.length),
      clickedGoingBadly: clickedBad,
      clickedGoingBadlyRate: rate(clickedBad, clicked),
      timeToClickMs: {
        count: clickTimes.length,
        p50: percentile(clickTimes, 0.5),
        p90: percentile(clickTimes, 0.9),
      },
    },
    byAgentModel,
    byIntent,
    bySlot,
    cells: cellRows,
    byModel,
    holdout: [...holdout.values()]
      .sort((a, b) =>
        a.assignment === b.assignment ? 0 : a.assignment === "on" ? -1 : 1,
      )
      .map((row) => ({
        assignment: row.assignment,
        chats: row.chats,
        turns: row.turns,
        turnsPerChat: rate(row.turns, row.chats),
        chatsWithTwoTurns: row.chatsWithTwoTurns,
        chatsWithTwoTurnsRate: rate(row.chatsWithTwoTurns, row.chats),
        stopRate: rate(row.stopped, row.settled),
        return7Chats: row.canReturn7,
        return7Rate: rate(row.returned7, row.canReturn7),
      })),
    hiddenCells,
    minSets,
    close,
  };
}

// Scans every tenant database and prints one aggregate. Read-only.
export async function buildFollowUpsReport(
  databases: readonly Db[],
  options: FollowUpsReportOptions,
): Promise<FollowUpsReport> {
  const scans: TenantScan[] = [];
  for (const db of databases) scans.push(await scanTenant(db, options));
  return summarizeReport(scans, options);
}
