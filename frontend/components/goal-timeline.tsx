"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import {
  formatDuration,
  formatTokens,
  goalStateLabel,
  goalTokens,
  historyLabel,
  tokenChange,
} from "@/lib/goal";
import type {
  Goal,
  GoalHistoryEntry,
  GoalReview,
} from "../../shared/contracts";

// The conversation's goal and how it changed over time, newest first.
export function GoalTimeline({
  sessionId,
  goal,
  review,
}: {
  sessionId?: string;
  goal: Goal | null;
  review: GoalReview | null;
}) {
  const [entries, setEntries] = useState<GoalHistoryEntry[]>([]);
  const [failed, setFailed] = useState(false);
  // The turn whose chat anchor couldn't be found.
  const [missing, setMissing] = useState<string | null>(null);
  function viewTurn(turnId: string) {
    const target = document.getElementById(`turn-${turnId}`);
    if (!target) {
      setMissing(turnId);
      return;
    }
    setMissing(null);
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "start" });
    target.focus({ preventScroll: true });
  }
  // Token updates arrive often; only a real change reloads the history.
  const key = goal
    ? `${goal.createdAt}:${goal.objective}:${goal.status}:${goal.tokenBudget}`
    : "none";
  const reviewKey = review ? `${review.decision}:${review.at}` : "";
  useEffect(() => {
    if (!sessionId) {
      setEntries([]);
      return;
    }
    let active = true;
    // The platform saves the change just after the live event, so wait briefly.
    const timer = setTimeout(() => {
      api(`/api/sessions/${sessionId}/goal/history`)
        .then((data) => {
          if (!active) return;
          setEntries(data.entries || []);
          setFailed(false);
        })
        .catch(() => active && setFailed(true));
    }, 400);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [sessionId, key, reviewKey]);

  return (
    <div className="goal-timeline">
      <h3>Goal</h3>
      {goal ? (
        <dl className="goal-summary">
          <div>
            <dt>Objective</dt>
            <dd>{goal.objective}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>{goalStateLabel(goal, review)}</dd>
          </div>
          <div>
            <dt>Time spent</dt>
            <dd>{formatDuration(goal.timeUsedSeconds)}</dd>
          </div>
          <div>
            <dt>Tokens</dt>
            <dd>
              {formatTokens(goalTokens(goal))}
              {goal.tokenBudget
                ? ` · ${formatTokens(goal.tokensUsed)} of ${formatTokens(goal.tokenBudget)} budget`
                : ""}
            </dd>
          </div>
        </dl>
      ) : (
        <p className="muted">
          No goal is set. Use the Goal button in the composer to start one.
        </p>
      )}
      <h3>History</h3>
      {failed && <p className="muted">Goal history couldn’t be loaded.</p>}
      {!failed && !entries.length && (
        <p className="muted">Goal changes will appear here.</p>
      )}
      {!!entries.length && (
        <ol className="goal-history">
          {entries
            .map((entry, index) => ({ entry, change: tokenChange(entries, index) }))
            .reverse()
            .map(({ entry, change }, i) => (
            <li key={`${entry.at}:${i}`} data-kind={entry.kind}>
              <span className="goal-history-label">{historyLabel(entry)}</span>
              {entry.kind !== "cleared" && (
                <span className="goal-history-objective">{entry.objective}</span>
              )}
              {entry.feedback && (
                <q className="goal-history-feedback">{entry.feedback}</q>
              )}
              <span className="goal-history-meta">
                <time dateTime={entry.at}>
                  {new Date(entry.at).toLocaleString([], {
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </time>
                {entry.tokens ? ` · ${formatTokens(entry.tokens)} tokens` : ""}
                {change ? ` · +${formatTokens(change)} since the last change` : ""}
              </span>
              {entry.turnId && (
                <button
                  type="button"
                  className="goal-history-turn"
                  onClick={() => viewTurn(entry.turnId!)}
                >
                  View turn
                </button>
              )}
              {entry.turnId && missing === entry.turnId && (
                <span className="goal-history-note" role="status">
                  This turn isn’t loaded in the chat.
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
