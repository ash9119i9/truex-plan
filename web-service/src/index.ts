import "dotenv/config";
import { SearxngSearch } from "./searxng";
import { createWebService } from "./server";
import { Crawl4aiRead } from "./crawl4ai";
import { CrawlJobs } from "./crawl";

if (!process.env.SEARXNG_URL || !process.env.WEB_SERVICE_TOKEN)
  throw new Error("SEARXNG_URL and WEB_SERVICE_TOKEN are required");
const search = new SearxngSearch({
  url: process.env.SEARXNG_URL,
  timeoutMs: Number(process.env.SEARCH_TIMEOUT_MS || 15_000),
});
const reader = new Crawl4aiRead({
  url: process.env.CRAWL4AI_URL,
  token: process.env.CRAWL4AI_API_TOKEN,
  timeoutMs: Number(process.env.READ_TIMEOUT_MS || 35_000),
});
async function main() {
  if (process.env.WEB_CRAWL && !["on", "off"].includes(process.env.WEB_CRAWL))
    throw new Error("WEB_CRAWL must be on or off");
  let crawls: CrawlJobs | undefined;
  if (process.env.WEB_CRAWL === "on") {
    const base = new URL(process.env.CRAWL4AI_URL || "");
    if (
      !["http:", "https:"].includes(base.protocol) ||
      base.username ||
      base.password ||
      base.pathname !== "/" ||
      base.search ||
      base.hash ||
      !/^[A-Za-z0-9_-]{32,256}$/.test(process.env.CRAWL4AI_API_TOKEN || "") ||
      !Number.isInteger(Number(process.env.READ_TIMEOUT_MS || 35_000)) ||
      Number(process.env.READ_TIMEOUT_MS || 35_000) < 1 ||
      Number(process.env.READ_TIMEOUT_MS || 35_000) > 60000
    )
      throw new Error("Invalid WebCrawl provider configuration");
    crawls = await CrawlJobs.open(
      process.env.WEB_CRAWL_DATA_DIR || "/data/webcrawl",
      reader,
    );
  }
  const service = createWebService(
    search,
    process.env.WEB_SERVICE_TOKEN!,
    Number(process.env.SEARCH_MAX_CONCURRENT || 4),
    reader,
    Number(process.env.READ_MAX_CONCURRENT || 2),
    crawls,
  );
  const server = service.app.listen(
    Number(process.env.PORT || 4400),
    process.env.HOST || "127.0.0.1",
  );
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    const drained = service.drain();
    server.close(() => {
      void Promise.resolve(drained).then(() => process.exit(0));
    });
    server.closeIdleConnections();
    setTimeout(() => {
      server.closeAllConnections();
      process.exit(0);
    }, 5000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
void main().catch(() => {
  console.error(
    "Web service startup failed: check configured services and crawl storage ownership.",
  );
  process.exit(1);
});
