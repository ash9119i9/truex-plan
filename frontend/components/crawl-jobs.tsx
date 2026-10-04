"use client";
import { useEffect, useRef, useState } from "react";
import { Download, Globe, RefreshCw } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { WebCrawlJob, WebCrawlResults } from "../../shared/web-crawl";
import { userMessage } from "@/lib/api";
import { createCrawlPoller } from "@/lib/crawl-poller";
import {
  cancelCrawl,
  crawlIsActive,
  crawlFailureMessage,
  crawlMarkdown,
  crawlReasonMessage,
  crawlResults,
  crawlSourceUrl,
  crawlStateLabel,
  listCrawls,
} from "@/lib/crawls";
import { Button } from "./ui/button";

function SourceLink({
  url,
  children,
}: {
  url: string;
  children: React.ReactNode;
}) {
  const href = crawlSourceUrl(url);
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ) : (
    <span>{children}</span>
  );
}

function CrawlCard({
  sessionId,
  job,
  refresh,
  onPrompt,
}: {
  sessionId: string;
  job: WebCrawlJob;
  refresh: () => void;
  onPrompt: (text: string) => void;
}) {
  const [results, setResults] = useState<WebCrawlResults | null>(null);
  const [offsets, setOffsets] = useState([0]);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  async function load(offset = 0, previous = false) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError("");
    try {
      const data = await crawlResults(
        sessionId,
        job.jobId,
        offset,
        controller.signal,
      );
      if (!controller.signal.aborted) {
        setResults(data);
        setOffsets((old) =>
          previous ? old.slice(0, -1) : offset === 0 ? [0] : [...old, offset],
        );
      }
    } catch (error) {
      if (!controller.signal.aborted)
        setError(
          userMessage(error, "Could not load saved crawl pages. Try again."),
        );
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  async function cancel() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setCancelling(true);
    setError("");
    try {
      await cancelCrawl(sessionId, job.jobId, controller.signal);
      if (!controller.signal.aborted) refresh();
    } catch (error) {
      if (!controller.signal.aborted)
        setError(
          userMessage(
            error,
            "Could not cancel the crawl. Refresh its progress before retrying.",
          ),
        );
    } finally {
      if (!controller.signal.aborted) {
        setBusy(false);
        setCancelling(false);
      }
    }
  }
  function download(page: WebCrawlResults["pages"][number]) {
    const href = URL.createObjectURL(
      new Blob([crawlMarkdown(page)], { type: "text/markdown;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = href;
    link.download = `crawl-${page.sourceId}${page.truncated ? "-excerpt" : ""}.md`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  }
  return (
    <article className="crawl-card">
      <header>
        <strong>
          <SourceLink url={job.seedUrl}>{job.seedUrl}</SourceLink>
        </strong>
        <span className={`crawl-state crawl-state-${job.state}`}>
          {crawlStateLabel[job.state]}
        </span>
      </header>
      <p className="crawl-counts">
        {job.counts.succeeded} saved · {job.counts.failed} failed ·{" "}
        {job.counts.pending} pending · {job.counts.attempted}/
        {job.limits.maxPages} pages attempted
      </p>
      <p className="muted">
        Depth ≤{job.limits.maxDepth} ·{" "}
        {Math.ceil(job.limits.maxDurationMs / 60000)} minute limit · Saved until{" "}
        {new Date(job.expiresAt).toLocaleString()}
      </p>
      {crawlReasonMessage(job) && (
        <p className="muted">{crawlReasonMessage(job)}</p>
      )}
      {job.warnings.map((warning, index) => (
        <p className="crawl-warning" key={index}>
          {warning}
        </p>
      ))}
      <div className="crawl-actions">
        {crawlIsActive(job.state) && (
          <Button
            type="button"
            variant="outline"
            disabled={cancelling || job.state === "cancelling"}
            onClick={() => void cancel()}
          >
            {job.state === "cancelling" || cancelling
              ? "Cancellation requested"
              : "Cancel crawl"}
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          disabled={busy || !job.counts.succeeded}
          onClick={() => void load()}
        >
          {busy
            ? "Loading…"
            : results
              ? "Refresh saved pages"
              : "View saved pages"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={!job.counts.succeeded}
          onClick={() =>
            onPrompt(
              `Read the saved results of web crawl ${job.jobId}, cite their source URLs, and help me with: `,
            )
          }
        >
          Discuss results
        </Button>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {results && (
        <div className="crawl-results">
          <p className="muted">
            Saved pages {results.pages.length ? results.offset + 1 : 0}–
            {results.offset + results.pages.length} of {results.totalPages}.
            Results are bounded; use Next for more pages.
          </p>
          {results.pages.map((page) => (
            <details className="crawl-page" key={page.sourceId}>
              <summary>
                {page.title || page.url}
                {page.truncated ? " · Excerpt" : ""}
              </summary>
              <p>
                <SourceLink url={page.url}>{page.url}</SourceLink>
              </p>
              <p className="muted">
                Depth {page.depth} · Retrieved{" "}
                {new Date(page.retrievedAt).toLocaleString()} ·{" "}
                {page.markdown.length.toLocaleString()} of{" "}
                {page.totalChars.toLocaleString()} characters
              </p>
              {page.truncated && (
                <p className="crawl-warning">
                  This is an excerpt of the saved page. The download contains
                  the same excerpt.
                </p>
              )}
              <Button
                type="button"
                variant="outline"
                onClick={() => download(page)}
              >
                <Download size={14} /> Download Markdown
                {page.truncated ? " excerpt" : ""}
              </Button>
              <div className="crawl-markdown">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    img: ({ alt }) => (
                      <span>{alt ? `[Image: ${alt}]` : "[Image]"}</span>
                    ),
                    a: ({ href, children }) => (
                      <SourceLink url={href ?? ""}>{children}</SourceLink>
                    ),
                  }}
                >
                  {page.markdown}
                </ReactMarkdown>
              </div>
            </details>
          ))}
          {results.failures.length > 0 && (
            <details className="crawl-failures">
              <summary>{results.failures.length} failed page attempts</summary>
              {results.failures.map((failure, index) => (
                <p key={index}>
                  <SourceLink url={failure.url}>{failure.url}</SourceLink> ·{" "}
                  {crawlFailureMessage(failure.code)}
                </p>
              ))}
            </details>
          )}
          <div className="crawl-actions">
            <Button
              type="button"
              variant="outline"
              disabled={busy || offsets.length < 2}
              onClick={() => void load(offsets.at(-2) ?? 0, true)}
            >
              Previous
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy || results.nextOffset === null}
              onClick={() => void load(results.nextOffset ?? 0)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </article>
  );
}

export function CrawlJobs({
  sessionId,
  refreshKey,
  onPrompt,
}: {
  sessionId?: string;
  refreshKey: number;
  onPrompt: (text: string) => void;
}) {
  const [jobs, setJobs] = useState<WebCrawlJob[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const poller = useRef<ReturnType<
    typeof createCrawlPoller<WebCrawlJob[]>
  > | null>(null);
  useEffect(() => {
    setJobs([]);
    setLoaded(false);
    setError("");
    if (!sessionId) return;
    const current = createCrawlPoller({
      visible: !document.hidden,
      load: (signal) => listCrawls(sessionId, signal),
      active: (jobs) => jobs.some((job) => crawlIsActive(job.state)),
      publish: (jobs) => {
        setJobs(jobs);
        setLoaded(true);
        setError("");
      },
      failed: (error) =>
        setError(
          userMessage(
            error,
            "Could not load crawl progress. Retrying shortly.",
          ),
        ),
    });
    poller.current = current;
    const visibility = () => current.setVisible(!document.hidden);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      current.dispose();
      poller.current = null;
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [sessionId]);
  useEffect(() => {
    poller.current?.refresh();
  }, [refreshKey, sessionId]);
  return (
    <section aria-label="Saved web crawls" className="conversation-crawls">
      <h3>
        <Globe size={16} /> Web crawls
      </h3>
      <p className="muted">
        Background crawls continue when you stop an assistant turn or close this
        page. Cancel a crawl here to stop it. Saved jobs belong to this original
        conversation and are not copied into forks.
      </p>
      {!sessionId ? (
        <p className="muted">
          Start a conversation, then ask the assistant to crawl a public
          website.
        </p>
      ) : (
        <>
          <Button
            type="button"
            variant="outline"
            onClick={() => poller.current?.refresh()}
          >
            <RefreshCw size={14} /> Refresh crawls
          </Button>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          {!loaded && !error && <p className="muted">Loading saved crawls…</p>}
          {loaded && !jobs.length && !error && (
            <p className="muted">No saved web crawls in this conversation.</p>
          )}
          {jobs.map((job) => (
            <CrawlCard
              key={job.jobId}
              sessionId={sessionId}
              job={job}
              refresh={() => poller.current?.refresh()}
              onPrompt={onPrompt}
            />
          ))}
        </>
      )}
    </section>
  );
}
