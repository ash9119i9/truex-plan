import type { DomainEvent, Message } from "../../shared/contracts";

export type Entry =
  | {
      kind: "message";
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
  | { kind: "item"; id: string; turnId?: string; item: any };
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
  };
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
      });
    const id = m.clientId || m.itemId || m._id;
    const entry: Entry = {
      kind: "message",
      id,
      role: m.role,
      text: m.text,
      turnId: m.turnId,
      delivery: m.delivery,
      steer: m.steer,
      final: true,
    };
    return list.some((e) => e.id === id) ? list : [...list, entry];
  }, []);
}

export function applyChatEvent(list: Entry[], event: DomainEvent): Entry[] {
  const { data: d, turnId, itemId, type } = event;
  if (type === "snapshot")
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
