export const base =
  process.env.NEXT_PUBLIC_PLATFORM_URL || "http://localhost:4000";

export class ApiRequestError extends Error {
  status: number;
  code: string;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
  }
}

function statusMessage(status: number): string {
  const messages: Record<number, string> = {
    400: "The request is invalid. Check your input.",
    401: "Your session is not authenticated. Sign in again.",
    403: "You do not have permission to perform this operation.",
    404: "The requested conversation, agent, or file was not found.",
    409: "The request conflicts with the conversation's current state. Refresh it before retrying.",
    413: "The request is too large. Reduce the attachment or message size.",
    422: "The request could not be processed. Check your input and agent configuration.",
    429: "Too many requests. Wait before trying again.",
    502: "The assistant service returned an invalid response. Check the conversation before retrying.",
    503: "The service is temporarily unavailable. Try again later.",
    504: "The service timed out. Check the conversation before retrying; the request may have been accepted.",
  };
  return (
    messages[status] ||
    `The service could not complete the request (HTTP ${status}). Check the conversation before retrying.`
  );
}

export async function api(path: string, body?: unknown) {
  let res: Response;
  try {
    res = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(45000),
    });
  } catch (error) {
    const timeout = error instanceof Error && error.name === "TimeoutError";
    throw new ApiRequestError(
      timeout
        ? "The request timed out. Check the conversation before retrying; the request may have been accepted."
        : "Unable to connect to Truex. Check your network connection and service availability. If you submitted a message, check the conversation before retrying.",
      0,
      timeout ? "REQUEST_TIMEOUT" : "NETWORK_ERROR",
    );
  }
  if (res.status === 204) return undefined;
  let data: any;
  try {
    data = await res.json();
  } catch {
    throw new ApiRequestError(
      res.ok
        ? "The service returned an unreadable response. Refresh the conversation to check its current state."
        : statusMessage(res.status),
      res.status,
      res.ok ? "INVALID_RESPONSE" : `HTTP_${res.status}`,
    );
  }
  if (!res.ok)
    throw new ApiRequestError(
      typeof data?.error === "string" && data.error.trim()
        ? data.error
        : statusMessage(res.status),
      res.status,
      typeof data?.code === "string" ? data.code : `HTTP_${res.status}`,
    );
  return data;
}

// Helper agents spawned inside a conversation.
const agentsPath = (sessionId: string, agentId?: string) =>
  `/api/sessions/${encodeURIComponent(sessionId)}/agents` +
  (agentId ? `/${encodeURIComponent(agentId)}` : "");
export const listAgents = (sessionId: string) => api(agentsPath(sessionId));
export const getAgentTranscript = (sessionId: string, agentId: string) =>
  api(agentsPath(sessionId, agentId));
export const interruptAgent = (sessionId: string, agentId: string) =>
  api(agentsPath(sessionId, agentId) + "/interrupt", {});
