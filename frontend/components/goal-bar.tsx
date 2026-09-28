"use client";
import { useEffect, useId, useRef, useState } from "react";
import {
  Check,
  CircleCheck,
  Ellipsis,
  Gauge,
  Pause,
  Pencil,
  Play,
  RotateCcw,
  Target,
  X,
} from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "./ui/button";
import { BudgetField, type BudgetValue } from "./budget-field";
import {
  awaitingReview,
  budgetExtensions,
  budgetHelp,
  extendedBudget,
  formatDuration,
  formatTokens,
  goalTokens,
  goalAccepted,
  goalStateLabel,
  goalStatus,
} from "@/lib/goal";
import type { Goal, GoalReview } from "../../shared/contracts";
import type { ConversationFile } from "../../shared/assistant-capabilities";
import type { Entry } from "@/lib/chat";
import { GoalCompletion } from "./goal-completion";
import { GoalReason } from "./goal-reason";
import { goalFailure, type TurnFailure } from "@/lib/goal-errors";

type Panel = "edit" | "budget" | null;

// Pinned summary of the conversation's single goal. The assistant marks a goal
// complete; the user then accepts the result or reopens it with feedback.
export function GoalBar({
  sessionId,
  goal,
  review,
  onChange,
  onReopen,
  onProvideInput,
  onFollowUp,
  running,
  entries,
  documents,
  documentHref,
  failure,
  provider,
}: {
  sessionId: string;
  goal: Goal;
  review: GoalReview | null;
  onChange: (goal: Goal | null, review: GoalReview | null) => void;
  onReopen: (feedback: string) => void;
  onProvideInput: () => void;
  onFollowUp: () => void;
  running: boolean;
  entries: Entry[];
  documents: ConversationFile[];
  documentHref: (id: string) => string;
  failure: TurnFailure | null;
  provider?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reopening, setReopening] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [panel, setPanel] = useState<Panel>(null);
  const [draft, setDraft] = useState(goal.objective);
  const [budget, setBudget] = useState<BudgetValue>({
    tokens: goal.tokenBudget ?? null,
    valid: true,
  });
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(
    null,
  );
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const focusLast = useRef(false);
  const feedbackId = useId();
  const draftId = useId();
  const menuId = useId();
  const status = goalStatus[goal.status] || goalStatus.active;
  const accepted = goalAccepted(goal, review);
  const reviewing = awaitingReview(goal, review);
  // A completed goal is reviewed, not edited.
  const editable = goal.status !== "complete";
  const working = running && goal.status === "active";
  // Codex lets the current turn finish after a pause and starts no new one.
  const finishing = running && goal.status === "paused";
  // Codex's status stays as is; the reason explains an error stop.
  const stoppedBy = goalFailure(goal.status, failure);
  // Turns seen while this bar is mounted. After a reload the count restarts,
  // so it is only shown once it is at least two.
  const [turns, setTurns] = useState(0);
  const counted = useRef<number | null>(null);
  useEffect(() => {
    if (counted.current !== goal.createdAt) {
      counted.current = goal.createdAt;
      setTurns(working ? 1 : 0);
      return;
    }
    if (working) setTurns((n) => n + 1);
  }, [working, goal.createdAt]);
  const menuOpen = editable && menuPos !== null;
  // Codex enforces the budget with its own count, so the bar follows it. Our
  // total also includes usage Codex skips, and is shown alongside.
  const used = goal.tokenBudget
    ? Math.min(100, Math.round((goal.tokensUsed / goal.tokenBudget) * 100))
    : null;
  const total = goalTokens(goal);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const update = (params: Record<string, unknown>) =>
    api(`/api/sessions/${sessionId}/capabilities`, {
      method: "thread/goal/set",
      params,
    });
  const setStatus = (next: "active" | "paused") =>
    run(async () => {
      const data = await update({ status: next });
      onChange(data.goal, null);
    });
  // Raising the budget alone leaves a budget-limited goal stopped, so the same
  // update makes it active again.
  const extend = (extra: number) =>
    run(async () => {
      const data = await update({
        tokenBudget: extendedBudget(goal, extra),
        status: "active",
      });
      onChange(data.goal, null);
    });
  // Codex summarizes earlier turns; the goal can be resumed afterwards.
  const compact = () =>
    run(async () => {
      await api(`/api/sessions/${sessionId}/capabilities`, {
        method: "thread/compact/start",
        params: {},
      });
    });
  const clear = () => {
    if (!window.confirm("Clear this goal? Its progress will no longer be tracked."))
      return;
    void run(async () => {
      await api(`/api/sessions/${sessionId}/capabilities`, {
        method: "thread/goal/clear",
        params: {},
      });
      onChange(null, null);
    });
  };
  const submitReview = (decision: "accepted" | "reopened") =>
    run(async () => {
      const note = feedback.trim();
      const data = await api(`/api/sessions/${sessionId}/goal/review`, {
        decision,
        ...(note ? { feedback: note } : {}),
      });
      onChange(data.goal, decision === "accepted" ? data.review : null);
      if (decision === "reopened") {
        setReopening(false);
        setFeedback("");
        onReopen(note);
      }
    });
  // Codex edits the objective in place, so time and tokens carry over.
  const saveObjective = () =>
    run(async () => {
      const objective = draft.trim();
      if (!objective) throw new Error("Describe the goal before saving.");
      if (objective !== goal.objective) {
        const data = await update({ objective });
        onChange(data.goal, null);
      }
      closePanel();
    });
  const saveBudget = () =>
    run(async () => {
      if (!budget.valid) throw new Error(budgetHelp);
      const data = await update({ tokenBudget: budget.tokens });
      onChange(data.goal, review);
      closePanel();
    });
  // The user finishing the goal is itself the confirmation, so it is accepted.
  const markComplete = () => {
    if (
      !window.confirm(
        "Mark this goal complete? The assistant stops working on it and the result is accepted.",
      )
    )
      return;
    void run(async () => {
      const done = await update({ status: "complete" });
      onChange(done.goal, null);
      const data = await api(`/api/sessions/${sessionId}/goal/review`, {
        decision: "accepted",
      });
      onChange(data.goal, data.review);
    });
  };

  function closePanel() {
    setPanel(null);
    trigger.current?.focus();
  }
  function openMenu(last = false) {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    focusLast.current = last;
    // Fixed position escapes the goal bar's clipping.
    setMenuPos({
      top: rect.bottom + 4,
      right: Math.max(8, window.innerWidth - rect.right),
    });
  }
  function closeMenu(returnFocus = true) {
    setMenuPos(null);
    if (returnFocus) trigger.current?.focus();
  }
  function choose(action: () => void) {
    closeMenu();
    action();
  }
  useEffect(() => {
    if (!menuOpen) return;
    const items = menu.current?.querySelectorAll<HTMLButtonElement>(
      '[role="menuitem"]',
    );
    (focusLast.current ? items?.[items.length - 1] : items?.[0])?.focus();
    const outside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!menu.current?.contains(target) && !trigger.current?.contains(target))
        setMenuPos(null);
    };
    const dismiss = () => setMenuPos(null);
    document.addEventListener("mousedown", outside);
    window.addEventListener("resize", dismiss);
    return () => {
      document.removeEventListener("mousedown", outside);
      window.removeEventListener("resize", dismiss);
    };
  }, [menuOpen]);
  function onMenuKey(e: React.KeyboardEvent) {
    const items = [
      ...(menu.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]',
      ) ?? []),
    ];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const move = (next: number) => {
      e.preventDefault();
      items[(next + items.length) % items.length]?.focus();
    };
    if (e.key === "ArrowDown") move(index + 1);
    else if (e.key === "ArrowUp") move(index - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(items.length - 1);
    else if (e.key === "Escape") {
      e.preventDefault();
      closeMenu();
    } else if (e.key === "Tab") closeMenu(false);
  }
  const panelKeys = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closePanel();
    }
  };

  return (
    <section
      className="goal-bar"
      data-tone={accepted ? "good" : reviewing ? "review" : status.tone}
      aria-label="Conversation goal"
    >
      <div className="goal-row">
        <Target size={15} className="goal-icon" aria-hidden="true" />
        <div className="goal-text">
          <span className="goal-status" title={status.hint}>
            {goalStateLabel(goal, review)}
          </span>
          <p className="goal-objective" title={goal.objective}>
            {goal.objective}
          </p>
        </div>
        <span className="goal-meta">
          {formatDuration(goal.timeUsedSeconds)} ·{" "}
          {goal.tokenBudget ? (
            <span
              title={`${goal.tokensUsed.toLocaleString()} of ${goal.tokenBudget.toLocaleString()} budget tokens used; ${total.toLocaleString()} tokens in total`}
            >
              {formatTokens(goal.tokensUsed)} / {formatTokens(goal.tokenBudget)}{" "}
              budget
              {total > goal.tokensUsed && ` · ${formatTokens(total)} total`}
            </span>
          ) : (
            `${formatTokens(total)} tokens`
          )}
        </span>
        <div className="goal-actions">
          {goal.status === "active" && (
            <button
              type="button"
              className="icon-button"
              disabled={busy}
              onClick={() => void setStatus("paused")}
              aria-label={running ? "Pause after this turn" : "Pause goal"}
              title={running ? "Pause after this turn" : "Pause goal"}
            >
              <Pause size={14} />
            </button>
          )}
          {goal.status === "paused" && (
            <button
              type="button"
              className="icon-button"
              disabled={busy}
              onClick={() => void setStatus("active")}
              aria-label="Resume goal"
              title="Resume goal"
            >
              <Play size={14} />
            </button>
          )}
          {editable && (
            <button
              ref={trigger}
              type="button"
              className="icon-button"
              disabled={busy}
              aria-label="More goal actions"
              title="More goal actions"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-controls={menuOpen ? menuId : undefined}
              onClick={() => (menuOpen ? closeMenu(false) : openMenu())}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  openMenu(e.key === "ArrowUp");
                }
              }}
            >
              <Ellipsis size={14} />
            </button>
          )}
          <button
            type="button"
            className="icon-button"
            disabled={busy}
            onClick={clear}
            aria-label="Clear goal"
            title="Clear goal"
          >
            <X size={14} />
          </button>
          {menuOpen && (
            <div
              ref={menu}
              id={menuId}
              role="menu"
              aria-label="Goal actions"
              className="goal-menu"
              style={{ top: menuPos.top, right: menuPos.right }}
              onKeyDown={onMenuKey}
            >
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={() =>
                  choose(() => {
                    setDraft(goal.objective);
                    setPanel("edit");
                  })
                }
              >
                <Pencil size={14} aria-hidden="true" /> Edit objective
              </button>
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={() => choose(() => setPanel("budget"))}
              >
                <Gauge size={14} aria-hidden="true" /> Set budget
              </button>
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={() => choose(markComplete)}
              >
                <CircleCheck size={14} aria-hidden="true" /> Mark complete
              </button>
            </div>
          )}
        </div>
      </div>
      {used !== null && (
        <div
          className="goal-progress"
          role="progressbar"
          aria-label="Token budget used"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={used}
        >
          <i style={{ width: `${used}%` }} />
        </div>
      )}
      {(working || finishing) && (
        <div className="goal-run">
          <span className="thinking-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span role="status">
            {working
              ? `Working on the goal${turns >= 2 ? ` · turn ${turns}` : ""}. Stop pauses it now.`
              : "Pausing after this turn. The assistant finishes its current step, then stops."}
          </span>
          {working && (
            <button
              type="button"
              className="goal-run-action"
              disabled={busy}
              onClick={() => void setStatus("paused")}
            >
              Pause after this turn
            </button>
          )}
          {finishing && (
            <button
              type="button"
              className="goal-run-action"
              disabled={busy}
              onClick={() => void setStatus("active")}
            >
              Keep going
            </button>
          )}
        </div>
      )}
      {accepted && (
        <div className="goal-stuck-actions">
          <Button type="button" variant="outline" onClick={onFollowUp}>
            <Target size={14} /> Start a follow-up goal
          </Button>
        </div>
      )}
      {!accepted && status.tone === "warn" && (
        <>
          <p className="goal-hint">{status.hint}</p>
          {stoppedBy && <GoalReason failure={stoppedBy} provider={provider} />}
          <div className="goal-stuck-actions">
            {stoppedBy?.reason === "contextWindow" && (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => void compact()}
              >
                Compact conversation
              </Button>
            )}
            {goal.status === "budgetLimited" &&
              budgetExtensions.map((extra) => (
                <Button
                  key={extra}
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void extend(extra)}
                >
                  Extend by {formatTokens(extra)}
                </Button>
              ))}
            {goal.status === "blocked" && (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={onProvideInput}
              >
                Provide input
              </Button>
            )}
            {(goal.status === "blocked" || goal.status === "usageLimited") && (
              <Button
                type="button"
                disabled={busy}
                onClick={() => void setStatus("active")}
              >
                <Play size={14} /> Resume goal
              </Button>
            )}
          </div>
        </>
      )}
      {editable && panel === "edit" && (
        <form
          className="goal-panel"
          onKeyDown={panelKeys}
          onSubmit={(e) => {
            e.preventDefault();
            void saveObjective();
          }}
        >
          <label htmlFor={draftId}>Objective</label>
          <textarea
            id={draftId}
            rows={3}
            maxLength={4000}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoFocus
          />
          <p className="goal-panel-note">
            Time and tokens so far carry over. If the assistant is working, it
            picks up the change.
          </p>
          <div className="goal-review-actions">
            <Button type="button" variant="ghost" onClick={closePanel}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !draft.trim()}>
              Save objective
            </Button>
          </div>
        </form>
      )}
      {editable && panel === "budget" && (
        <form
          className="goal-panel"
          onKeyDown={panelKeys}
          onSubmit={(e) => {
            e.preventDefault();
            void saveBudget();
          }}
        >
          <BudgetField
            initial={goal.tokenBudget ?? null}
            onChange={setBudget}
            autoFocus
          />
          <p className="goal-panel-note">
            Counted toward the budget so far: {formatTokens(goal.tokensUsed)}{" "}
            tokens ({formatTokens(total)} in total). The assistant stops when
            it reaches the budget.
          </p>
          <div className="goal-review-actions">
            <Button type="button" variant="ghost" onClick={closePanel}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !budget.valid}>
              Save budget
            </Button>
          </div>
        </form>
      )}
      {reviewing && (
        <div className="goal-review" aria-live="polite">
          <p>
            The assistant marked this goal complete after{" "}
            {formatDuration(goal.timeUsedSeconds)} and{" "}
            {formatTokens(goalTokens(goal))} tokens. Does the result meet your
            goal?
          </p>
          <GoalCompletion
            goal={goal}
            entries={entries}
            documents={documents}
            href={documentHref}
          />
          {reopening ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void submitReview("reopened");
              }}
            >
              <label className="visually-hidden" htmlFor={feedbackId}>
                What still needs work?
              </label>
              <textarea
                id={feedbackId}
                rows={2}
                maxLength={4000}
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                placeholder="What still needs work? (optional)"
                autoFocus
              />
              <div className="goal-review-actions">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setReopening(false)}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={busy}>
                  <RotateCcw size={14} /> Reopen goal
                </Button>
              </div>
            </form>
          ) : (
            <div className="goal-review-actions">
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setReopening(true)}
              >
                Not yet
              </Button>
              <Button
                type="button"
                disabled={busy}
                onClick={() => void submitReview("accepted")}
              >
                <Check size={14} /> Accept result
              </Button>
            </div>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="goal-error">
          {error}
        </p>
      )}
    </section>
  );
}
