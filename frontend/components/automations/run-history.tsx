"use client";
import { useEffect, useState } from "react";
import {
  automationExportHref,
  formatAutomationTime,
  listAutomationRuns,
  runOutcomeLabel,
  type AutomationHistoryFilters,
  type AutomationRunView,
} from "@/lib/automations";
import { userMessage } from "@/lib/api";

export function AutomationRunHistory({
  automationId,
  timeZone,
  refresh,
  onOpen,
}: {
  automationId: string;
  timeZone: string;
  refresh: number;
  onOpen: (runId: string) => void;
}) {
  const [status, setStatus] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [filters, setFilters] = useState<AutomationHistoryFilters>({});
  const [runs, setRuns] = useState<AutomationRunView[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [before, setBefore] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError("");
    void listAutomationRuns(automationId, { ...filters, before, limit: 25 })
      .then((result) => {
        if (!live) return;
        setRuns(result.items);
        setCursor(result.nextCursor);
      })
      .catch((e) => {
        if (live) setError(userMessage(e));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [automationId, filters, before, refresh]);
  return (
    <section
      className="automation-panel"
      aria-labelledby="automation-history-title"
    >
      <div className="automation-heading">
        <h2 id="automation-history-title">Run history</h2>
        <a
          className="automation-button"
          href={automationExportHref(automationId, filters)}
          download
        >
          Export metadata CSV
        </a>
      </div>
      <form
        className="automation-filters"
        onSubmit={(e) => {
          e.preventDefault();
          setBefore(undefined);
          setFilters({
            status,
            ...(from ? { from: `${from}T00:00:00.000Z` } : {}),
            ...(to ? { to: `${to}T23:59:59.999Z` } : {}),
          });
        }}
      >
        <label>
          Outcome
          <select
            aria-label="Outcome"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">All outcomes</option>
            {[
              "succeeded",
              "failed",
              "skipped",
              "cancelled",
              "unknown",
              "running",
              "accepted",
              "preparing",
              "cancellation_requested",
            ].map((state) => (
              <option key={state} value={state}>
                {state.replaceAll("_", " ")}
              </option>
            ))}
          </select>
        </label>
        <label>
          From date (UTC)
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label>
          Through date (UTC)
          <input
            type="date"
            value={to}
            min={from || undefined}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
        <button className="automation-button" type="submit" disabled={loading}>
          Apply filters
        </button>
      </form>
      {error ? (
        <p role="alert" className="automation-error">
          {error}
        </p>
      ) : loading ? (
        <p role="status">Loading run history…</p>
      ) : runs.length === 0 ? (
        <p className="automation-muted">No runs match these filters.</p>
      ) : (
        <ul className="automation-run-list">
          {runs.map((run) => (
            <li key={run.id}>
              <button
                className="automation-run-row"
                onClick={() => onOpen(run.id)}
              >
                <span>
                  <strong>{runOutcomeLabel(run)}</strong>
                  {run.unread && (
                    <span className="automation-attention">Unread</span>
                  )}
                  <small>
                    {run.source === "scheduled" ? "Scheduled" : "Run now"} ·
                    revision {run.revision}
                    {run.retryOfRunId ? " · linked retry" : ""}
                  </small>
                </span>
                <span>
                  {formatAutomationTime(
                    run.scheduledAt ?? run.acceptedAt,
                    timeZone,
                  )}
                  {!run.auditComplete && <small>Audit incomplete</small>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="automation-actions">
        {before && (
          <button
            className="automation-button"
            onClick={() => setBefore(undefined)}
            disabled={loading}
          >
            Newest runs
          </button>
        )}
        {cursor && (
          <button
            className="automation-button"
            onClick={() => setBefore(cursor)}
            disabled={loading}
          >
            Older runs
          </button>
        )}
      </div>
    </section>
  );
}
