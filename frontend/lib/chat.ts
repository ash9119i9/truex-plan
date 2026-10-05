import type {
  ApprovalRecord,
  DomainEvent,
  Message,
} from "../../shared/contracts";

export type Entry =
  | {
      kind: "message";
      command?: Message["command"];
      id: string;
      role: string;
      text: string;
      turnId?: string;
      itemId?: string;
      aliases?: string[];
      messageIndex?: number;
      final?: boolean;
      done?: boolean;
      delivery?: string;
      steer?: boolean;
    }
  | {
      kind: "thinking";
      id: string;
      turnId?: string;
      itemId?: string;
      text: string;
      summary?: string;
      raw?: string;
      done?: boolean;
    }
  | { kind: "item"; id: string; turnId?: string; item: any }
  // The helper agents a turn started, shown as one live block.
  | { kind: "agents"; id: string; turnId?: string; threadIds: string[] }
  | { kind: "approval"; id: string; turnId?: string; record: ApprovalRecord };
type Answer = Extract<Entry, { kind: "message" }>;
type AnswerUpdate = {
  turnId?: string;
  itemId?: string;
  aliases?: string[];
  messageIndex?: number;
  text: string;
  final: boolean;
  append?: boolean;
};

function answerEntry(
  value: AnswerUpdate,
  previous: Answer | undefined,
  length: number,
): Answer {
  const ids = [value.itemId, ...(value.aliases || [])].filter(
    Boolean,
  ) as string[];
  return {
    kind: "message",
    role: "assistant",
    id:
      previous?.id ||
      `answer:${value.turnId}:${value.itemId ?? value.messageIndex ?? length}`,
    ...value,
    text: value.append && previous ? previous.text + value.text : value.text,
    itemId: value.itemId || previous?.itemId,
    aliases: [
      ...new Set(
        [...(previous?.aliases || []), previous?.itemId, ...ids].filter(
          Boolean,
        ) as string[],
      ),
    ],
    messageIndex: value.messageIndex ?? previous?.messageIndex,
  };
}

// Persisted IDs and runtime IDs are aliases, not separate messages. Never
// compare text globally: two different turns may legitimately say the same thing.
export function upsertMessage(list: Entry[], value: AnswerUpdate): Entry[] {
  const ids = [value.itemId, ...(value.aliases || [])].filter(
    Boolean,
  ) as string[];
  const candidates = list.filter(
    (e): e is Answer =>
      e.kind === "message" &&
      e.role === "assistant" &&
      e.turnId === value.turnId,
  );
  let previous = candidates.find((e) =>
    ids.some((id) => e.itemId === id || e.aliases?.includes(id)),
  );
  previous ??= candidates.find(
    (e) =>
      value.messageIndex !== undefined && e.messageIndex === value.messageIndex,
  );
  // Legacy history has no runtime identity. Adopt it only when identity is
  // missing on one side and the final text agrees, or a single stream is open.
  previous ??= candidates.find(
    (e) =>
      (!e.itemId || !value.itemId) &&
      (e.messageIndex === undefined || value.messageIndex === undefined) &&
      e.text === value.text &&
      value.final,
  );
  if (!previous && (value.final || !value.itemId)) {
    const streaming = candidates.filter(
      (e) =>
        !e.final &&
        (e.messageIndex === undefined ||
          value.messageIndex === undefined ||
          e.messageIndex === value.messageIndex),
    );
    if (streaming.length === 1) previous = streaming[0];
  }
  if (previous?.final && !value.final) return list; // Ignore replayed deltas after completion.
  const entry = answerEntry(value, previous, list.length);
  return previous
    ? list.map((e) => (e === previous ? entry : e))
    : [...list, entry];
}

// Used by hydration and paged merges; positions refer to each caller's own array.
// Keeping duplicate-key positions preserves the live merger's first-match rule.
function createAnswerIndex() {
  const turns = new Map<
    string | undefined,
    {
      identities: Map<string, Set<number>>;
      ordinals: Map<number, Set<number>>;
      texts: Map<string, Set<number>>[];
      streaming: Set<number>;
      streamingOrdinals: Map<number | undefined, Set<number>>;
    }
  >();
  function first(indices: Set<number> | undefined): number | undefined {
    let result: number | undefined;
    for (const index of indices ?? [])
      if (result === undefined || index < result) result = index;
    return result;
  }
  function updateIndex<K>(
    index: Map<K, Set<number>>,
    key: K,
    position: number,
    add: boolean,
  ) {
    if (add) {
      let positions = index.get(key);
      if (!positions) index.set(key, (positions = new Set()));
      positions.add(position);
    } else {
      const positions = index.get(key);
      positions?.delete(position);
      if (positions?.size === 0) index.delete(key);
    }
  }
  return {
    find(value: AnswerUpdate, adoptStream = true): number | undefined {
      const turn = turns.get(value.turnId);
      if (!turn) return undefined;
      let position: number | undefined;
      for (const identity of [value.itemId, ...(value.aliases || [])]) {
        if (!identity) continue;
        const candidate = first(turn.identities.get(identity));
        if (
          candidate !== undefined &&
          (position === undefined || candidate < position)
        )
          position = candidate;
      }
      if (
        position === undefined &&
        value.messageIndex !== undefined &&
        !Number.isNaN(value.messageIndex)
      )
        position = first(turn.ordinals.get(value.messageIndex));
      if (position === undefined && value.final) {
        const textIndex =
          (value.itemId ? 1 : 0) + (value.messageIndex !== undefined ? 2 : 0);
        position = first(turn.texts[textIndex].get(value.text));
      }
      if (
        position === undefined &&
        adoptStream &&
        (value.final || !value.itemId)
      ) {
        const streams =
          value.messageIndex === undefined
            ? turn.streaming
            : new Set([
                ...(turn.streamingOrdinals.get(undefined) ?? []),
                ...(!Number.isNaN(value.messageIndex)
                  ? (turn.streamingOrdinals.get(value.messageIndex) ?? [])
                  : []),
              ]);
        if (streams.size === 1) position = streams.values().next().value;
      }
      return position;
    },
    update(answer: Answer, position: number, add = true) {
      let turn = turns.get(answer.turnId);
      if (!turn)
        turns.set(
          answer.turnId,
          (turn = {
            identities: new Map(),
            ordinals: new Map(),
            // all, missing item ID, missing ordinal, missing both
            texts: Array.from({ length: 4 }, () => new Map()),
            streaming: new Set(),
            streamingOrdinals: new Map(),
          }),
        );
      for (const identity of new Set([
        answer.itemId,
        ...(answer.aliases || []),
      ]))
        if (identity) updateIndex(turn.identities, identity, position, add);
      if (
        answer.messageIndex !== undefined &&
        !Number.isNaN(answer.messageIndex)
      )
        updateIndex(turn.ordinals, answer.messageIndex, position, add);
      updateIndex(turn.texts[0], answer.text, position, add);
      if (!answer.itemId)
        updateIndex(turn.texts[1], answer.text, position, add);
      if (answer.messageIndex === undefined)
        updateIndex(turn.texts[2], answer.text, position, add);
      if (!answer.itemId && answer.messageIndex === undefined)
        updateIndex(turn.texts[3], answer.text, position, add);
      if (!answer.final) {
        if (add) turn.streaming.add(position);
        else turn.streaming.delete(position);
        updateIndex(turn.streamingOrdinals, answer.messageIndex, position, add);
      }
    },
  };
}

export function historyEntries(messages: Message[]): Entry[] {
  // History is built locally, so append/replace in place instead of copying and
  // searching the growing transcript for every message.
  const list: Entry[] = [];
  const ids = new Set<string>();
  const answers = createAnswerIndex();
  for (const m of messages) {
    if (m.role === "assistant") {
      const value: AnswerUpdate = {
        turnId: m.turnId,
        itemId: m.runtimeItemId || m.itemId,
        aliases: [m.itemId, m.runtimeItemId].filter(Boolean) as string[],
        messageIndex: m.messageIndex,
        text: m.text,
        final: true,
      };
      const position = answers.find(value);
      const previous =
        position === undefined ? undefined : (list[position] as Answer);
      const entry = answerEntry(value, previous, list.length);
      const entryPosition = position ?? list.length;
      if (previous) answers.update(previous, entryPosition, false);
      list[entryPosition] = entry;
      answers.update(entry, entryPosition);
      ids.add(entry.id);
      continue;
    }
    const id = m.clientId || m.itemId || m._id;
    const entry: Entry = {
      kind: "message",
      id,
      role: m.role,
      text: m.text,
      turnId: m.turnId,
      delivery: m.delivery,
      command: m.command,
      steer: m.steer,
      final: true,
    };
    if (!ids.has(id)) {
      ids.add(id);
      list.push(entry);
    }
  }
  return list;
}

function sameEntry(previous: Entry, next: Entry): boolean {
  const before = previous as unknown as Record<string, unknown>;
  return Object.entries(next).every(([key, value]) => {
    if (key === "aliases" && Array.isArray(value)) {
      const old = Array.isArray(before[key]) ? before[key] : [];
      return (
        old.length === value.length && old.every((item, i) => item === value[i])
      );
    }
    return Object.is(before[key], value);
  });
}

/** Merge a bounded persisted window without moving already loaded history behind
 * it. Existing rows retain their UI identities and runtime-only entries stay in
 * place. New rows follow the window's order between shared anchors; an unseen
 * older page precedes the current transcript. */
export function mergeHistoryWindow(
  messages: Message[],
  live: Entry[],
  {
    older = false,
    preserveLive = false,
  }: { older?: boolean; preserveLive?: boolean } = {},
): Entry[] {
  if (messages.length === 0) return live;
  const saved = historyEntries(messages) as Answer[];
  if (live.length === 0) return saved;
  const next = [...live];
  const answers = createAnswerIndex();
  const requests = new Map<string, number>();
  const turnAppend = new Map<string, number>();
  const nextUserAfter: number[] = [];
  let nextUser = live.length;
  for (let i = live.length - 1; i >= 0; i--) {
    nextUserAfter[i] = nextUser;
    const entry = live[i];
    if (entry.kind === "message" && entry.role === "user") nextUser = i;
  }
  // Old reasoning can lack a done flag even though a final answer follows it.
  // Only the suffix after the latest completed answer can be the active tail.
  let lastCompletedAnswer = -1;
  let lastRequest = -1;
  live.forEach((entry, i) => {
    if (entry.kind !== "message") return;
    if (entry.role === "user") lastRequest = i;
    else if (entry.role === "assistant" && (entry.final || entry.done))
      lastCompletedAnswer = i;
  });
  let activeBoundary =
    lastRequest > lastCompletedAnswer ? lastRequest : live.length;
  let previousUser = -1;
  live.forEach((entry, position) => {
    if (entry.kind === "message") {
      if (entry.role === "assistant") answers.update(entry, position);
      else if (!requests.has(entry.id)) requests.set(entry.id, position);
      if (entry.role === "user") previousUser = position;
    }
    if (entry.turnId && !(entry.kind === "message" && entry.role === "user")) {
      if (entry.kind !== "approval") turnAppend.set(entry.turnId, position + 1);
      else if (!turnAppend.has(entry.turnId))
        turnAppend.set(entry.turnId, position);
    }
    const unfinished =
      entry.kind === "thinking"
        ? !entry.done
        : entry.kind === "message" &&
          (entry.role === "assistant"
            ? !entry.final && !entry.done
            : !!entry.delivery && entry.delivery !== "accepted");
    if (
      unfinished &&
      position > lastCompletedAnswer &&
      activeBoundary === live.length
    )
      activeBoundary = previousUser >= 0 ? previousUser : position;
  });
  const matches = saved.map((entry) => {
    const value: AnswerUpdate = {
      turnId: entry.turnId,
      itemId: entry.itemId,
      aliases: entry.aliases,
      messageIndex: entry.messageIndex,
      text: entry.text,
      final: true,
    };
    const position =
      entry.role === "assistant"
        ? answers.find(value, !older && !preserveLive)
        : requests.get(entry.id);
    if (position === undefined) return undefined;
    const previous = next[position] as Answer;
    let merged: Answer;
    if (entry.role === "assistant") {
      // The caller compares its request-start revision with the current stream.
      // Older pages only contribute history; they never overwrite a live overlap.
      const update =
        older || preserveLive
          ? {
              ...value,
              text: previous.text,
              final: previous.final === true,
              itemId: previous.itemId || value.itemId,
              messageIndex: previous.messageIndex ?? value.messageIndex,
              aliases: [
                ...(value.aliases ?? []),
                ...(value.itemId ? [value.itemId] : []),
              ],
            }
          : value;
      merged = { ...previous, ...answerEntry(update, previous, next.length) };
      answers.update(previous, position, false);
      answers.update(merged, position);
    } else {
      const keepCommand =
        previous.command &&
        (!entry.command ||
          (["succeeded", "failed"].includes(previous.command.state) &&
            ["running", "unknown"].includes(entry.command.state)));
      merged = {
        ...previous,
        ...entry,
        command: keepCommand ? previous.command : entry.command,
      };
    }
    next[position] = sameEntry(previous, merged) ? previous : merged;
    return position;
  });
  const nextMatches: (number | undefined)[] = [];
  let followingMatch: number | undefined;
  for (let i = saved.length - 1; i >= 0; i--) {
    followingMatch = matches[i] ?? followingMatch;
    nextMatches[i] = followingMatch;
  }
  const insertions = new Map<number, Answer[]>();
  let precedingMatch: number | undefined;
  saved.forEach((entry, i) => {
    if (matches[i] !== undefined) {
      precedingMatch = matches[i];
      return;
    }
    const turnPosition =
      !older && entry.role === "assistant" && entry.turnId
        ? turnAppend.get(entry.turnId)
        : undefined;
    const position =
      nextMatches[i] ??
      turnPosition ??
      (precedingMatch !== undefined
        ? older
          ? precedingMatch + 1
          : nextUserAfter[precedingMatch]
        : older
          ? 0
          : activeBoundary);
    let bucket = insertions.get(position);
    if (!bucket) insertions.set(position, (bucket = []));
    bucket.push(entry);
  });
  const result: Entry[] = [];
  for (let i = 0; i <= next.length; i++) {
    const inserted = insertions.get(i);
    if (inserted) result.push(...inserted);
    if (i < next.length) result.push(next[i]);
  }
  return result.length === live.length &&
    result.every((entry, i) => entry === live[i])
    ? live
    : result;
}

// Merge a history fetch with events received while it was in flight.
export function mergeHistoryEntries(
  messages: Message[],
  live: Entry[],
): Entry[] {
  let next = historyEntries(messages);
  for (const entry of live) {
    if (entry.kind === "approval") {
      next = addApprovals(next, [entry.record]);
      continue;
    }
    if (entry.kind === "message" && entry.role === "assistant") {
      next = applyChatEvent(next, {
        type: "snapshot",
        data: { messages: [{ ...entry, id: entry.itemId }] },
      } as unknown as DomainEvent);
      continue;
    }
    const existing = next.findIndex((e) => e.id === entry.id);
    if (existing >= 0) {
      const saved = next[existing];
      if (
        entry.kind === "message" &&
        saved.kind === "message" &&
        entry.command &&
        saved.command &&
        ["succeeded", "failed"].includes(entry.command.state) &&
        ["running", "unknown"].includes(saved.command.state)
      )
        next[existing] = entry;
      continue;
    }
    const answerIndex =
      entry.kind === "thinking"
        ? next.findIndex(
            (e) =>
              e.kind === "message" &&
              e.role === "assistant" &&
              e.turnId === entry.turnId,
          )
        : -1;
    next.splice(answerIndex < 0 ? next.length : answerIndex, 0, entry);
  }
  return next;
}

// Resolved approvals stay in the chat as an audit record, placed after the
// rest of their turn so far.
export function addApprovals(list: Entry[], records: ApprovalRecord[]) {
  for (const record of records) {
    const id = `approval:${record.requestId}`;
    const entry: Entry = {
      kind: "approval",
      id,
      turnId: record.turnId,
      record,
    };
    if (list.some((e) => e.id === id)) {
      list = list.map((e) => (e.id === id ? entry : e));
      continue;
    }
    let index = -1;
    if (record.turnId)
      for (let i = list.length - 1; i >= 0; i--)
        if (list[i].turnId === record.turnId) {
          index = i;
          break;
        }
    list = [...list];
    list.splice(index < 0 ? list.length : index + 1, 0, entry);
  }
  return list;
}

// Each helper appears once, in the block of the turn that first reported it.
// Later updates, including a later turn waiting on or closing it, only change
// the helper's state, so replays and duplicates add nothing.
export function addHelpers(
  list: Entry[],
  turnId: string | undefined,
  threadIds: string[],
): Entry[] {
  const shown = new Set(
    list.flatMap((e) => (e.kind === "agents" ? e.threadIds : [])),
  );
  const fresh = [...new Set(threadIds)].filter((id) => !shown.has(id));
  if (!fresh.length) return list;
  const id = `agents:${turnId ?? "none"}`;
  const block = list.find(
    (e): e is Extract<Entry, { kind: "agents" }> =>
      e.kind === "agents" && e.id === id,
  );
  if (block)
    return list.map((e) =>
      e === block ? { ...block, threadIds: [...block.threadIds, ...fresh] } : e,
    );
  return [...list, { kind: "agents", id, turnId, threadIds: fresh }];
}

export function applyChatEvent(list: Entry[], event: DomainEvent): Entry[] {
  const { data: d, turnId, itemId, type } = event;
  if (type === "approval.resolved")
    return d?.audit ? addApprovals(list, [d.audit]) : list;
  if (
    type === "subagent.spawned" ||
    type === "subagent.status" ||
    type === "subagent.completed"
  )
    return typeof d?.agent?.threadId === "string"
      ? addHelpers(list, turnId, [d.agent.threadId])
      : list;
  if (type === "snapshot") {
    // Snapshots don't say which turn started a helper; place any the chat
    // hasn't shown yet with the latest turn.
    const ids = (Array.isArray(d.subAgents) ? d.subAgents : [])
      .map((a: any) => a?.threadId)
      .filter((id: unknown): id is string => typeof id === "string");
    if (ids.length)
      list = addHelpers(
        list,
        d.state?.turnId ?? list.findLast((e) => e.turnId)?.turnId,
        ids,
      );
    for (const r of d.thinking || []) {
      const id = `thinking:${r.turnId}:${r.id}`;
      const entry: Entry = {
        kind: "thinking",
        id,
        turnId: r.turnId,
        itemId: r.id,
        text: r.raw || r.summary || "",
        raw: r.raw,
        summary: r.summary,
        done: r.done,
      };
      if (list.some((e) => e.id === id))
        list = list.map((e) => (e.id === id ? entry : e));
      else {
        const index = list.findIndex(
          (e) =>
            e.turnId === r.turnId &&
            e.kind === "message" &&
            e.role === "assistant",
        );
        list = [...list];
        list.splice(index < 0 ? list.length : index, 0, entry);
      }
    }
    return (d.messages || [])
      .reduce(
        (next: Entry[], m: any) =>
          upsertMessage(next, {
            turnId: m.turnId,
            itemId: m.id,
            messageIndex: m.messageIndex,
            text: m.text,
            final: m.final !== false,
          }),
        list,
      )
      .map((e: Entry) =>
        e.kind === "thinking" && d.state?.kind === "idle"
          ? { ...e, done: true }
          : e,
      );
  }
  if (type === "message.delta" || type === "message.final")
    return upsertMessage(list, {
      turnId,
      itemId,
      messageIndex: d.messageIndex,
      text: type === "message.final" ? d.text : d.delta,
      final: type === "message.final",
      append: type === "message.delta",
    });
  if (type === "turn.completed")
    return list.map((e) =>
      e.turnId === turnId
        ? e.kind === "thinking"
          ? { ...e, done: true }
          : e.kind === "message" && e.role === "assistant"
            ? { ...e, done: true }
            : e
        : e,
    );
  if (
    type === "reasoning.delta" ||
    ((type === "item.started" || type === "item.completed") &&
      d.item?.type === "reasoning")
  ) {
    const id = itemId || d.item?.id;
    const previous = list.find(
      (e): e is Extract<Entry, { kind: "thinking" }> =>
        e.kind === "thinking" && e.turnId === turnId && e.itemId === id,
    );
    if (type === "reasoning.delta" && previous?.done) return list;
    // Summary and raw reasoning are separate streams; concatenating them repeats content.
    const rawChannel = d.method === "item/reasoning/textDelta";
    const summary =
      type === "reasoning.delta"
        ? (previous?.summary || "") + (rawChannel ? "" : d.delta)
        : (d.item.summary || []).join("\n").trim() || previous?.summary || "";
    const raw =
      (previous?.raw || "") +
      (type === "reasoning.delta" && rawChannel ? d.delta : "");
    const entry: Entry = {
      kind: "thinking",
      id: previous?.id || `thinking:${turnId}:${id || "default"}`,
      turnId,
      itemId: id,
      summary,
      raw,
      text: raw || summary,
      done: previous?.done || type === "item.completed",
    };
    if (previous) return list.map((e) => (e === previous ? entry : e));
    // Late reasoning belongs before its turn's answer, even after history hydration.
    const index = list.findIndex(
      (e) =>
        e.turnId === turnId &&
        e.kind !== "thinking" &&
        !(e.kind === "message" && e.role === "user"),
    );
    const next = [...list];
    next.splice(index < 0 ? next.length : index, 0, entry);
    return next;
  }
  if (
    (type === "item.started" || type === "item.completed") &&
    d.item &&
    !["agentMessage", "userMessage"].includes(d.item.type)
  ) {
    const id = `item:${turnId}:${d.item.id}`;
    const entry: Entry = { kind: "item", id, turnId, item: d.item };
    return list.some((e) => e.id === id)
      ? list.map((e) => (e.id === id ? entry : e))
      : [...list, entry];
  }
  return list;
}

// Some providers replay an answer on a second, unfinished item after finalizing
// the first. Retain its buffer for correct delta assembly, but don't render that
// shadow. Two completed messages (even identical ones) remain distinct.
export function visibleEntries(entries: Entry[]): Entry[] {
  return entries.filter((e) => {
    if (
      e.kind !== "message" ||
      e.role !== "assistant" ||
      e.final ||
      !e.turnId ||
      !e.text.trim()
    )
      return true;
    return !entries.some(
      (other) =>
        other.kind === "message" &&
        other.role === "assistant" &&
        other.final &&
        other.turnId === e.turnId &&
        other.text.trim().startsWith(e.text.trim()),
    );
  });
}
