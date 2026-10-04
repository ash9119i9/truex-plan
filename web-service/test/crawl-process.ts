import { promises as fs } from "node:fs";
import { CrawlJobs } from "../src/crawl";
const root = process.argv[2],
  fixture = process.argv[3],
  phase = process.argv[4];
async function main() {
  const jobs = await CrawlJobs.open(root, {
    ready: async () => true,
    crawlPage: async (input, _host, signal) => {
      await fs.appendFile(`${fixture}/fetches`, input.url + "\n");
      if (input.url.endsWith("/slow") && phase === "first") {
        await fs.writeFile(`${fixture}/in-flight`, "yes");
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 60_000);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new Error("abort"));
            },
            { once: true },
          );
        });
      }
      return {
        provider: "crawl4ai",
        requestedUrl: input.url,
        url: input.url,
        title: "Fixture",
        retrievedAt: new Date().toISOString(),
        statusCode: 200,
        markdown: "Saved " + input.url,
        totalChars: ("Saved " + input.url).length,
        truncated: false,
        warnings: [],
        links: input.url.endsWith("/")
          ? ["https://example.com/slow", "https://example.com/last"]
          : [],
      };
    },
  });
  if (phase === "first") {
    const job = await jobs.start(
      { tenantId: "tenant", sessionId: "session" },
      { url: "https://example.com/", maxPages: 5, maxDepth: 2 },
      "process-key",
    );
    await fs.writeFile(`${fixture}/job-id`, job.jobId);
  }
  const timer = setInterval(async () => {
    const id = await fs.readFile(`${fixture}/job-id`, "utf8");
    const job = jobs.status({ tenantId: "tenant", sessionId: "session" }, id);
    if (["completed", "partial", "failed", "cancelled"].includes(job.state)) {
      clearInterval(timer);
      await fs.writeFile(
        `${fixture}/result`,
        JSON.stringify(
          await jobs.results(
            { tenantId: "tenant", sessionId: "session" },
            id,
            0,
            10,
            50000,
          ),
        ),
      );
      await jobs.close();
    }
  }, 100);
}
void main().catch(() => process.exit(1));
