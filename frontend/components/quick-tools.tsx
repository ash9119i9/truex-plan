"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Button } from "./ui/button";
export function QuickTools({
  sessionId,
  onFork,
  disabled = false,
  refreshKey = 0,
}: {
  sessionId: string;
  onFork: (id: string) => void;
  disabled?: boolean;
  refreshKey?: number;
}) {
  const [goal, setGoal] = useState(""),
    [model, setModel] = useState(""),
    [effort, setEffort] = useState("medium"),
    [result, setResult] = useState(""),
    [busy, setBusy] = useState(false);
  const [currentGoal, setCurrentGoal] = useState<{
    objective: string;
    status: string;
    tokensUsed: number;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    api(`/api/sessions/${sessionId}/capabilities`, {
      method: "thread/goal/get",
      params: {},
    })
      .then((data) => {
        if (!cancelled) setCurrentGoal(data.goal);
      })
      .catch((error) => {
        if (!cancelled) setResult(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, refreshKey]);
  async function run(method: string, params: unknown = {}) {
    setBusy(true);
    setResult("");
    try {
      const data = await api(`/api/sessions/${sessionId}/capabilities`, {
        method,
        params,
      });
      if (data.session) onFork(data.session._id);
      if (method.startsWith("thread/goal/")) setCurrentGoal(data.goal || null);
      setResult(
        data.goal
          ? `${data.goal.objective} · ${data.goal.status} · ${data.goal.tokensUsed} tokens used`
          : method === "thread/goal/get"
            ? "No goal is set."
            : "Done.",
      );
    } catch (e) {
      setResult((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <fieldset className="quick-tools" disabled={busy}>
      <h3>Conversation tools</h3>
      <div className="actions">
        <Button
          variant="outline"
          disabled={busy || disabled}
          onClick={() => void run("thread/fork")}
        >
          Fork conversation
        </Button>
        <Button
          variant="outline"
          disabled={busy || disabled}
          onClick={() => void run("thread/compact/start")}
        >
          Compact context
        </Button>
      </div>
      <details>
        <summary>Goal</summary>
        {currentGoal && (
          <p role="status">
            <strong>{currentGoal.objective}</strong>
            <br />
            {currentGoal.status} · {currentGoal.tokensUsed} tokens used
          </p>
        )}
        <textarea
          aria-label="Conversation goal"
          placeholder="What should this conversation achieve?"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
        />
        <div className="actions">
          <Button
            disabled={busy || !goal.trim()}
            onClick={() => void run("thread/goal/set", { objective: goal })}
          >
            Set goal
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void run("thread/goal/get")}
          >
            Read goal
          </Button>
          {currentGoal && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run("thread/goal/set", {
                  status: currentGoal.status === "active" ? "paused" : "active",
                })
              }
            >
              {currentGoal.status === "active" ? "Pause goal" : "Resume goal"}
            </Button>
          )}
          {currentGoal && currentGoal.status !== "complete" && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run("thread/goal/set", { status: "complete" })
              }
            >
              Mark complete
            </Button>
          )}
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void run("thread/goal/clear")}
          >
            Clear goal
          </Button>
        </div>
      </details>
      <details>
        <summary>Model settings</summary>
        <label>
          Model
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="Model identifier (optional)"
          />
        </label>
        <label>
          Reasoning effort
          <select value={effort} onChange={(e) => setEffort(e.target.value)}>
            {["none", "minimal", "low", "medium", "high", "xhigh", "ultra"].map(
              (e) => (
                <option key={e}>{e}</option>
              ),
            )}
          </select>
        </label>
        <Button
          disabled={busy || disabled}
          onClick={() =>
            void run("thread/settings/update", {
              ...(model ? { model } : {}),
              effort,
            })
          }
        >
          Apply settings
        </Button>
      </details>
      <details>
        <summary>Conversation lifecycle</summary>
        <Button
          variant="outline"
          disabled={busy || disabled}
          onClick={() => void run("thread/archive")}
        >
          Archive conversation
        </Button>
      </details>
      {result && <p role="status">{result}</p>}
    </fieldset>
  );
}
