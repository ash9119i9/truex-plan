"use client";
import { useEffect, useRef, useState } from "react";
import { Icon } from "./v2/icon";
import { LiveDuration } from "./live-duration";
import { useClock } from "./use-clock";
import type { PendingRequest } from "../../shared/contracts";
import {
  afterPick,
  answerPayload,
  answersOnClick,
  answerErrorMessage,
  isDecline,
  missingAnswers,
  needsText,
  optionLabel,
  msLeft,
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
import { PlanSteps } from "./plan-steps";

export function RequestCard({
  request,
  onAnswer,
  plan = [],
  disabled = false,
}: {
  request: PendingRequest;
  onAnswer: (value: unknown) => Promise<void>;
  plan?: PlanStep[];
  disabled?: boolean;
}) {
  const questions = (request.detail?.questions || []) as InputQuestion[];
  if (
    request.method === "item/tool/requestUserInput" &&
    questions.length === 1 &&
    questions[0].id === PLAN_APPROVAL_ID
  )
    return (
      <PlanApprovalCard
        request={request}
        question={questions[0]}
        plan={plan}
        onAnswer={onAnswer}
        disabled={disabled}
      />
    );
  return (
    <QuestionCard request={request} onAnswer={onAnswer} disabled={disabled} />
  );
}

// Ticks on the shared one-second clock until the request expires.
function useExpiry(expiresAt: string) {
  const [done, setDone] = useState(() => msLeft(expiresAt, Date.now()) === 0);
  const now = useClock(!done);
  const remaining = msLeft(expiresAt, now);
  useEffect(() => {
    if (remaining === 0) setDone(true);
  }, [remaining]);
  return { expired: remaining === 0, remaining };
}

function ExpiryTimer({ ms }: { ms: number }) {
  return (
    <span className="request-card-timer">
      Expires in <LiveDuration ms={ms} trend={-1} />
    </span>
  );
}

function PlanApprovalCard({
  request,
  question,
  plan,
  onAnswer,
  disabled,
}: {
  request: PendingRequest;
  question: InputQuestion;
  plan: PlanStep[];
  onAnswer: (value: unknown) => Promise<void>;
  disabled: boolean;
}) {
  const { expired, remaining } = useExpiry(request.expiresAt);
  const [revising, setRevising] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [sending, setSending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [ref, setRef] = useState<Ref | null>(null);
  const locked = disabled || sending !== null || expired;
  const feedbackId = `${request.requestId}-feedback`;

  async function send(choice: typeof APPROVE | typeof REVISE) {
    if (locked || (choice === REVISE && !feedback.trim())) return;
    setSending(choice);
    setError("");
    setRef(null);
    try {
      await onAnswer(planApprovalPayload(choice, feedback));
    } catch (e) {
      setError(answerErrorMessage(e));
      setRef(errorRef(e));
    } finally {
      setSending(null);
    }
  }

  return (
    <form
      className="request-card plan-approval"
      aria-busy={sending !== null}
      aria-labelledby={`${request.requestId}-title`}
      onSubmit={(e) => {
        e.preventDefault();
        void send(revising ? REVISE : APPROVE);
      }}
    >
      <header className="request-card-head">
        <span className="request-card-icon" aria-hidden="true">
          <Icon name="check" size={16} />
        </span>
        <h3 id={`${request.requestId}-title`}>
          {question.header || "Plan"} ready for review
        </h3>
        {!expired && <ExpiryTimer ms={remaining} />}
      </header>
      {question.question && (
        <p className="plan-approval-question">{question.question}</p>
      )}
      {plan.length ? (
        <PlanSteps plan={plan} />
      ) : (
        <p className="muted">The drafted steps are in the message above.</p>
      )}
      <fieldset className="request-question" disabled={locked}>
        <legend className="sr-only">Approve or revise the plan</legend>
        {revising && (
          <>
            <label htmlFor={feedbackId} className="plan-feedback-label">
              What should change?
            </label>
            <textarea
              id={feedbackId}
              className="request-text plan-feedback"
              rows={3}
              autoFocus
              placeholder="For example: split step 2, skip the report"
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void send(REVISE);
                }
                if (e.key === "Escape") setRevising(false);
              }}
            />
          </>
        )}
        <div className="request-approval-actions plan-approval-actions">
          {revising ? (
            <>
              <button
                className="btn-solid"
                type="submit"
                disabled={locked || !feedback.trim()}
              >
                {sending === REVISE ? "Sending…" : "Send feedback"}
              </button>
              <button
                className="btn-ghost"
                type="button"
                onClick={() => setRevising(false)}
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button className="btn-solid" type="submit">
                {sending === APPROVE ? "Sending…" : "Approve plan"}
              </button>
              <button
                className="btn-soft"
                type="button"
                aria-expanded={false}
                onClick={() => setRevising(true)}
              >
                Revise
              </button>
            </>
          )}
        </div>
      </fieldset>
      {error && (
        <p role="alert" className="request-error">
          {error}
          <ErrorRef value={ref} />
        </p>
      )}
      {expired && (
        <p role="status" className="request-expired">
          No reply in time. Continuing with the recommended option.
        </p>
      )}
    </form>
  );
}

function QuestionCard({
  request,
  onAnswer,
  disabled,
}: {
  request: PendingRequest;
  onAnswer: (value: unknown) => Promise<void>;
  disabled: boolean;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  // Questions where the user chose to write their own answer.
  const [other, setOther] = useState<Record<string, boolean>>({});
  const [sending, setSending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [ref, setRef] = useState<Ref | null>(null);
  // Questions the user tried to send without answering.
  const [missing, setMissing] = useState<string[]>([]);
  const { expired, remaining } = useExpiry(request.expiresAt);
  // Multi-question requests are asked one question at a time.
  const [step, setStep] = useState(0);
  const questionRef = useRef<HTMLFieldSetElement>(null);
  const shownStep = useRef(step);
  useEffect(() => {
    // Move focus to the new question so keyboard and screen reader users follow along.
    if (shownStep.current === step) return;
    shownStep.current = step;
    questionRef.current?.focus();
  }, [step]);
  if (request.method !== "item/tool/requestUserInput") return null;
  const questions = (request.detail.questions || []) as InputQuestion[];
  const busy = sending !== null;
  const locked = disabled || busy || expired;
  const approval = questions.some((q) => q.kind === "toolApproval");
  const oneClick = answersOnClick(questions);
  const last = questions.length - 1;
  const at = Math.min(step, Math.max(0, last));
  const current = questions[at];

  async function send(values: Record<string, string>, key: string) {
    if (locked) return;
    const unanswered = missingAnswers(questions, values);
    setMissing(unanswered);
    if (unanswered.length) {
      // Take the user to the first question that still needs an answer.
      const first = questions.findIndex((q) => q.id === unanswered[0]);
      if (first >= 0 && first !== at) setStep(first);
      return;
    }
    setSending(key);
    setError("");
    setRef(null);
    try {
      await onAnswer(answerPayload(questions, values));
    } catch (e) {
      setError(answerErrorMessage(e));
      setRef(errorRef(e));
    } finally {
      setSending(null);
    }
  }
  function choose(q: InputQuestion, label: string) {
    const next = { ...answers, [q.id]: label };
    setAnswers(next);
    setMissing((old) => old.filter((id) => id !== q.id));
    setOther((old) => ({ ...old, [q.id]: false }));
    if (oneClick) return void send(next, label);
    const then = afterPick(questions, at, next);
    if (then === "next") setStep(at + 1);
    // "wait" means an earlier question is unanswered; send() points to it.
    else void send(next, label);
  }
  function advance() {
    if (at < last) {
      if ((answers[current.id] || "").trim()) setStep(at + 1);
    } else void send(answers, "submit");
  }
  const writing = !!current && needsText(current, !!other[current.id]);
  const currentDone = !!current && !!(answers[current.id] || "").trim();
  // A picked option advances on its own; the button is for typed answers and
  // for moving forward again after stepping back.
  const showPrimary = writing || (at < last && currentDone);
  const title = approval
    ? "Permission needed"
    : questions.length === 1 && questions[0].header
      ? questions[0].header
      : "Your input is needed";

  return (
    <form
      className={`request-card${approval ? " request-card-approval" : ""}`}
      aria-busy={busy}
      onSubmit={(e) => {
        e.preventDefault();
        advance();
      }}
    >
      <header className="request-card-head">
        <span className="request-card-icon" aria-hidden="true">
          {approval ? (
            <svg viewBox="0 0 24 24" width="16" height="16">
              <path
                d="M12 3 5 6v5c0 4.5 3 8.3 7 10 4-1.7 7-5.5 7-10V6l-7-3Z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinejoin="round"
              />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="16" height="16">
              <circle
                cx="12"
                cy="12"
                r="9"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
              />
              <path
                d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5v.4M12 17h.01"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </svg>
          )}
        </span>
        <h3>{title}</h3>
        {questions.length > 1 && (
          <span className="request-step">
            {at + 1} of {questions.length}
          </span>
        )}
        {!expired && <ExpiryTimer ms={remaining} />}
      </header>

      {[current].filter(Boolean).map((q) => {
        const inputId = `${request.requestId}-${at}`;
        const invalidId = `${inputId}-missing`;
        const invalid = missing.includes(q.id);
        const approvalQuestion = q.kind === "toolApproval";
        return (
          <fieldset
            key={q.id}
            ref={questionRef}
            tabIndex={-1}
            className="request-question"
            disabled={locked}
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? invalidId : undefined}
          >
            <legend>
              {questions.length > 1 && q.header ? (
                <span className="request-question-header">{q.header}</span>
              ) : null}
              {q.question}
            </legend>
            {approvalQuestion && q.action && (
              <p className="request-action">
                <span className="request-action-label">Action</span>
                {q.action}
              </p>
            )}
            {!!q.options?.length &&
              (approvalQuestion ? (
                <div className="request-approval-actions">
                  {q.options.map((option, i) => (
                    <button
                      key={option.label}
                      type="button"
                      className={
                        i === 0
                          ? "btn-solid"
                          : isDecline(q, option)
                            ? "btn-ghost"
                            : "btn-soft"
                      }
                      title={option.description}
                      onClick={() => choose(q, option.label)}
                    >
                      {sending === option.label
                        ? "Sending…"
                        : optionLabel(q, option)}
                    </button>
                  ))}
                </div>
              ) : (
                <div
                  className="request-options"
                  role="group"
                  aria-label={q.question}
                >
                  {q.options.map((option) => {
                    const picked =
                      !other[q.id] && answers[q.id] === option.label;
                    return (
                      <button
                        key={option.label}
                        type="button"
                        className="request-option"
                        aria-pressed={picked}
                        onClick={() => choose(q, option.label)}
                      >
                        <span className="request-option-label">
                          {sending === option.label ? "Sending…" : option.label}
                        </span>
                        {option.description && (
                          <span className="request-option-description">
                            {option.description}
                          </span>
                        )}
                      </button>
                    );
                  })}
                  {q.isOther && (
                    <button
                      type="button"
                      className="request-option request-option-other"
                      aria-pressed={!!other[q.id]}
                      aria-controls={inputId}
                      onClick={() => {
                        setOther((old) => ({ ...old, [q.id]: true }));
                        setAnswers((old) => ({ ...old, [q.id]: "" }));
                      }}
                    >
                      <span className="request-option-label">
                        Something else…
                      </span>
                      <span className="request-option-description">
                        Type your own answer
                      </span>
                    </button>
                  )}
                </div>
              ))}
            {writing && (
              <>
                <label htmlFor={inputId} className="sr-only">
                  {q.question}
                </label>
                <input
                  id={inputId}
                  className="request-text"
                  // Only an explicit true hides input; redacted or missing flags stay visible.
                  type={q.isSecret === true ? "password" : "text"}
                  placeholder={
                    q.isSecret === true ? "Enter a value" : "Type your answer"
                  }
                  autoComplete="off"
                  autoFocus={!!other[q.id]}
                  aria-invalid={invalid || undefined}
                  aria-describedby={invalid ? invalidId : undefined}
                  value={answers[q.id] || ""}
                  onChange={(e) => {
                    const value = e.target.value;
                    setAnswers((old) => ({ ...old, [q.id]: value }));
                    if (value.trim())
                      setMissing((old) => old.filter((id) => id !== q.id));
                  }}
                />
              </>
            )}
            {invalid && (
              <p id={invalidId} role="alert" className="request-error">
                {questions.length > 1
                  ? `Question ${at + 1} of ${questions.length} needs an answer before you can send.`
                  : "This question needs an answer before you can send."}
              </p>
            )}
          </fieldset>
        );
      })}

      {error && (
        <p role="alert" className="request-error">
          {error}
          <ErrorRef value={ref} />
        </p>
      )}
      {expired && (
        <p role="status" className="request-expired">
          {/* Tool permissions and secret questions are declined, not auto-answered. */}
          {approval || questions.some((q) => q.isSecret === true)
            ? "This question has expired. Send a message to continue."
            : "No reply in time. Continuing with the recommended option."}
        </p>
      )}
      {!expired && (at > 0 || showPrimary) && (
        <div className="request-submit">
          {at > 0 && (
            <button
              className="btn-ghost"
              type="button"
              disabled={locked}
              onClick={() => setStep(at - 1)}
            >
              Back
            </button>
          )}
          {showPrimary && (
            <button
              className="btn-solid"
              type="submit"
              disabled={locked || !currentDone}
            >
              {at < last
                ? "Next"
                : sending === "submit"
                  ? "Sending…"
                  : "Send answer"}
            </button>
          )}
        </div>
      )}
    </form>
  );
}
