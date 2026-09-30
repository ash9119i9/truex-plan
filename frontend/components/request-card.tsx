"use client";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { RqIcon } from "./v2/rq-icon";
import { useClock } from "./use-clock";
import type { ApprovalRecord, PendingRequest } from "../../shared/contracts";
import {
  answerErrorMessage,
  answerPayload,
  missingAnswers,
  needsText,
  type InputQuestion,
} from "../lib/request-input";
import {
  APPROVE,
  PLAN_APPROVAL_ID,
  REVISE,
  planApprovalPayload,
  type PlanStep,
} from "../lib/plan";
import { errorRef, type ErrorRef as Ref } from "../lib/api";
import { ErrorRef } from "./error-ref";
import {
  auditView,
  countdown,
  fieldValues,
  holdView,
  missingFields,
  requestView,
  sortRequests,
  type DecisionView,
  type FieldView,
  type QuestionView,
  type RequestView,
} from "../lib/vm-requests";

// Live request card (wireframe r2 §2). It docks directly above the composer,
// never in the scroll. The stream keeps a quiet placeholder (RequestHold)
// that later becomes the one-line audit row (RequestAudit).

const cardId = (requestId: string) => `rq-${requestId}`;

type Answer = (value: unknown) => Promise<void>;

/** Every open request, oldest first, stacked with a pager. */
export function RequestDock({
  pending,
  plan = [],
  planVersion,
  previousPlan,
  onAnswer,
  onDismiss,
  onRequestChanges,
}: {
  pending: PendingRequest[];
  plan?: PlanStep[];
  planVersion?: number;
  previousPlan?: PlanStep[] | null;
  onAnswer: (requestId: string, value: unknown) => Promise<void>;
  /** Skip a question or decline a secret (no answer is sent). Hidden when absent. */
  onDismiss?: (requestId: string) => void;
  /** Request changes on a plan in the composer instead of inline feedback. */
  onRequestChanges?: (plan: PlanStep[]) => void;
}) {
  const sorted = sortRequests(pending);
  const [index, setIndex] = useState(0);
  // Answering one brings the next forward.
  const at = Math.min(index, Math.max(0, sorted.length - 1));
  const front = sorted[at];
  if (!front) return null;
  const behind = sorted.length - 1;
  return (
    <div className="rq-requests" role="region" aria-label="Open requests">
      {sorted.length > 1 && (
        <div className="rq-stackbar">
          <RqIcon name="layers" size="sm" />
          <b>
            {at + 1} of {sorted.length} open
          </b>
          oldest first
          <span className="rq-pager">
            <button
              type="button"
              aria-label="Previous request"
              disabled={at === 0}
              onClick={() => setIndex(at - 1)}
            >
              <RqIcon name="chev" size="sm" />
            </button>
            <button
              type="button"
              aria-label="Next request"
              disabled={at === sorted.length - 1}
              onClick={() => setIndex(at + 1)}
            >
              <RqIcon name="chev" size="sm" />
            </button>
          </span>
        </div>
      )}
      <div
        className={`rq-stack${behind === 0 ? " is-single" : behind === 1 ? " is-double" : ""}`}
      >
        <RequestCard
          key={front.requestId}
          request={front}
          plan={plan}
          planVersion={planVersion}
          previousPlan={previousPlan}
          onAnswer={(value) => onAnswer(front.requestId, value)}
          onDismiss={onDismiss && (() => onDismiss(front.requestId))}
          onRequestChanges={onRequestChanges}
        />
      </div>
    </div>
  );
}

// Ticks on the shared one-second clock until the request expires. Requests
// carry no creation time, so the ring drains from when the card first showed.
function useCountdown(request: PendingRequest) {
  const [startedAt] = useState(() => {
    const t = Date.parse(String(request.detail?.createdAt ?? ""));
    return Number.isFinite(t) ? t : Date.now();
  });
  const [done, setDone] = useState(false);
  const now = useClock(!done);
  const view = countdown(request.expiresAt, startedAt, now);
  const expired = !!view && view.left === 0;
  useEffect(() => {
    if (expired) setDone(true);
  }, [expired]);
  return { view, expired };
}

function isTyping(el: EventTarget) {
  return (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement
  );
}

export function RequestCard({
  request,
  onAnswer,
  plan = [],
  planVersion,
  previousPlan,
  onDismiss,
  onRequestChanges,
}: {
  request: PendingRequest;
  onAnswer: Answer;
  plan?: PlanStep[];
  planVersion?: number;
  previousPlan?: PlanStep[] | null;
  onDismiss?: () => void;
  onRequestChanges?: (plan: PlanStep[]) => void;
}) {
  const vm = requestView(request, plan, { planVersion, previousPlan });
  const questions = (
    Array.isArray(request.detail?.questions) ? request.detail.questions : []
  ) as InputQuestion[];
  const { view: clock, expired } = useCountdown(request);

  // Recommended options start selected, so Enter accepts them.
  const [answers, setAnswers] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      vm.questions.flatMap((q) => (q.preselected ? [[q.id, q.preselected]] : [])),
    ),
  );
  const [other, setOther] = useState<Record<string, boolean>>({});
  const [fields, setFields] = useState<Record<string, string>>({});
  const [step, setStep] = useState(0);
  const [missing, setMissing] = useState<string[]>([]);
  const [sending, setSending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [ref, setRef] = useState<Ref | null>(null);
  const [revising, setRevising] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [reveal, setReveal] = useState(false);
  const stepRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // The composer swaps its textarea for a static line while a request is open,
  // so focus falls to <body>. Take it, so keys 1–9 / Enter / Esc reach the card.
  useEffect(() => {
    const el = document.activeElement;
    if (!el || el === document.body || el.closest(".rq-composer"))
      rootRef.current?.focus();
  }, []);
  const shownStep = useRef(step);
  useEffect(() => {
    // Move focus to the new question so keyboard and screen reader users follow along.
    if (shownStep.current === step) return;
    shownStep.current = step;
    stepRef.current?.focus();
  }, [step]);

  const locked = sending !== null || expired;
  const last = vm.questions.length - 1;
  const at = Math.min(step, Math.max(0, last));
  const current = vm.questions[at];
  const titleId = `${cardId(request.requestId)}-title`;

  async function submit(value: unknown, key: string) {
    if (locked) return;
    setSending(key);
    setError("");
    setRef(null);
    try {
      await onAnswer(value);
    } catch (e) {
      setError(answerErrorMessage(e));
      setRef(errorRef(e));
    } finally {
      setSending(null);
    }
  }
  function decide(d: DecisionView) {
    const q = questions.find((x) => x.kind === "toolApproval");
    if (q) void submit(answerPayload([q], { [q.id]: d.value }), d.value);
  }
  function sendAnswers() {
    const unanswered = [
      ...missingAnswers(questions, answers),
      ...missingFields(vm.fields, fields),
    ];
    setMissing(unanswered);
    if (unanswered.length) {
      const first = questions.findIndex((q) => q.id === unanswered[0]);
      if (first >= 0 && first !== at) setStep(first);
      return;
    }
    const payload = answerPayload(questions, answers);
    void submit(
      vm.fields.length
        ? { ...payload, fields: fieldValues(vm.fields, fields) }
        : payload,
      "submit",
    );
  }
  function advance() {
    if (vm.kind === "plan") {
      if (revising) {
        if (feedback.trim())
          void submit(planApprovalPayload(REVISE, feedback), REVISE);
      } else void submit(planApprovalPayload(APPROVE), APPROVE);
      return;
    }
    if (vm.kind === "tool") {
      const primary = vm.decisions.find((d) => d.variant === "primary");
      if (primary) decide(primary);
      return;
    }
    if (at < last) {
      if ((answers[current.id] || "").trim()) setStep(at + 1);
      else setMissing([current.id]);
    } else sendAnswers();
  }
  function pick(q: QuestionView, value: string) {
    setAnswers((old) => ({ ...old, [q.id]: value }));
    setOther((old) => ({ ...old, [q.id]: false }));
    setMissing((old) => old.filter((id) => id !== q.id));
  }
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || locked)
      return;
    const typing = isTyping(e.target);
    if (e.key === "Escape") {
      if (revising) setRevising(false);
      else if (vm.kind === "tool") {
        const decline = vm.decisions.find((d) => d.kbd === "Esc");
        if (decline) decide(decline);
      } else if (onDismiss) onDismiss();
      else return;
      e.preventDefault();
      return;
    }
    // Enter in a one-line input sends; the card sits inside the composer's
    // <form>, so it is a div and never submits that form.
    if (e.key === "Enter" && e.target instanceof HTMLInputElement) {
      e.preventDefault();
      advance();
      return;
    }
    if (typing) return;
    if (/^[1-9]$/.test(e.key)) {
      const n = Number(e.key) - 1;
      if (vm.kind === "tool") {
        const d = vm.decisions.filter((x) => x.kbd !== "Esc")[n];
        if (d) decide(d);
      } else if (current?.options[n]) pick(current, current.options[n].value);
      else return;
      e.preventDefault();
      return;
    }
    // Buttons handle their own Enter; the card itself takes it for the primary action.
    if (e.key === "Enter" && e.target === e.currentTarget) {
      e.preventDefault();
      advance();
    }
  }

  // Only input requests render; anything else keeps the old behaviour (nothing).
  if (request.method !== "item/tool/requestUserInput" || !questions.length)
    return null;

  const planOption = (label: string) =>
    questions
      .find((q) => q.id === PLAN_APPROVAL_ID)
      ?.options?.some((o) => o.label === label);

  return (
    <div
      id={cardId(request.requestId)}
      ref={rootRef}
      tabIndex={-1}
      role="group"
      className={`rq-req${vm.kind === "tool" ? " is-tool" : ""}`}
      aria-labelledby={titleId}
      aria-busy={sending !== null}
      onKeyDown={onKeyDown}
    >
      <Head
        vm={vm}
        titleId={titleId}
        clock={expired ? null : clock}
        step={vm.questions.length > 1 ? `${at + 1} of ${vm.questions.length}` : ""}
      />

      {vm.kind === "tool" && vm.tool && (
        <>
          <div className="rq-cmd">
            {vm.tool.cwd && (
              <div className="cwd">
                <RqIcon name="file" size="sm" />
                {vm.tool.cwd} · shell
              </div>
            )}
            <div className="line">
              <i>$</i> {vm.tool.command}
            </div>
          </div>
          {vm.tool.effects.length > 0 && (
            <div className="rq-risks">
              {vm.tool.effects.map((effect) => (
                <span
                  key={effect.text}
                  className={`rq-risk${effect.safe ? " ok" : ""}`}
                >
                  <RqIcon name={effect.safe ? "shield" : "activity"} size="sm" />
                  {effect.text}
                </span>
              ))}
            </div>
          )}
        </>
      )}

      {vm.kind === "plan" &&
        (vm.plan.length ? (
          <ol className="rq-plan">
            {vm.plan.map((s) => (
              <li key={s.n} className={s.isNew ? "is-new" : undefined}>
                <i>{s.n}</i>
                <span>{s.text}</span>
                {s.isNew ? (
                  <small>New{planVersion ? ` in v${planVersion}` : ""}</small>
                ) : (
                  <span />
                )}
              </li>
            ))}
          </ol>
        ) : (
          <p className="rq-hint">The drafted steps are in the message above.</p>
        ))}
      {vm.kind === "plan" && revising && (
        <label className="rq-field">
          <span>What should change?</span>
          <textarea
            className="rq-feedback"
            rows={3}
            autoFocus
            disabled={locked}
            placeholder="For example: split step 2, skip the report"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                advance();
              }
            }}
          />
        </label>
      )}

      {(vm.kind === "question" || vm.kind === "secret") && current && (
        <div ref={stepRef} tabIndex={-1} className="rq-body">
          <QuestionBody
            q={current}
            raw={questions[at]}
            inputId={`${cardId(request.requestId)}-${at}`}
            value={answers[current.id] || ""}
            other={!!other[current.id]}
            invalid={missing.includes(current.id)}
            locked={locked}
            reveal={reveal}
            showLegend={vm.questions.length > 1 || vm.kind === "secret"}
            onReveal={() => setReveal((r) => !r)}
            onPick={(value) => pick(current, value)}
            onOther={() => {
              setOther((old) => ({ ...old, [current.id]: true }));
              setAnswers((old) => ({ ...old, [current.id]: "" }));
            }}
            onText={(value) => {
              setAnswers((old) => ({ ...old, [current.id]: value }));
              if (value.trim())
                setMissing((old) => old.filter((id) => id !== current.id));
            }}
          />
          {at === last && vm.fields.length > 0 && (
            <SchemaFields
              fields={vm.fields}
              values={fields}
              missing={missing}
              locked={locked}
              idPrefix={cardId(request.requestId)}
              onChange={(key, value) => {
                setFields((old) => ({ ...old, [key]: value }));
                if (value.trim()) setMissing((old) => old.filter((id) => id !== key));
              }}
            />
          )}
        </div>
      )}
      {vm.kind === "secret" && (
        <div className="rq-note">
          <RqIcon name="shield" size="sm" />
          <span>
            Goes to the tool only. The stream just says <b>Key provided</b>.
          </span>
        </div>
      )}

      {error && (
        <p role="alert" className="request-error">
          {error}
          <ErrorRef value={ref} />
        </p>
      )}
      {expired ? (
        <p role="status" className="rq-hint">
          {vm.kind === "tool" || vm.kind === "secret"
            ? "Expired, declined. Send a message to continue."
            : "No reply in time. Continuing with the recommended option."}
        </p>
      ) : (
        <div className="rq-acts">
          {vm.kind === "tool" &&
            vm.decisions.map((d) => (
              <DecisionButton
                key={d.value}
                d={d}
                disabled={locked}
                sending={sending === d.value}
                onClick={() => decide(d)}
              />
            ))}
          {vm.kind === "plan" &&
            (revising ? (
              <>
                <button
                  type="button"
                  className="btn primary"
                  disabled={locked || !feedback.trim()}
                  onClick={advance}
                >
                  <RqIcon name="send" size="sm" />
                  {sending === REVISE ? "Sending…" : "Send changes"}
                </button>
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => setRevising(false)}
                >
                  Cancel <span className="rq-kbd">Esc</span>
                </button>
              </>
            ) : (
              <>
                <button type="button" className="btn primary" disabled={locked} onClick={advance}>
                  <RqIcon name="check" size="sm" />
                  {sending === APPROVE ? "Sending…" : "Approve plan"}
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={locked}
                  onClick={() =>
                    onRequestChanges ? onRequestChanges(plan) : setRevising(true)
                  }
                >
                  Request changes
                </button>
                {planOption("Reject") && (
                  <button
                    type="button"
                    className="btn ghost"
                    disabled={locked}
                    onClick={() =>
                      void submit(
                        {
                          answers: {
                            [PLAN_APPROVAL_ID]: { answers: ["Reject"] },
                          },
                        },
                        "Reject",
                      )
                    }
                  >
                    Reject
                  </button>
                )}
              </>
            ))}
          {(vm.kind === "question" || vm.kind === "secret") && (
            <>
              {at > 0 && (
                <button
                  type="button"
                  className="btn ghost"
                  disabled={locked}
                  onClick={() => setStep(at - 1)}
                >
                  Back
                </button>
              )}
              <button type="button" className="btn primary" disabled={locked} onClick={advance}>
                <RqIcon name={vm.kind === "secret" ? "lock" : "send"} size="sm" />
                {at < last
                  ? "Next"
                  : sending === "submit"
                    ? "Sending…"
                    : vm.kind === "secret"
                      ? "Submit key"
                      : "Send answer"}
                {vm.kind === "question" && <span className="rq-kbd">Enter</span>}
              </button>
              {onDismiss && (
                <button
                  type="button"
                  className="btn ghost"
                  disabled={locked}
                  onClick={onDismiss}
                >
                  {vm.kind === "secret" ? "Decline" : "Skip"}
                  {vm.kind === "question" && <span className="rq-kbd">Esc</span>}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Head({
  vm,
  titleId,
  clock,
  step,
}: {
  vm: RequestView;
  titleId: string;
  clock: { label: string; percent: number } | null;
  step: string;
}) {
  const kindTone = vm.kind === "tool" ? " warn" : vm.kind === "question" ? " acc" : "";
  const tileTone = vm.tile === "acc" ? "" : ` ${vm.tile}`;
  return (
    <div className="rq-head">
      <span className={`rq-tile${tileTone}`} aria-hidden="true">
        <RqIcon name={vm.icon} size="lg" />
      </span>
      <div className="rq-ttl">
        <span className={`rq-kind${kindTone}`}>
          {vm.kindLabel}
          {step && ` · ${step}`}
        </span>
        <strong id={titleId}>{vm.title}</strong>
        {vm.subtitle && <small>{vm.subtitle}</small>}
      </div>
      {vm.alwaysAsks ? (
        <span className="rq-always">
          <RqIcon name="lock" size="sm" />
          Always asks
        </span>
      ) : (
        clock && (
          <div className="rq-clock">
            <span
              className={`ring rq-ring${vm.ringTone === "acc" ? " acc" : ""}`}
              style={{ "--p": clock.percent } as CSSProperties}
              role="timer"
              aria-label={`${clock.label} left, ${vm.then}`}
            >
              <span aria-hidden="true">{clock.label}</span>
            </span>
            <small aria-hidden="true">{vm.then}</small>
          </div>
        )
      )}
    </div>
  );
}

function DecisionButton({
  d,
  disabled,
  sending,
  onClick,
}: {
  d: DecisionView;
  disabled: boolean;
  sending: boolean;
  onClick: () => void;
}) {
  const cls = d.variant === "primary" ? "btn primary" : d.variant === "ghost" ? "btn ghost" : "btn";
  return (
    <>
      {d.variant === "ghost" && <span className="spacer" />}
      <button
        type="button"
        className={cls}
        disabled={disabled}
        aria-keyshortcuts={d.kbd === "Esc" ? "Escape" : d.kbd}
        onClick={onClick}
      >
        {d.variant === "primary" && <RqIcon name="check" size="sm" />}
        {d.variant === "ghost" && <RqIcon name="x" size="sm" />}
        {sending ? "Sending…" : d.text} <span className="rq-kbd">{d.kbd}</span>
      </button>
    </>
  );
}

function QuestionBody({
  q,
  raw,
  inputId,
  value,
  other,
  invalid,
  locked,
  reveal,
  showLegend,
  onReveal,
  onPick,
  onOther,
  onText,
}: {
  q: QuestionView;
  raw: InputQuestion | undefined;
  inputId: string;
  value: string;
  other: boolean;
  invalid: boolean;
  locked: boolean;
  reveal: boolean;
  showLegend: boolean;
  onReveal: () => void;
  onPick: (value: string) => void;
  onOther: () => void;
  onText: (value: string) => void;
}) {
  const invalidId = `${inputId}-missing`;
  const writing = raw ? needsText(raw, other) : !q.options.length;
  return (
    <>
      {q.options.length > 0 && (
        <fieldset
          className="rq-opts"
          role="radiogroup"
          aria-label={q.question}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? invalidId : undefined}
          disabled={locked}
        >
          {showLegend && <legend>{q.question}</legend>}
          {q.options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={!other && value === o.value}
              className={`rq-opt${o.recommended && !other && value === o.value ? " is-rec" : ""}`}
              onClick={() => onPick(o.value)}
            >
              <span className="radio" aria-hidden="true" />
              <div>
                <b>{o.text}</b>
                {o.recommended && (
                  <span className="rq-rec">
                    <RqIcon name="spark" size="sm" />
                    Recommended
                  </span>
                )}
                {o.description && <small>{o.description}</small>}
              </div>
              {o.kbd ? <span className="rq-kbd">{o.kbd}</span> : <span />}
            </button>
          ))}
          {q.allowsOther && (
            <button
              type="button"
              role="radio"
              aria-checked={other}
              aria-controls={inputId}
              className="rq-opt"
              onClick={onOther}
            >
              <span className="radio" aria-hidden="true" />
              <div>
                <b>Something else…</b>
                <small>Type your own answer</small>
              </div>
              <span />
            </button>
          )}
        </fieldset>
      )}
      {writing && (
        <label className="rq-field" htmlFor={inputId}>
          <span>
            {q.secret ? q.header || "Value" : showLegend || q.options.length ? "Your answer" : q.question}{" "}
            <b className="req" aria-hidden="true">*</b>
          </span>
          <span className="rq-in">
            <input
              id={inputId}
              // Only an explicit true hides input; redacted or missing flags stay visible.
              type={q.secret && !reveal ? "password" : "text"}
              className={q.secret && !reveal ? "rq-mask" : undefined}
              placeholder={q.secret ? "" : "Type your answer"}
              autoComplete="off"
              spellCheck={q.secret ? false : undefined}
              autoFocus={other || q.secret}
              required
              disabled={locked}
              aria-invalid={invalid || undefined}
              aria-describedby={invalid ? invalidId : undefined}
              value={value}
              onChange={(e) => onText(e.target.value)}
            />
            {q.secret && (
              <button
                type="button"
                className="rq-reveal"
                aria-label={reveal ? "Hide value" : "Show value"}
                aria-pressed={reveal}
                aria-controls={inputId}
                onClick={onReveal}
              >
                <RqIcon name="eye" size="sm" />
              </button>
            )}
          </span>
        </label>
      )}
      {invalid && (
        <p id={invalidId} role="alert" className="request-error">
          This question needs an answer before you can send.
        </p>
      )}
    </>
  );
}

function SchemaFields({
  fields,
  values,
  missing,
  locked,
  idPrefix,
  onChange,
}: {
  fields: FieldView[];
  values: Record<string, string>;
  missing: string[];
  locked: boolean;
  idPrefix: string;
  onChange: (key: string, value: string) => void;
}) {
  return (
    <div className="rq-fields">
      {fields.map((f) => {
        const id = `${idPrefix}-f-${f.key}`;
        const invalid = missing.includes(f.key);
        return (
          <label key={f.key} className="rq-field" htmlFor={id}>
            <span>
              {f.label}
              {f.required && (
                <b className="req" aria-hidden="true">
                  *
                </b>
              )}
              <i>{f.hint}</i>
            </span>
            <span className="rq-in">
              {f.type === "select" ? (
                <select
                  id={id}
                  value={values[f.key] || ""}
                  required={f.required}
                  disabled={locked}
                  aria-invalid={invalid || undefined}
                  onChange={(e) => onChange(f.key, e.target.value)}
                >
                  <option value="">Choose…</option>
                  {f.choices.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              ) : f.type === "boolean" ? (
                <input
                  id={id}
                  type="checkbox"
                  disabled={locked}
                  checked={values[f.key] === "true"}
                  onChange={(e) => onChange(f.key, String(e.target.checked))}
                />
              ) : (
                <input
                  id={id}
                  type={f.type === "number" ? "number" : f.type === "date" ? "date" : "text"}
                  placeholder={f.placeholder || (f.required ? "" : "Add a note for the agent")}
                  required={f.required}
                  disabled={locked}
                  aria-invalid={invalid || undefined}
                  value={values[f.key] || ""}
                  onChange={(e) => onChange(f.key, e.target.value)}
                />
              )}
              {f.type === "date" && (
                <>
                  <span className="spacer" />
                  <RqIcon name="clock" size="sm" />
                </>
              )}
            </span>
          </label>
        );
      })}
    </div>
  );
}

/** Dashed stream row where the request was raised; links down to the card. */
export function RequestHold({ request }: { request: PendingRequest }) {
  const hold = holdView(request);
  return (
    <span className="rq-hold" role="status">
      <RqIcon name="clock" size="sm" />
      <span>
        {hold.text}
        {hold.code && (
          <>
            {" "}
            <code>{hold.code}</code>
          </>
        )}
      </span>
      <button
        type="button"
        className="rq-jump"
        onClick={() => {
          const card = document.getElementById(cardId(request.requestId));
          card?.scrollIntoView({ block: "nearest" });
          card?.focus();
        }}
      >
        Answer below
        <RqIcon name="chevd" size="sm" />
      </button>
    </span>
  );
}

/** One-line audit row a resolved request collapses into. */
export function RequestAudit({ record }: { record: ApprovalRecord }) {
  const a = auditView(record);
  return (
    <div className={`rq-audit${a.ok ? "" : " is-off"}`}>
      <RqIcon name={a.ok ? "check" : "x"} size="sm" />
      <b>{a.lead}</b>
      {a.detail && <span>{a.detail}</span>}
      {a.meta && <span>· {a.meta}</span>}
    </div>
  );
}
