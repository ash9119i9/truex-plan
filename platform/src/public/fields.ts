export const finite = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
export const SUB_AGENT_ID = /^[A-Za-z0-9_-]{1,128}$/;
export const clamp = (value: unknown, max: number) =>
  typeof value === "string" && value
    ? value.length > max
      ? value.slice(0, max - 1).trimEnd() + "…"
      : value
    : null;
