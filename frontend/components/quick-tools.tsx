"use client";
import { useState } from "react";
import { api } from "@/lib/api";
import { Button } from "./ui/button";
export function QuickTools({
  sessionId,
  onFork,
}: {
  sessionId: string;
  onFork: (id: string) => void;
}) {
  const [goal, setGoal] = useState(""),
    [model, setModel] = useState(""),
    [effort, setEffort] = useState("medium"),
    [processId, setProcessId] = useState(""),
    [result, setResult] = useState(""),
    [busy, setBusy] = useState(false);
  async function run(method: string, params: unknown = {}) {
    setBusy(true);
    try {
      const result = await api(`/api/sessions/${sessionId}/capabilities`, {
        method,
        params,
      });
      setResult(JSON.stringify(result, null, 2));
      if (result.session) onFork(result.session._id);
    } catch (e) {
      setResult((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="quick-tools">
      <h3>Conversation tools</h3>
      <div className="actions">
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void run("thread/fork")}
        >
          Fork
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void run("thread/compact/start")}
        >
          Compact
        </Button>
      </div>
      <details>
        <summary>Goal</summary>
        <textarea
          aria-label="Thread goal"
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
            Read
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void run("thread/goal/clear")}
          >
            Clear
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
            placeholder="Model identifier"
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
          disabled={busy}
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
        <summary>Background terminals</summary>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void run("thread/backgroundTerminals/list")}
        >
          List terminals
        </Button>
        <input
          aria-label="Process identifier"
          placeholder="Process identifier to terminate"
          value={processId}
          onChange={(e) => setProcessId(e.target.value)}
        />
        <Button
          variant="outline"
          disabled={busy || !processId}
          onClick={() =>
            void run("thread/backgroundTerminals/terminate", { processId })
          }
        >
          Terminate
        </Button>
      </details>
      <details>
        <summary>Lifecycle</summary>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void run("thread/archive")}
        >
          Archive
        </Button>
        <p className="muted">
          Delete is available in the advanced console and removes runtime
          history.
        </p>
      </details>
      {result && <pre>{result}</pre>}
    </section>
  );
}
