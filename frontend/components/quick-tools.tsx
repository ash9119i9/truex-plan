"use client";
import { useState } from "react";
import { api } from "@/lib/api";
import { Button } from "./ui/button";
export function QuickTools({
  sessionId,
  onFork,
  disabled = false,
}: {
  sessionId: string;
  onFork: (id: string) => void;
  disabled?: boolean;
  refreshKey?: number;
}) {
  const [model, setModel] = useState(""),
    [effort, setEffort] = useState("medium"),
    [result, setResult] = useState(""),
    [busy, setBusy] = useState(false);
  async function run(method: string, params: unknown = {}) {
    setBusy(true);
    setResult("");
    try {
      const data = await api(`/api/sessions/${sessionId}/capabilities`, {
        method,
        params,
      });
      if (data.session) onFork(data.session._id);
      setResult("Done.");
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
