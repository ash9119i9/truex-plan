// Full resume responses remain the default for history and existing callers.
export interface RuntimeResumeOptions {
  response?: "operational";
}

export function runtimeResumeResponse(
  value: unknown,
): RuntimeResumeOptions["response"] {
  if (value === undefined) return undefined;
  if (value !== "operational")
    throw new TypeError("Invalid runtime resume response");
  return value;
}
