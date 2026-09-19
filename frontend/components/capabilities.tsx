"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { QuickTools } from "./quick-tools";
import { Button } from "./ui/button";
export function Capabilities({
  sessionId,
  onFork,
}: {
  sessionId: string;
  onFork: (id: string) => void;
}) {
  const [methods, setMethods] = useState<any[]>([]),
    [method, setMethod] = useState("thread/goal/get"),
    [params, setParams] = useState("{}"),
    [result, setResult] = useState(""),
    [schema, setSchema] = useState<any>(null),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    api("/api/capabilities")
      .then((x) => setMethods(x.requests))
      .catch((e) => setResult(e.message));
  }, []);
  useEffect(() => {
    const entry = methods.find((x) => x.method === method);
    if (entry?.params === "undefined") {
      setSchema({ description: "No parameters" });
      setParams("{}");
      return;
    }
    if (entry)
      api("/api/schemas/" + entry.params)
        .then(setSchema)
        .catch((e) => setResult(e.message));
  }, [method, methods]);
  async function run() {
    setBusy(true);
    try {
      const data = await api(`/api/sessions/${sessionId}/capabilities`, {
        method,
        params: JSON.parse(params),
      });
      setResult(JSON.stringify(data, null, 2));
      if (data.session) onFork(data.session._id);
    } catch (e) {
      setResult((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="capabilities">
      <QuickTools sessionId={sessionId} onFork={onFork} />
      <h3>Advanced capabilities</h3>
      <p className="muted">
        Explore the pinned runtime’s capabilities. Thread identity is supplied
        by the session.
      </p>
      <label>
        Operation
        <select value={method} onChange={(e) => setMethod(e.target.value)}>
          {methods
            .filter(
              (x) =>
                ![
                  "initialize",
                  "thread/start",
                  "thread/resume",
                  "turn/start",
                  "turn/steer",
                  "turn/interrupt",
                ].includes(x.method),
            )
            .map((x) => (
              <option key={x.method}>{x.method}</option>
            ))}
        </select>
      </label>
      <label>
        Parameters
        <textarea
          value={params}
          onChange={(e) => setParams(e.target.value)}
          aria-label="Capability parameters"
        />
      </label>
      <Button disabled={busy || !sessionId} onClick={() => void run()}>
        {busy ? "Running…" : "Run operation"}
      </Button>
      <details>
        <summary>Parameter schema</summary>
        <pre>{JSON.stringify(schema, null, 2)}</pre>
      </details>
      {result && <pre>{result}</pre>}
    </section>
  );
}
