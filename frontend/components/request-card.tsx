"use client";
import { useEffect, useRef, useState } from "react";
import type { PendingRequest } from "../../shared/contracts";
import {
  afterPick,
  answerPayload,
  answersOnClick,
  complete,
  isDecline,
  needsText,
  optionLabel,
  timeLeft,
  type InputQuestion,
} from "../lib/request-input";
import { Button } from "./ui/button";

export function RequestCard({
  request,
  onAnswer,
}: {
  request: PendingRequest;
  onAnswer: (value: unknown) => Promise<void>;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  // Questions where the user chose to write their own answer.
  const [other, setOther] = useState<Record<string, boolean>>({});
  const [sending, setSending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());
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
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15000);
    const end = setTimeout(
      () => setNow(Date.now()),
      Math.max(0, Date.parse(request.expiresAt) - Date.now()),
    );
    return () => {
      clearInterval(timer);
      clearTimeout(end);
    };
  }, [request.expiresAt]);
  if (request.method !== "item/tool/requestUserInput") return null;
  const questions = (request.detail.questions || []) as InputQuestion[];
  const expired = now >= Date.parse(request.expiresAt);
  const busy = sending !== null;
  const locked = busy || expired;
  const approval = questions.some((q) => q.kind === "toolApproval");
  const oneClick = answersOnClick(questions);
  const last = questions.length - 1;
  const at = Math.min(step, Math.max(0, last));
  const current = questions[at];

  async function send(values: Record<string, string>, key: string) {
    if (locked || !complete(questions, values)) return;
    setSending(key);
    setError("");
    try {
      await onAnswer(answerPayload(questions, values));
    } catch {
      setError("Your answer could not be sent. Please try again.");
    } finally {
      setSending(null);
    }
  }
  function choose(q: InputQuestion, label: string) {
    const next = { ...answers, [q.id]: label };
    setAnswers(next);
    setOther((old) => ({ ...old, [q.id]: false }));
    if (oneClick) return void send(next, label);
    const then = afterPick(questions, at, next);
    if (then === "next") setStep(at + 1);
    else if (then === "send") void send(next, label);
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
  const remaining = timeLeft(request.expiresAt, now);

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
        {remaining && !expired && (
          <span className="request-card-timer">{remaining}</span>
        )}
      </header>

      {[current].filter(Boolean).map((q) => {
        const inputId = `${request.requestId}-${at}`;
        const approvalQuestion = q.kind === "toolApproval";
        return (
          <fieldset
            key={q.id}
            ref={questionRef}
            tabIndex={-1}
            className="request-question"
            disabled={locked}
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
                    <Button
                      key={option.label}
                      type="button"
                      variant={
                        i === 0
                          ? "default"
                          : isDecline(q, option)
                            ? "ghost"
                            : "outline"
                      }
                      title={option.description}
                      onClick={() => choose(q, option.label)}
                    >
                      {sending === option.label
                        ? "Sending…"
                        : optionLabel(q, option)}
                    </Button>
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
                  value={answers[q.id] || ""}
                  onChange={(e) =>
                    setAnswers((old) => ({ ...old, [q.id]: e.target.value }))
                  }
                />
              </>
            )}
          </fieldset>
        );
      })}

      {error && (
        <p role="alert" className="request-error">
          {error}
        </p>
      )}
      {expired && (
        <p role="status" className="request-expired">
          This question has expired. Send a message to continue.
        </p>
      )}
      {!expired && (at > 0 || showPrimary) && (
        <div className="request-submit">
          {at > 0 && (
            <Button
              type="button"
              variant="ghost"
              disabled={locked}
              onClick={() => setStep(at - 1)}
            >
              Back
            </Button>
          )}
          {showPrimary && (
            <Button
              type="submit"
              disabled={
                locked ||
                (at < last ? !currentDone : !complete(questions, answers))
              }
            >
              {at < last
                ? "Next"
                : sending === "submit"
                  ? "Sending…"
                  : "Send answer"}
            </Button>
          )}
        </div>
      )}
    </form>
  );
}
