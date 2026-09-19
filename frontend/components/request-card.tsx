"use client";
import { useEffect, useState } from "react";
import type { PendingRequest } from "../../shared/contracts";
import { Button } from "./ui/button";
export function RequestCard({
  request,
  onAnswer,
}: {
  request: PendingRequest;
  onAnswer: (value: unknown) => Promise<void>;
}) {
  const [remaining, setRemaining] = useState(0),
    [json, setJson] = useState("{}"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    const tick = () =>
      setRemaining(
        Math.max(
          0,
          Math.ceil((Date.parse(request.expiresAt) - Date.now()) / 1000),
        ),
      );
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [request.expiresAt]);
  const command =
    request.method === "item/commandExecution/requestApproval" ||
    request.method === "item/fileChange/requestApproval";
  const legacy =
    request.method === "execCommandApproval" ||
    request.method === "applyPatchApproval";
  const respond = async (value: unknown) => {
    setBusy(true);
    setError("");
    try {
      await onAnswer(value);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="request-card">
      <div className="eyebrow">
        Your input is needed ·{" "}
        {remaining
          ? `${remaining}s remaining`
          : "Waiting for server resolution"}
      </div>
      <h3>{request.method.split("/").slice(-2).join(" / ")}</h3>
      <pre>{JSON.stringify(request.detail, null, 2)}</pre>
      {command || legacy ? (
        <div className="actions">
          <Button
            disabled={busy || !remaining}
            onClick={() =>
              void respond({ decision: legacy ? "approved" : "accept" })
            }
          >
            Approve
          </Button>
          <Button
            variant="outline"
            disabled={busy || !remaining}
            onClick={() =>
              void respond({
                decision: legacy
                  ? { denied: { rejection: "Denied by user" } }
                  : "decline",
              })
            }
          >
            Deny
          </Button>
        </div>
      ) : (
        <>
          <label>
            Response for {request.responseSchema}
            <textarea
              aria-label="Runtime request response"
              value={json}
              onChange={(e) => setJson(e.target.value)}
            />
          </label>
          <Button
            disabled={busy || !remaining}
            onClick={() => {
              try {
                void respond(JSON.parse(json));
              } catch {
                setError("Enter valid JSON");
              }
            }}
          >
            Submit response
          </Button>
        </>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
