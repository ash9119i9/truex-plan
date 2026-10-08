// Run only against the isolated synthetic-agent stack. This creates native schedules.
// PLAYWRIGHT_MODULE_PATH points at an ephemeral playwright-core install; no repo dependency is needed.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE_PATH ||
    "/tmp/truex-automation-playwright/node_modules/playwright-core/index.mjs"
);
const meta = JSON.parse(
  await readFile("/tmp/truex-automation-browser.json", "utf8"),
);
const origin = process.env.AUTOMATIONS_BROWSER_ORIGIN || meta.frontend;
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin))
  throw new Error("Use the isolated local synthetic stack only");
const artifactDir =
  process.env.AUTOMATIONS_BROWSER_ARTIFACTS ||
  "/tmp/truex-automation-browser-evidence";
await mkdir(artifactDir, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [],
  baselineWarnings = [],
  failedRequests = [],
  checks = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() !== "error") return;
  if (message.location().url.endsWith("/favicon.ico"))
    baselineWarnings.push({ message: message.text(), resource: "favicon.ico" });
  else errors.push({ message: message.text(), url: message.location().url });
});
page.on("response", (response) => {
  if (response.url().includes("/api/") && response.status() >= 400)
    failedRequests.push({
      path: new URL(response.url()).pathname,
      status: response.status(),
    });
});
page.setDefaultTimeout(20000);
const name = `Synthetic browser verification ${Date.now()}`;
let automationId, originalAnchor;
async function responseFor(method, suffix, action) {
  const promise = page.waitForResponse(
    (response) =>
      response.request().method() === method &&
      new URL(response.url()).pathname.endsWith(suffix),
  );
  await action();
  const response = await promise;
  assert.ok(
    response.ok(),
    `${method} ${suffix}: ${response.status()} ${await response.text()}`,
  );
  return response.json();
}
async function preview() {
  const result = await responseFor("POST", "/preview", () =>
    page
      .getByRole("button", { name: "Preview next five", exact: true })
      .click(),
  );
  assert.equal(result.times.length, 5);
  await page.locator(".automation-preview li").first().waitFor();
  assert.equal(await page.locator(".automation-preview li").count(), 5);
  return result;
}
try {
  await page.goto(origin);
  await page.getByRole("button", { name: "Sidebar", exact: true }).click();
  await page
    .locator(".side-nav")
    .getByRole("button", { name: "Automations", exact: true })
    .click();
  await page
    .getByRole("button", { name: "New automation", exact: true })
    .click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  await page
    .getByRole("textbox", { name: "Execution prompt", exact: true })
    .fill(
      "Synthetic browser verification: return predetermined read-only result.",
    );
  await preview();
  checks.push(
    "Interval next-five preview rendered from real native Temporal response",
  );
  await page
    .getByRole("radio", { name: "Weekdays and local time", exact: true })
    .check();
  await page
    .getByLabel("IANA timezone", { exact: true })
    .fill("America/New_York");
  await page.getByLabel("Local execution time", { exact: true }).fill("01:30");
  await preview();
  assert.match(
    await page.locator(".automation-form").innerText(),
    /nonexistent times are skipped; repeated local times may run twice/,
  );
  checks.push(
    "Calendar preview and native DST gap/repeated-time explanation rendered",
  );
  await page
    .getByRole("radio", { name: "Fixed interval", exact: true })
    .check();
  await page.getByLabel("IANA timezone", { exact: true }).fill("UTC");
  const created = await responseFor("POST", "/api/automations", () =>
    page.getByRole("button", { name: "Save draft", exact: true }).click(),
  );
  automationId = created.id;
  originalAnchor = created.recipe.trigger.anchorAt;
  assert.equal(created.status, "draft");
  await page
    .getByRole("button", { name: "Enable reviewed revision", exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Enable reviewed revision", exact: true })
      .isDisabled(),
    true,
  );
  await page
    .getByRole("checkbox", {
      name: "I reviewed this agent, prompt, scope, schedule and limits.",
      exact: true,
    })
    .check();
  const enabled = await responseFor("POST", "/control", () =>
    page
      .getByRole("button", { name: "Enable reviewed revision", exact: true })
      .click(),
  );
  assert.equal(enabled.status, "enabled");
  checks.push(
    "Draft persisted; explicit review required before enabled native Schedule",
  );
  const accepted = await responseFor("POST", "/runs", () =>
    page.getByRole("button", { name: "Run now", exact: true }).click(),
  );
  await page
    .locator(".automation-outcome.succeeded")
    .waitFor({ timeout: 45000 });
  assert.match(
    await page.locator(".automation-detail").innerText(),
    /Synthetic verification result\. No business actions were performed\./,
  );
  assert.match(
    await page.locator(".automation-facts").first().innerText(),
    /Duration/,
  );
  const run = await page.request
    .get(`${origin}/api/automations/${automationId}/runs/${accepted.id}`)
    .then((response) => response.json());
  assert.equal(run.run.outcome, "succeeded");
  assert.equal(run.run.stopState, "stopped");
  assert.equal(run.run.auditComplete, true);
  assert.ok(run.events.length > 0);
  assert.ok(run.output.text);
  checks.push(
    "Run now completed through real Workflow/Activities/Mongo with synthetic result, exact root, timing and audit",
  );
  await page.getByRole("button", { name: "Close run", exact: true }).click();
  await page.getByLabel("Outcome", { exact: true }).selectOption("succeeded");
  const historyResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname.endsWith(`/${automationId}/runs`) &&
      new URL(response.url()).searchParams.get("status") === "succeeded",
  );
  await page
    .getByRole("button", { name: "Apply filters", exact: true })
    .click();
  assert.equal((await (await historyResponse).json()).items.length, 1);
  const downloadPromise = page.waitForEvent("download");
  await page
    .getByRole("link", { name: "Export metadata CSV", exact: true })
    .click();
  const download = await downloadPromise;
  const csvPath = `${artifactDir}/history.csv`;
  await download.saveAs(csvPath);
  const csv = await readFile(csvPath, "utf8");
  assert.match(csv, /succeeded/);
  assert.ok(!csv.includes("predetermined read-only result"));
  checks.push(
    "Outcome filter and actual authorized CSV download passed; prompt excluded",
  );
  const paused = await responseFor("POST", "/control", () =>
    page.getByRole("button", { name: "Pause", exact: true }).click(),
  );
  assert.equal(paused.status, "paused");
  const resumed = await responseFor("POST", "/control", () =>
    page.getByRole("button", { name: "Resume", exact: true }).click(),
  );
  assert.equal(resumed.status, "enabled");
  await page.getByRole("button", { name: "Edit recipe", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Name", exact: true })
    .fill(`${name} edited`);
  const edited = await responseFor(
    "PUT",
    `/api/automations/${automationId}`,
    () => page.getByRole("button", { name: "Save draft", exact: true }).click(),
  );
  assert.equal(edited.status, "draft");
  assert.equal(edited.recipe.trigger.anchorAt, originalAnchor);
  assert.equal(
    await page
      .getByRole("button", { name: "Run now", exact: true })
      .isDisabled(),
    true,
  );
  await page
    .getByRole("checkbox", {
      name: "I reviewed this agent, prompt, scope, schedule and limits.",
      exact: true,
    })
    .check();
  const reenabled = await responseFor("POST", "/control", () =>
    page
      .getByRole("button", { name: "Enable reviewed revision", exact: true })
      .click(),
  );
  assert.equal(reenabled.enabledRevision, edited.revision);
  assert.equal(reenabled.recipe.trigger.anchorAt, originalAnchor);
  checks.push(
    "Pause/resume and edited revision re-enablement preserve interval anchor",
  );
  await page.screenshot({ path: `${artifactDir}/desktop.png`, fullPage: true });
  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    // The existing shell animates a closing panel's width for .32s after resize.
    await page.waitForTimeout(450);
    const layout = await page.evaluate(() => {
      const root = document.querySelector(".automations-root");
      return {
        viewport: innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        rootWidth: root.clientWidth,
        rootScrollWidth: root.scrollWidth,
      };
    });
    assert.ok(
      layout.documentWidth <= width,
      `document overflow at ${width}: ${JSON.stringify(layout)}`,
    );
    assert.ok(
      layout.rootScrollWidth <= layout.rootWidth + 1,
      `automation overflow at ${width}: ${JSON.stringify(layout)}`,
    );
    checks.push(`Responsive ${width}px: no document or automation overflow`);
    if (width === 320)
      await page.screenshot({
        path: `${artifactDir}/mobile.png`,
        fullPage: true,
      });
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(failedRequests, []);
  checks.push(
    "No automation page/console errors or failed API responses; existing favicon warning recorded separately",
  );
  await writeFile(
    `${artifactDir}/result.json`,
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        origin,
        automationId,
        runId: accepted.id,
        checks,
        consoleErrors: errors,
        baselineWarnings,
        failedRequests,
        limitation:
          "Synthetic runtime; no configured external connector or production pilot, immediate runtime makes interactive cancellation impractical",
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify(
      { automationId, runId: accepted.id, checks, artifactDir },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error.message);
  await page
    .screenshot({ path: `${artifactDir}/failure.png`, fullPage: true })
    .catch(() => {});
  await writeFile(
    `${artifactDir}/failure.json`,
    JSON.stringify(
      {
        checks,
        consoleErrors: errors,
        baselineWarnings,
        failedRequests,
        visibleText: await page
          .locator("body")
          .innerText()
          .catch(() => "unavailable"),
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
} finally {
  // Leave no recurring synthetic test action active after verification.
  if (automationId) {
    const current = await page.request
      .get(`${origin}/api/automations/${automationId}`)
      .then((response) => response.json())
      .catch(() => null);
    if (current?.controlVersion)
      await page.request
        .post(`${origin}/api/automations/${automationId}/control`, {
          data: { version: current.controlVersion, action: "archive" },
          headers: { Origin: origin },
        })
        .catch(() => {});
  }
  await browser.close();
}
