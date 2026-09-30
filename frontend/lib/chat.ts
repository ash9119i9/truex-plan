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
      // ISO time the message was sent or saved.
      at?: string;
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

// Persisted IDs and runtime IDs are aliases, not separate messages. Never
// compare text globally: two different turns may legitimately say the same thing.
export function upsertMessage(
  list: Entry[],
  value: {
    turnId?: string;
    itemId?: string;
    aliases?: string[];
    messageIndex?: number;
    text: string;
    final: boolean;
    append?: boolean;
    at?: string;
  },
): Entry[] {
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
  const entry: Answer = {
    kind: "message",
    role: "assistant",
    id:
      previous?.id ||
      `answer:${value.turnId}:${value.itemId ?? value.messageIndex ?? list.length}`,
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
    at: value.at ?? previous?.at,
  };
  if (!entry.at) delete entry.at;
  return previous
    ? list.map((e) => (e === previous ? entry : e))
    : [...list, entry];
}

export function historyEntries(messages: Message[]): Entry[] {
  return messages.reduce<Entry[]>((list, m) => {
    if (m.role === "assistant")
      return upsertMessage(list, {
        turnId: m.turnId,
        itemId: m.runtimeItemId || m.itemId,
        aliases: [m.itemId, m.runtimeItemId].filter(Boolean) as string[],
        messageIndex: m.messageIndex,
        text: m.text,
        final: true,
        at: m.at,
      });
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
      ...(m.at ? { at: m.at } : {}),
    };
    return list.some((e) => e.id === id) ? list : [...list, entry];
  }, []);
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
