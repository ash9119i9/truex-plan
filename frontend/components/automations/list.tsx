import {
  formatAutomationTime,
  automationAttentionCount,
  runOutcomeLabel,
  triggerLabel,
  type AutomationView,
} from "@/lib/automations";

export function AutomationList({
  items,
  selectedId,
  loading,
  onSelect,
}: {
  items: AutomationView[];
  selectedId: string | null;
  loading: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <section className="automation-list" aria-label="Saved automations">
      {loading ? (
        <p role="status">Loading automations…</p>
      ) : items.length === 0 ? (
        <div className="automation-empty">
          <h2>No automations yet</h2>
          <p>Choose an agent and a recurring task to get started.</p>
        </div>
      ) : (
        <ul>
          {items.map((item) => (
            <li key={item.id}>
              <button
                className={`automation-list-row${selectedId === item.id ? " selected" : ""}`}
                aria-pressed={selectedId === item.id}
                onClick={() => onSelect(item.id)}
              >
                <span className="automation-heading">
                  <strong>{item.recipe.name}</strong>
                  <span className={`automation-state ${item.status}`}>
                    {item.status}
                  </span>
                </span>
                <small>{triggerLabel(item.recipe.trigger)}</small>
                <small>
                  Next:{" "}
                  {item.status === "enabled"
                    ? formatAutomationTime(
                        item.nextScheduledAt,
                        item.recipe.trigger.timeZone,
                      )
                    : "—"}
                </small>
                <small>
                  {item.syncState === "synced"
                    ? "Schedule synchronized"
                    : item.syncState === "error"
                      ? "Schedule synchronization needs attention"
                      : "Synchronizing schedule…"}
                </small>
                {item.latestRun && (
                  <span className="automation-latest">
                    {runOutcomeLabel(item.latestRun)}
                  </span>
                )}
                {automationAttentionCount(item) > 0 && (
                  <span className="automation-attention">
                    {automationAttentionCount(item)} need attention
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
