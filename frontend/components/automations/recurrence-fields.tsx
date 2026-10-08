import type { AutomationFields } from "@/lib/automations";

export function AutomationRecurrenceFields({
  id,
  fields,
  change,
}: {
  id: string;
  fields: AutomationFields;
  change: <K extends keyof AutomationFields>(
    key: K,
    value: AutomationFields[K],
  ) => void;
}) {
  const fieldId = (field: string) => `${id}-${field}`;
  return (
    <>
      <fieldset>
        <legend>Recurrence</legend>
        <div className="automation-actions">
          {(["interval", "calendar"] as const).map((kind) => (
            <label className="automation-choice" key={kind}>
              <input
                type="radio"
                name={`${id}-recurrence`}
                checked={fields.triggerKind === kind}
                onChange={() => change("triggerKind", kind)}
              />
              {kind === "interval"
                ? "Fixed interval"
                : "Weekdays and local time"}
            </label>
          ))}
        </div>
      </fieldset>
      {fields.triggerKind === "interval" ? (
        <>
          <div className="automation-grid">
            <label htmlFor={fieldId("interval")}>
              Every
              <input
                id={fieldId("interval")}
                type="number"
                min="1"
                step="any"
                value={fields.intervalAmount}
                required
                onChange={(e) => change("intervalAmount", e.target.value)}
              />
            </label>
            <label htmlFor={fieldId("unit")}>
              Interval unit
              <select
                id={fieldId("unit")}
                value={fields.intervalUnit}
                onChange={(e) =>
                  change(
                    "intervalUnit",
                    e.target.value as AutomationFields["intervalUnit"],
                  )
                }
              >
                <option value="minutes">Minutes</option>
                <option value="hours">Hours</option>
                <option value="days">Days</option>
              </select>
            </label>
          </div>
          <label htmlFor={fieldId("anchor")}>
            Start anchor (UTC)
            <input
              id={fieldId("anchor")}
              type="datetime-local"
              step="1"
              value={fields.anchorAt}
              required
              onChange={(e) => change("anchorAt", e.target.value)}
            />
            <span className="automation-muted">
              A fixed cadence from this UTC instant. Run now preserves this
              anchor.
            </span>
          </label>
        </>
      ) : (
        <>
          <fieldset>
            <legend>Weekdays</legend>
            <div className="automation-weekdays">
              {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(
                (day, index) => (
                  <label className="automation-choice" key={day}>
                    <input
                      type="checkbox"
                      checked={fields.weekdays.includes(index)}
                      onChange={(e) =>
                        change(
                          "weekdays",
                          e.target.checked
                            ? [...fields.weekdays, index]
                            : fields.weekdays.filter((d) => d !== index),
                        )
                      }
                    />
                    {day}
                  </label>
                ),
              )}
            </div>
          </fieldset>
          <label htmlFor={fieldId("time")}>
            Local execution time
            <input
              id={fieldId("time")}
              type="time"
              value={fields.localTime}
              required
              onChange={(e) => change("localTime", e.target.value)}
            />
          </label>
        </>
      )}
      <label htmlFor={fieldId("zone")}>
        IANA timezone
        <input
          id={fieldId("zone")}
          value={fields.timeZone}
          required
          list={`${id}-zones`}
          onChange={(e) => change("timeZone", e.target.value)}
          placeholder="Asia/Kolkata"
        />
        <datalist id={`${id}-zones`}>
          {[
            "UTC",
            "Asia/Kolkata",
            "Europe/London",
            "America/New_York",
            "America/Los_Angeles",
            "Asia/Singapore",
            "Australia/Sydney",
          ].map((zone) => (
            <option key={zone} value={zone} />
          ))}
        </datalist>
      </label>
    </>
  );
}
