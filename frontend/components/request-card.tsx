"use client";
import { useState } from "react";
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
              onClick={() =>
                setAnswers((old) => ({ ...old, [q.id]: option.label }))
              }
            >
              {option.label}
            </Button>
          ))}
          <input
            required
            type={q.isSecret ? "password" : "text"}
            value={answers[q.id] || ""}
            onChange={(e) =>
              setAnswers((old) => ({ ...old, [q.id]: e.target.value }))
            }
          />
        </label>
      ))}
      {error && <p role="alert">{error}</p>}
      <Button
        disabled={busy || Date.now() >= Date.parse(request.expiresAt)}
        type="submit"
      >
        Submit answer
      </Button>
    </form>
  );
}
