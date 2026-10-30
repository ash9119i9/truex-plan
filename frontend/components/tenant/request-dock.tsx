"use client";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  countdown,
  dockQueue,
  onceAtATime,
  requestKey,
} from "@/lib/request-dock";
import { mask } from "@/lib/mask";
import {
  helperApprovalNote,
  type ApprovalView,
  type LiveReply,
} from "@/lib/tenant-chat";
import {
  connectorName,
  humanizeToolName,
  sentence,
  type ApprovalAnswer,
  type ConnectorRef,
} from "@/lib/tenant-connectors";
import { allowForChatHint, codingRequestName } from "@/lib/tenant-coding";
import { Button } from "@/components/tx/button";
import { Icon } from "@/components/tx/icon";

// The request dock (DESIGN-SPEC 10.4, 13.1, 13.4): the oldest pending request
// of the live reply, one card at a time, directly above the composer so it
// can't scroll away. The queue position shows inside the card ("1 of 2").
export function RequestDock({
  live,
  connectors,
  busy,
  onApprove,
}: {
  live: LiveReply | null;
  connectors: ConnectorRef[];
  /** The approval whose answer is in flight. */
  busy: string | null;
  onApprove: (
    approvalId: string,
    decision: ApprovalAnswer,
  ) => Promise<void> | void;
}) {
  const queue = dockQueue(live);
  if (!live || queue.length === 0) return null;
  const current = queue[0];
  return (
    <div
      className="cs-pinned"
      role="region"
      aria-label="Waiting for your answer"
    >
      <ToolRequestCard
        key={current.approvalId}
        approval={current}
        position={queue.length > 1 ? `1 of ${queue.length}` : null}
        connector={
          current.kind === "mcp"
            ? connectorName(current.connector, connectors)
            : "Workspace"
        }
        busy={busy === current.approvalId}
        helperNote={helperApprovalNote(live.helpers)}
        onApprove={onApprove}
      />
    </div>
  );
}

// Re-renders every 500 ms while there is an expiry to count down.
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

const editable = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    ((target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement) &&
      !target.disabled &&
      !target.readOnly));

function ToolRequestCard({
  approval,
  position,
  connector,
  busy,
  helperNote,
  onApprove,
}: {
  approval: ApprovalView;
  position: string | null;
  connector: string;
  busy: boolean;
  helperNote: string | null;
  onApprove: (
    approvalId: string,
    decision: ApprovalAnswer,
  ) => Promise<void> | void;
}) {
  const titleId = useId();
  const card = useRef<HTMLElement>(null);
  const [acting, setActing] = useState<ApprovalAnswer | null>(null);
  const time = countdown(approval.expiresAt, useNow(!!approval.expiresAt));
  const expired = !!time?.expired;
  const coding = approval.kind !== "mcp";
  const command =
    approval.kind === "command"
      ? approval.params.find((p) => p.name === "command")?.value
      : undefined;
  const race =
    approval.race === "resolved"
      ? "This was already answered."
      : approval.race === "not_found"
        ? "This review is gone. It may have expired."
        : null;
  const open = !race && !expired;
  const sending = busy || acting !== null;

  // One decision at a time: a double click (or a repeated key) sends once.
  const answer = useRef(onApprove);
  answer.current = onApprove;
  const act = useMemo(
    () =>
      onceAtATime(async (decision: ApprovalAnswer) => {
        setActing(decision);
        try {
          await answer.current(approval.approvalId, decision);
        } finally {
          setActing(null);
        }
      }),
    [approval.approvalId],
  );

  // Focus the card when it appears, so a keyboard user reaches its buttons;
  // preventScroll keeps a reader who scrolled up in place.
  useEffect(() => {
    card.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || e.metaKey || e.ctrlKey || e.altKey)
        return;
      if (editable(e.target)) return;
      const decision = requestKey(e.key, approval);
      if (!decision) return;
      e.preventDefault();
      if (!sending) void act(decision);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  const hint =
    coding && approval.allowForChat ? allowForChatHint(approval.tool) : null;
  return (
    <section
      ref={card}
      className="rq is-tool"
      aria-labelledby={titleId}
      tabIndex={-1}
    >
      <header className="rq-head">
        <span className="rq-ic" aria-hidden="true">
          <Icon name="shield" size="sm" />
        </span>
        <h3 className="rq-title" id={titleId}>
          Permission needed
        </h3>
        {position && <span className="aq-step">{position}</span>}
        {time && (
          <span
            className={time.warn ? "rq-time is-warn" : "rq-time"}
            role="timer"
            aria-label={time.label}
          >
            {time.text}
          </span>
        )}
      </header>
      <div className="at-tool">
        <span className="at-logo" aria-hidden="true">
          {connector.charAt(0).toUpperCase()}
        </span>
        <span className="at-text">
          <span className="at-name">
            {coding
              ? codingRequestName("command")
              : sentence(humanizeToolName(approval.tool))}
          </span>
          <span className="at-connector">{connector}</span>
        </span>
      </div>
      {command !== undefined ? (
        // Shown exactly as it will run: a member must see what they allow.
        <pre className="at-command">{command}</pre>
      ) : (
        approval.params.length > 0 && (
          <details className="at-args">
            <summary>Arguments</summary>
            <dl>
              {approval.params.map((p, i) => (
                <div key={`${p.name}:${i}`}>
                  <dt>{p.name}</dt>
                  <dd>{mask(p.value)}</dd>
                </div>
              ))}
            </dl>
          </details>
        )
      )}
      {helperNote && <p className="rq-note">{helperNote}</p>}
      {race ? (
        <p className="rq-msg" role="status">
          {race}
        </p>
      ) : expired ? (
        <p className="rq-msg" role="status">
          This question has expired. Send a message to continue.
        </p>
      ) : (
        <div className="rq-btns" role="group" aria-label="Your decision">
          <Button
            variant="primary"
            kbd="1"
            disabled={sending}
            working={acting === "allow" ? "Sending…" : undefined}
            onClick={() => void act("allow")}
          >
            Allow once
          </Button>
          {approval.allowForChat && (
            <Button
              className="rq-soft"
              kbd="2"
              disabled={sending}
              working={acting === "allow_for_chat" ? "Sending…" : undefined}
              onClick={() => void act("allow_for_chat")}
            >
              Allow for this chat
            </Button>
          )}
          <span className="pt-spacer" />
          <Button
            variant="ghost"
            kbd="Esc"
            disabled={sending}
            working={acting === "deny" ? "Sending…" : undefined}
            onClick={() => void act("deny")}
          >
            Don’t allow
          </Button>
        </div>
      )}
      {hint && open && <p className="rq-note">{hint}</p>}
    </section>
  );
}
