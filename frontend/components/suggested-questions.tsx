"use client";
import { AnimatedLink } from "./animated-link";

// Follow-up questions under the latest answer; choosing one sends it.
export function SuggestedQuestions({
  questions,
  onSelect,
  disabled,
}: {
  questions: string[];
  onSelect: (question: string) => void;
  disabled?: boolean;
}) {
  return (
    <nav className="suggested-questions" aria-label="Suggested follow-ups">
      <ul>
        {questions.map((question) => (
          <li key={question}>
            <AnimatedLink
              className="suggested-question"
              disabled={disabled}
              aria-label={`Ask: ${question}`}
              onClick={() => onSelect(question)}
            >
              {question}
            </AnimatedLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
