import type { Run } from "./store";
function cell(value: unknown) {
  let text = value === undefined ? "" : String(value);
  // Prevent spreadsheet formulas when authorized metadata is opened in Excel.
  if (/^[=+@\-\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
export function automationRunsCsv(runs: Run[]) {
  const fields = [
    "id",
    "automationId",
    "revision",
    "source",
    "scheduledAt",
    "acceptedAt",
    "startedAt",
    "completedAt",
    "status",
    "reason",
    "stopState",
    "auditComplete",
    "retryOfRunId",
  ] as const;
  return (
    [
      fields.map(cell).join(","),
      ...runs.map((run) => fields.map((field) => cell(run[field])).join(",")),
    ].join("\r\n") + "\r\n"
  );
}
