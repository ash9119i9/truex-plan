"use client";
import { useEffect, useRef, useState } from "react";
import { api, warnFailure } from "@/lib/api";
import {
  formatDuration,
  formatTokens,
  goalAccepted,
  goalStateLabel,
  goalTokens,
  historyLabel,
  tokenChange,
} from "@/lib/goal";
import { planProgress, stepStatus, type PlanStep } from "@/lib/plan";
import { Icon, type IconName } from "./v2/icon";
import { StepMark } from "./plan-steps";
import type {
  Goal,
  GoalHistoryEntry,
  GoalReview,
  GoalStatus,
} from "../../shared/contracts";

// Spec pill tones: running pulses, paused/blocked warn, done accent, ended muted.
const pillTone: Record<
  GoalStatus,
  "s-running" | "s-paused" | "s-done" | "s-ended"
> = {
  active: "s-running",
  paused: "s-paused",
  blocked: "s-paused",
  usageLimited: "s-paused",
  budgetLimited: "s-paused",
  complete: "s-done",
};

const historyIcon: Partial<Record<GoalHistoryEntry["kind"], IconName>> = {
  set: "target",
  objective: "pencil",
  budget: "gear",
  status: "pulse",
  accepted: "check",
  reopened: "play",
  cleared: "x",
};

// Codex reports goal times in Unix seconds; accept milliseconds too.
function startedLabel(value: number | null) {
  if (!value || !Number.isFinite(value)) return "";
  const ms = value > 1e12 ? value : value * 1000;
  return new Date(ms).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

// The conversation's goal, its checkpoints (the plan's steps) and how it
// changed over time, newest first.
export function GoalTimeline({
  sessionId,
  goal,
  review,
  plan = [],
  onViewTurn,
}: {
  sessionId?: string;
  goal: Goal | null;
  review: GoalReview | null;
  plan?: PlanStep[];
  onViewTurn?: (turnId: string) => Promise<boolean>;
}) {
  const [historyState, setHistoryState] = useState<{
    sessionId?: string;
    entries: GoalHistoryEntry[];
    failed: boolean;
  }>({ entries: [], failed: false });
  const entries =
    historyState.sessionId === sessionId ? historyState.entries : [];
  const failed = historyState.sessionId === sessionId && historyState.failed;
  const currentSession = useRef(sessionId);
  currentSession.current = sessionId;
  const viewRequest = useRef(0);
  // The turn whose chat anchor couldn't be found.
  const [missing, setMissing] = useState<string | null>(null);
  useEffect(() => {
    setMissing(null);
    return () => {
      viewRequest.current++;
    };
  }, [sessionId]);
  async function viewTurn(turnId: string) {
    if (onViewTurn) {
      const request = ++viewRequest.current;
      let found = false;
      try {
        found = await onViewTurn(turnId);
      } catch (error) {
        warnFailure("view goal turn", error);
      }
      if (
        request === viewRequest.current &&
        currentSession.current === sessionId
      )
        setMissing(found ? null : turnId);
      return;
    }
    const target = document.getElementById(`turn-${turnId}`);
    if (!target) {
      setMissing(turnId);
      return;
    }
    setMissing(null);
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({
      behavior: still ? "auto" : "smooth",
      block: "start",
    });
    target.focus({ preventScroll: true });
  }
  // Token updates arrive often; only a real change reloads the history.
  const key = goal
    ? `${goal.createdAt}:${goal.objective}:${goal.status}:${goal.tokenBudget}`
    : "none";
  const reviewKey = review ? `${review.decision}:${review.at}` : "";
  useEffect(() => {
    if (!sessionId) {
      setHistoryState({ entries: [], failed: false });
      return;
    }
    let active = true;
    // The platform saves the change just after the live event, so wait briefly.
    const timer = setTimeout(() => {
      api(`/api/sessions/${sessionId}/goal/history`)
        .then((data) => {
          if (!active) return;
          setHistoryState({
            sessionId,
            entries: data.entries || [],
            failed: false,
          });
        })
        .catch((e) => {
          warnFailure("goal history", e);
          if (active)
            setHistoryState((old) => ({
              sessionId,
              entries: old.sessionId === sessionId ? old.entries : [],
              failed: true,
            }));
        });
    }, 400);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [sessionId, key, reviewKey]);

  const history = (
    <>
      <div className="section-head">
        <span className="eyebrow">History</span>
      </div>
      {failed && <p className="tl-empty">Goal history couldn’t be loaded.</p>}
      {!failed && !entries.length && (
        <p className="tl-empty">Goal changes will appear here.</p>
      )}
      {!!entries.length && (
        <ol className="timeline" aria-label="Goal history">
          {entries
            .map((entry, index) => ({
              entry,
              change: tokenChange(entries, index),
            }))
            .reverse()
            .map(({ entry, change }, i) => (
              <li
                key={`${entry.at}:${i}`}
                className="tl-row"
                data-kind={entry.kind}
              >
                <span className="tl-dot">
                  <Icon name={historyIcon[entry.kind] || "pulse"} size={14} />
                </span>
                <div className="tl-body">
                  <span className="tl-title">{historyLabel(entry)}</span>
                  {entry.kind !== "cleared" && (
                    <span className="tl-meta">{entry.objective}</span>
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
                    {entry.tokens
                      ? ` · ${formatTokens(entry.tokens)} tokens`
                      : ""}
                    {change
                      ? ` · +${formatTokens(change)} since the last change`
                      : ""}
                  </span>
                  {entry.turnId && (
                    <button
                      type="button"
                      className="link goal-history-turn"
                      onClick={() => viewTurn(entry.turnId!)}
                    >
                      View turn
                    </button>
                  )}
                  {entry.turnId && missing === entry.turnId && (
                    <span className="goal-note" role="status">
                      This turn isn’t loaded in the chat.
                    </span>
                  )}
                </div>
              </li>
            ))}
        </ol>
      )}
    </>
  );

  if (!goal)
    return (
      <>
        <div className="empty-tab">
          <span className="tile lg">
            <Icon name="target" size={20} />
          </span>
          <span className="strong">No active goal</span>
          <span className="muted sm">
            Give the assistant an outcome. It keeps working until it&apos;s
            done, paused or out of budget.
          </span>
        </div>
        {!!entries.length && history}
      </>
    );

  const running = goal.status === "active";
  const done = goal.status === "complete";
  const progress = planProgress(plan);
  // The plan's steps stand in for the goal's checkpoints.
  const pct = done
    ? 100
    : progress.total
      ? Math.round((progress.done / progress.total) * 100)
      : 0;
  const tokens = goalTokens(goal);
  const tone = goalAccepted(goal, review)
    ? "s-done"
    : pillTone[goal.status] || "s-ended";
  const started = startedLabel(goal.createdAt);

  return (
    <div className="goal-view">
      <div className="goal-head">
        <span className={`goal-status ${tone}`}>
          <span className="pulse" aria-hidden="true" />
          {goalStateLabel(goal, review)}
        </span>
        {started && <span className="mono sm muted">Started {started}</span>}
      </div>
      <h3 className="goal-title">{goal.objective}</h3>
      <div className="goal-progress">
        <div
          className="bar"
          role="progressbar"
          aria-label="Goal progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
        >
          <span style={{ width: `${pct}%` }} />
        </div>
        <span className="mono sm muted">{pct}%</span>
      </div>
      <dl className="goal-meta">
        <div>
          <dt>Budget</dt>
          <dd>
            {goal.tokenBudget
              ? `${formatTokens(goal.tokenBudget)} cap`
              : "No budget"}
          </dd>
        </div>
        <div>
          <dt>Used</dt>
          <dd title={`${formatDuration(goal.timeUsedSeconds)} spent`}>
            {formatTokens(tokens)}
            {goal.tokenBudget ? (
              <span className="muted"> / {formatTokens(goal.tokenBudget)}</span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>Checkpoints</dt>
          <dd>{progress.total ? `${progress.done}/${progress.total}` : "—"}</dd>
        </div>
      </dl>
      {plan.length > 0 && (
        <>
          <div className="section-head">
            <span className="eyebrow">Checkpoints</span>
          </div>
          <ol className="checkpoints">
            {plan.map((p, i) => {
              const isDone = stepStatus(p.status) === "completed";
              const isCurrent = running && !isDone && i === progress.current;
              return (
                <li
                  key={i}
                  className={isDone ? "is-done" : isCurrent ? "is-current" : ""}
                  aria-current={isCurrent ? "step" : undefined}
                >
                  <StepMark
                    state={isDone ? "done" : isCurrent ? "current" : "pending"}
                  />
                  <span>{p.step}</span>
                </li>
              );
            })}
          </ol>
        </>
      )}
      {history}
    </div>
  );
}
