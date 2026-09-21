"use client";
import { useEffect, useState } from "react";
import type { PendingRequest } from "../../shared/contracts";
import { Button } from "./ui/button";
export function RequestCard({
  request,
  onAnswer,
}: {
  request: PendingRequest;
  onAnswer: (value: unknown) => Promise<void>;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [expired, setExpired] = useState(
    Date.now() >= Date.parse(request.expiresAt),
  );
  useEffect(() => {
    const timer = setTimeout(
      () => setExpired(true),
      Math.max(0, Date.parse(request.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [request.expiresAt]);
  if (request.method !== "item/tool/requestUserInput") return null;
  const questions = request.detail.questions as {
    id: string;
    question: string;
    isSecret?: boolean;
    options?: { label: string; description: string }[];
  }[];
  return (
    <form
      className="request-card"
      onSubmit={async (e) => {
        e.preventDefault();
        if (expired || busy) return;
        setBusy(true);
        setError("");
        try {
          await onAnswer({
            answers: Object.fromEntries(
              questions.map((q) => [q.id, { answers: [answers[q.id] || ""] }]),
            ),
          });
        } catch {
          setError("Your answer could not be submitted. Please try again.");
        } finally {
          setBusy(false);
        }
      }}
    >
      <h3>Your input is needed</h3>
      {questions.map((q) => (
        <label key={q.id}>
          {q.question}
          {q.options?.map((option) => (
            <Button
              key={option.label}
              type="button"
              variant="outline"
              disabled={busy || expired}
              aria-pressed={answers[q.id] === option.label}
              title={option.description}
              onClick={() =>
                setAnswers((old) => ({ ...old, [q.id]: option.label }))
              }
            >
              {option.label}
            </Button>
          ))}
          <input
            required
            disabled={busy || expired}
            aria-label={q.question}
            type={q.isSecret ? "password" : "text"}
            value={answers[q.id] || ""}
            onChange={(e) =>
              setAnswers((old) => ({ ...old, [q.id]: e.target.value }))
            }
          />
        </label>
      ))}
      {error && <p role="alert">{error}</p>}
      {expired && (
        <p role="status">
          This question has expired. Send a message to continue.
        </p>
      )}
      <Button disabled={busy || expired} type="submit">
        Submit answer
      </Button>
    </form>
  );
}
