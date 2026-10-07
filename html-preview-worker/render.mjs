import { chromium } from "playwright-core";

// This executable is ONLY run in a disposable, network-none, mount-free,
// read-only, non-root container. Its browser namespace sandbox is unavailable
// under Docker's default seccomp/user-namespace policy; the container is the
// execution boundary. Never invoke this worker directly on a runtime host.
const PAGE = "http://truex-preview.invalid/page";
const MAX_INPUT = 1024 * 1024;
const MAX_PNG = 4 * 1024 * 1024;
let browser;
// Survives a crashed/disconnected supervisor: Node is outside Chromium's JS
// thread, so even an infinite page script cannot suppress this container TTL.
const watchdog = setTimeout(() => process.exit(124), 19_000);
try {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_INPUT) throw new Error("input_limit");
    chunks.push(chunk);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (
    typeof input.html !== "string" ||
    !Number.isInteger(input.width) ||
    input.width < 240 ||
    input.width > 1600
  )
    throw new Error("invalid_input");
  browser = await chromium.launch({
    executablePath: "/usr/bin/chromium",
    chromiumSandbox: false,
    args: [
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--disable-background-networking",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    ],
  });
  const context = await browser.newContext({
    viewport: { width: input.width, height: 800 },
    colorScheme: input.appearance === "light" ? "light" : "dark",
    serviceWorkers: "block",
    acceptDownloads: false,
  });
  const page = await context.newPage();
  const consoleMessages = [];
  const addConsole = (level, text) => {
    if (consoleMessages.length < 20)
      consoleMessages.push({ level, text: String(text).slice(0, 500) });
  };
  page.on("console", (event) => {
    const level = {
      log: "log",
      info: "info",
      warning: "warning",
      error: "error",
      debug: "log",
    }[event.type()];
    if (level) addConsole(level, event.text());
  });
  page.on("pageerror", (error) => addConsole("error", error.message));
  page.on("popup", (popup) => popup.close().catch(() => {}));
  // Data/blob images remain usable. Every network request, navigation, frame
  // and worker request is rejected except the single initial synthetic page.
  let served = false;
  await context.route("**/*", async (route) => {
    const request = route.request();
    if (
      !served &&
      request.url() === PAGE &&
      request.isNavigationRequest() &&
      request.frame() === page.mainFrame()
    ) {
      served = true;
      await route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: input.html,
      });
    } else await route.abort("blockedbyclient");
  });
  await page.goto(PAGE, { waitUntil: "load", timeout: 15_000 });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
  });
  const contentHeight = await page.evaluate(() => {
    const root = document.documentElement,
      body = document.body;
    return Math.ceil(
      Math.max(
        root.getBoundingClientRect().height,
        body?.getBoundingClientRect().height ?? 0,
        root.scrollHeight > root.clientHeight ? root.scrollHeight : 0,
      ),
    );
  });
  const capturedHeight = Math.min(4000, Math.max(1, contentHeight));
  await page.setViewportSize({ width: input.width, height: capturedHeight });
  const png = await page.screenshot({
    type: "png",
    animations: "disabled",
    timeout: 5000,
  });
  if (png.length > MAX_PNG) throw new Error("screenshot_limit");
  process.stdout.write(
    JSON.stringify({
      width: input.width,
      contentHeight,
      capturedHeight,
      consoleMessages,
      screenshot: {
        mimeType: "image/png",
        data: png.toString("base64"),
        width: input.width,
        height: capturedHeight,
      },
    }),
  );
} catch (error) {
  // Operational output never contains source HTML, console data or file paths.
  process.stderr.write("HTML preview worker failed.\n");
  process.exitCode = error?.name === "TimeoutError" ? 124 : 1;
} finally {
  await browser?.close().catch(() => {});
  clearTimeout(watchdog);
}
