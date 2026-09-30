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
  // Model settings live in the agent popover (wireframe r2 §2), not here.
  const [result, setResult] = useState(""),
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
