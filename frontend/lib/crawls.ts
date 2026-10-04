import type {
  WebCrawlJob,
  WebCrawlResults,
  WebCrawlState,
} from "../../shared/web-crawl";
import { api } from "./api.ts";

export const crawlIsActive = (state: WebCrawlState) =>
  ["queued", "running", "cancelling"].includes(state);
const path = (sessionId: string, jobId?: string) =>
  `/api/sessions/${encodeURIComponent(sessionId)}/crawls` +
  (jobId ? `/${encodeURIComponent(jobId)}` : "");
export async function listCrawls(
  sessionId: string,
  signal?: AbortSignal,
): Promise<WebCrawlJob[]> {
  const data = await api(path(sessionId), undefined, { signal });
  if (!Array.isArray(data?.jobs))
    throw new Error("The crawl list could not be read.");
  return data.jobs;
}
export const cancelCrawl = (
  sessionId: string,
  jobId: string,
  signal?: AbortSignal,
): Promise<WebCrawlJob> =>
  api(path(sessionId, jobId) + "/cancel", {}, { signal });
export const crawlResults = (
  sessionId: string,
  jobId: string,
  offset = 0,
  signal?: AbortSignal,
): Promise<WebCrawlResults> =>
  api(
    path(sessionId, jobId) + `/results?offset=${offset}&limit=3&maxChars=20000`,
    undefined,
    { signal },
  );

export function crawlSourceUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.port ||
      /^(localhost|.*\.(localhost|local|internal|test|invalid))$/.test(host) ||
      /^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(
        host,
      ) ||
      (host.startsWith("[") && !/^\[[23][0-9a-f]{0,3}:/.test(host))
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

export function crawlMarkdown(page: WebCrawlResults["pages"][number]): string {
  return `# ${page.title.replace(/[\r\n]/g, " ")}\n\nSource: ${page.url}\nRetrieved: ${page.retrievedAt}\n${page.truncated ? "\nThis download contains a bounded excerpt of the saved page.\n" : ""}\n${page.markdown}\n`;
}

export const crawlStateLabel: Record<WebCrawlState, string> = {
  queued: "Queued",
  running: "Running",
  cancelling: "Cancelling",
  completed: "Completed",
  partial: "Partial",
  failed: "Failed",
  cancelled: "Cancelled",
};
export function crawlFailureMessage(code: string): string {
  const messages: Record<string, string> = {
    READ_BLOCKED: "Access was blocked",
    READ_NOT_FOUND: "Page not found",
    READ_UNSUPPORTED: "Unsupported page format",
    READ_EMPTY: "No readable text",
    READ_TIMEOUT: "Page read timed out",
    READ_RATE_LIMITED: "Site was rate-limited",
    CRAWL_BLOCKED: "Access was blocked",
  };
  return messages[code] ?? "Page could not be read";
}
export function crawlReasonMessage(job: WebCrawlJob): string | null {
  const reasons = {
    page_limit: "Stopped at the page limit.",
    depth_limit: "Stopped at the depth limit.",
    frontier_limit: "Stopped at the link limit.",
    byte_limit: "Stopped at the saved size limit.",
    deadline: "Stopped at the time limit.",
    queue_exhausted: "The allowed link queue is exhausted.",
    cancelled: "The crawl was cancelled; saved pages remain available.",
    error: "The crawl could not finish; inspect its saved pages and failures.",
  };
  return job.reason ? reasons[job.reason] : null;
}
