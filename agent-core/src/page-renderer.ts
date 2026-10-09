import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { once } from "node:events";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { log } from "../../shared/logging";
import {
  isAppearance,
  visualizationDocument,
  type VisualizationAppearance,
} from "../../shared/visualization-document";

export const MEASURE_WIDTHS = [
  320, 375, 430, 520, 640, 728, 860, 1000, 1144,
] as const;
const PAGE_URL = "http://truex-visual-preview.invalid/page.html";
const MAX_MESSAGES = 20;
const MAX_MISSING_IMAGES = 20;
const MAX_TEXT = 500;
const MAX_SCREENSHOT_HEIGHT = 4000;
const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;
const VIEWPORT_HEIGHT = 800;

export interface RenderConsoleMessage {
  level: string;
  text: string;
}
export interface Preview {
  width: number;
  appearance: VisualizationAppearance;
  contentHeight: number;
  capturedHeight: number;
  consoleMessages: RenderConsoleMessage[];
  blockedRequests: string[];
  // Images on the page that did not load (for example a blocked remote URL).
  missingImages: string[];
  imageUrl?: string;
  hint?: string;
}
export interface MeasuredHeights extends Array<[number, number]> {
  warnings?: string[];
}
export interface PageRenderer {
  available(): boolean;
  preview(
    html: string,
    options?: { width?: number; appearance?: VisualizationAppearance },
  ): Promise<Preview>;
  measure(html: string, widths: readonly number[]): Promise<MeasuredHeights>;
}

export class RenderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

class RenderSemaphore {
  private active = 0;
  private waiting: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];
  constructor(private readonly limit: number) {}
  async acquire(deadline: number): Promise<() => void> {
    if (this.active < this.limit) {
      this.active++;
      return () => this.release();
    }
    if (this.waiting.length >= this.limit)
      throw new RenderError(
        "Visual rendering is busy. Try again shortly.",
        true,
      );
    const remaining = deadline - Date.now();
    if (remaining <= 0)
      throw new RenderError("Visual rendering timed out. Try again.", true);
    await new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiting = this.waiting.filter((item) => item !== waiter);
          reject(
            new RenderError(
              "Visual rendering timed out while waiting. Try again.",
              true,
            ),
          );
        }, remaining),
      };
      this.waiting.push(waiter);
    });
    return () => this.release();
  }
  private release() {
    const next = this.waiting.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve();
    } else {
      this.active--;
    }
  }
}

export function scrubbedChromiumEnv(profile: string): Record<string, string> {
  return {
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    XDG_CONFIG_HOME: profile,
    XDG_CACHE_HOME: profile,
    XDG_RUNTIME_DIR: join(profile, "runtime"),
    TMPDIR: rendererTempRoot(),
  };
}

export function rendererTempRoot(root = tmpdir()): string {
  const canonical = (value: string) => {
    try {
      return realpathSync(value);
    } catch {
      return resolve(value);
    }
  };
  const actual = canonical(root);
  for (const forbidden of [
    "/mnt/state",
    process.env.CODEX_HOME,
    process.env.AGENT_WORKSPACE,
  ]) {
    if (!forbidden) continue;
    const path = canonical(forbidden);
    if (actual === path || actual.startsWith(path + sep))
      throw new RenderError(
        "Browser temporary storage must be outside persistent state.",
        false,
      );
  }
  return actual;
}

export function truncateConsole(
  level: string,
  value: string,
): RenderConsoleMessage {
  return { level: level.slice(0, 20), text: value.slice(0, MAX_TEXT) };
}

function executableReason(enabled: boolean, path: string): string {
  if (!enabled) return "VISUAL_RENDER is off";
  if (!path) return "CHROMIUM_PATH is missing";
  if (!isAbsolute(path)) return "CHROMIUM_PATH must be absolute";
  try {
    accessSync(path, constants.X_OK);
    if (!statSync(path).isFile()) return "CHROMIUM_PATH is not a file";
    return "available";
  } catch {
    return "CHROMIUM_PATH is not executable";
  }
}

function remaining(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

function killBrowserGroup(browser: Browser | undefined) {
  const child = browser?.process();
  if (!child?.pid) return;
  try {
    if (process.platform === "win32") {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    } else process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function closeBrowser(browser: Browser | undefined, force: boolean) {
  if (!browser) return;
  const child = browser.process();
  if (force) killBrowserGroup(browser);
  else {
    await Promise.race([
      browser.close().catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, 500)),
    ]);
    killBrowserGroup(browser);
  }
  if (child && child.exitCode === null && child.signalCode === null)
    await Promise.race([
      once(child, "exit").catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, 1000)),
    ]);
}

function documentFor(
  html: string,
  appearance: VisualizationAppearance,
): string {
  return visualizationDocument(
    {
      id: "preview",
      title: "Visual preview",
      description: "",
      mode: "inline",
      html,
    },
    null,
    false,
    appearance,
  );
}

type RenderStats = { consoleErrors: number; blockedRequests: number };
type PageCapture = {
  page: Page;
  consoleMessages: RenderConsoleMessage[];
  blockedRequests: string[];
};

async function openPage(
  browser: Browser,
  html: string,
  width: number,
  stats: RenderStats,
  appearance: VisualizationAppearance = "light",
): Promise<PageCapture> {
  const page = await browser.newPage();
  // The page's own prefers-color-scheme rules should agree with the theme.
  await page.emulateMediaFeatures([
    { name: "prefers-color-scheme", value: appearance },
  ]);
  await page.setViewport({
    width,
    height: VIEWPORT_HEIGHT,
    deviceScaleFactor: 1,
  });
  const consoleMessages: RenderConsoleMessage[] = [];
  const blockedRequests: string[] = [];
  const blocked = (url: unknown) => {
    if (typeof url !== "string") return;
    stats.blockedRequests++;
    if (blockedRequests.length < MAX_MESSAGES)
      blockedRequests.push(url.slice(0, MAX_TEXT));
  };
  const record = (level: string, value: string) => {
    if (level === "error") stats.consoleErrors++;
    if (consoleMessages.length < MAX_MESSAGES)
      consoleMessages.push(truncateConsole(level, value));
  };
  page.on("console", (message) =>
    record(
      message.type() === "warn" ? "warning" : message.type(),
      message.text(),
    ),
  );
  page.on("pageerror", (error) =>
    record(
      "error",
      error instanceof Error ? error.stack || error.message : String(error),
    ),
  );
  page.on("dialog", (dialog) => {
    void dialog.dismiss().catch(() => {});
  });
  page.on("popup", (popup) => {
    if (popup) void popup.close().catch(() => {});
  });
  await page.exposeFunction("__truexBlockedResource", blocked);
  await page.evaluateOnNewDocument(
    "Object.defineProperty(window, 'open', { value: () => null, writable: false, configurable: false });",
  );
  await page.evaluateOnNewDocument(() => {
    addEventListener("securitypolicyviolation", (event) => {
      void (window as any).__truexBlockedResource(event.blockedURI);
    });
  });
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    if (
      request.url() === PAGE_URL &&
      request.isNavigationRequest() &&
      request.frame() === page.mainFrame()
    ) {
      void request
        .respond({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: documentFor(html, appearance),
        })
        .catch(() => {});
    } else {
      blocked(request.url());
      void request.abort("blockedbyclient").catch(() => {});
    }
  });
  await page.goto(PAGE_URL, { waitUntil: "load", timeout: 0 });
  return { page, consoleMessages, blockedRequests };
}

async function settle(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
}

// Sources of images that finished loading with nothing to show, or never did.
async function missingImages(page: Page): Promise<string[]> {
  const sources = await page.evaluate((limit: number) => {
    const missing: string[] = [];
    for (const image of Array.from(document.images)) {
      if (image.complete && image.naturalWidth > 0) continue;
      if (missing.length >= limit) break;
      missing.push(image.getAttribute("src") ?? "");
    }
    return missing;
  }, MAX_MISSING_IMAGES);
  return sources.map((source) => source.slice(0, MAX_TEXT));
}

async function contentHeight(page: Page): Promise<number> {
  return page.evaluate(() => {
    const root = document.documentElement;
    const height =
      root.scrollHeight > root.clientHeight
        ? root.scrollHeight
        : root.getBoundingClientRect().height;
    return Math.max(1, Math.ceil(height));
  });
}

export class ChromiumPageRenderer implements PageRenderer {
  private readonly permits: RenderSemaphore;
  private readonly enabled: boolean;
  private readonly executablePath: string;
  private readonly noSandbox: boolean;
  private readonly availabilityReason: string;
  constructor(
    options: {
      enabled?: boolean;
      executablePath?: string;
      noSandbox?: boolean;
      concurrency?: number;
      logStartup?: boolean;
    } = {},
  ) {
    this.enabled = options.enabled ?? process.env.VISUAL_RENDER === "1";
    this.executablePath =
      options.executablePath ?? process.env.CHROMIUM_PATH ?? "";
    this.noSandbox =
      options.noSandbox ?? process.env.CHROMIUM_NO_SANDBOX === "1";
    this.availabilityReason = executableReason(
      this.enabled,
      this.executablePath,
    );
    const configured =
      options.concurrency ?? Number(process.env.VISUAL_RENDER_CONCURRENCY || 2);
    const concurrency =
      Number.isInteger(configured) && configured >= 1 && configured <= 4
        ? configured
        : 2;
    this.permits = new RenderSemaphore(concurrency);
    if (options.logStartup !== false) {
      const reason = this.availabilityReason;
      log(
        this.noSandbox || (this.enabled && reason !== "available")
          ? "warn"
          : "info",
        "visual render startup",
        {
          op: "visual_render",
          enabled: reason === "available",
          reason,
          noSandbox: this.noSandbox,
          concurrency,
        },
      );
    }
  }
  available() {
    return this.availabilityReason === "available";
  }
  private async render<T>(
    kind: "preview" | "measure",
    budgetMs: number,
    work: (browser: Browser, stats: RenderStats) => Promise<T>,
  ): Promise<T> {
    const started = Date.now();
    const deadline = started + budgetMs;
    const stats: RenderStats = { consoleErrors: 0, blockedRequests: 0 };
    let release: (() => void) | undefined;
    let profile: string | undefined;
    let browser: Browser | undefined;
    let timer: NodeJS.Timeout | undefined;
    let expired = false;
    let ok = false;
    const abort = new AbortController();
    try {
      if (!this.available())
        throw new RenderError(
          "Visual rendering is unavailable. Enable VISUAL_RENDER and set an executable CHROMIUM_PATH, then start a new conversation.",
          false,
        );
      release = await this.permits.acquire(deadline);
      profile = await mkdtemp(join(rendererTempRoot(), "truex-visual-render-"));
      await mkdir(join(profile, "runtime"), { mode: 0o700 });
      const args = [
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-extensions",
        "--disable-sync",
        "--deny-permission-prompts",
        "--block-new-web-contents",
        "--no-first-run",
        "--no-default-browser-check",
        "--hide-scrollbars",
        "--mute-audio",
        "--proxy-server=http://127.0.0.1:9",
        "--proxy-bypass-list=<-loopback>",
        "--host-resolver-rules=MAP * ~NOTFOUND",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        ...(this.noSandbox ? ["--no-sandbox"] : []),
      ];
      const launch = puppeteer.launch({
        browser: "chrome",
        executablePath: this.executablePath,
        headless: true,
        pipe: true,
        userDataDir: profile,
        env: scrubbedChromiumEnv(profile),
        args,
        timeout: remaining(deadline),
        signal: abort.signal,
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
      });
      void launch
        .then((opened) => {
          browser = opened;
          if (expired) killBrowserGroup(opened);
        })
        .catch(() => {});
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          expired = true;
          abort.abort();
          killBrowserGroup(browser);
          reject(
            new RenderError(
              "Visual rendering timed out. Simplify the page and try again.",
              true,
            ),
          );
        }, remaining(deadline));
      });
      const result = await Promise.race([
        launch.then((opened) => work(opened, stats)),
        timeout,
      ]);
      ok = true;
      return result;
    } catch (error) {
      if (error instanceof RenderError) throw error;
      throw new RenderError(
        "The browser could not render this visual. Check the HTML and try again.",
        true,
      );
    } finally {
      if (timer) clearTimeout(timer);
      await closeBrowser(browser, !ok).catch(() => {});
      if (profile)
        await rm(profile, { recursive: true, force: true }).catch(() => {});
      release?.();
      log(ok ? "info" : "warn", "visual render", {
        op: "visual_render",
        kind,
        ms: Date.now() - started,
        ok,
        consoleErrors: stats.consoleErrors,
        blockedRequests: stats.blockedRequests,
        browserAvailable: this.available(),
      });
    }
  }
  async preview(
    html: string,
    options: { width?: number; appearance?: VisualizationAppearance } = {},
  ): Promise<Preview> {
    const appearance = options.appearance ?? "light";
    if (!isAppearance(appearance))
      throw new RenderError("Preview appearance must be light or dark.", false);
    const width = options.width ?? 728;
    if (!Number.isInteger(width) || width < 240 || width > 1600)
      throw new RenderError(
        "Preview width must be an integer from 240 to 1600.",
        false,
      );
    return this.render("preview", 20_000, async (browser, stats) => {
      const capture = await openPage(browser, html, width, stats, appearance);
      await settle(capture.page);
      const height = await contentHeight(capture.page);
      const missing = await missingImages(capture.page);
      const capturedHeight = Math.min(height, MAX_SCREENSHOT_HEIGHT);
      const png = await capture.page.screenshot({
        type: "png",
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width, height: capturedHeight },
      });
      const imageUrl =
        png.byteLength <= MAX_SCREENSHOT_BYTES
          ? "data:image/png;base64," + Buffer.from(png).toString("base64")
          : undefined;
      return {
        width,
        appearance,
        contentHeight: height,
        capturedHeight,
        consoleMessages: capture.consoleMessages,
        blockedRequests: capture.blockedRequests,
        missingImages: missing,
        ...(imageUrl
          ? { imageUrl }
          : { hint: "Screenshot omitted because it exceeded 10 MiB." }),
      };
    });
  }
  async measure(
    html: string,
    widths: readonly number[],
  ): Promise<MeasuredHeights> {
    if (
      !widths.length ||
      widths.length > 16 ||
      widths.some(
        (width) => !Number.isInteger(width) || width < 240 || width > 1600,
      )
    )
      throw new RenderError(
        "Measurement widths must be integers from 240 to 1600.",
        false,
      );
    return this.render("measure", 6_000, async (browser, stats) => {
      const capture = await openPage(browser, html, 728, stats);
      await settle(capture.page);
      const initialErrors = capture.consoleMessages
        .filter((item) => item.level === "error")
        .map((item) => item.text);
      const pairs = [] as MeasuredHeights;
      let warnings = initialErrors;
      for (const width of [...new Set(widths)].sort((a, b) => a - b)) {
        capture.consoleMessages.length = 0;
        await capture.page.setViewport({
          width,
          height: VIEWPORT_HEIGHT,
          deviceScaleFactor: 1,
        });
        await settle(capture.page);
        pairs.push([width, await contentHeight(capture.page)]);
        if (width === 728)
          warnings = [
            ...initialErrors,
            ...capture.consoleMessages
              .filter((item) => item.level === "error")
              .map((item) => item.text),
          ].slice(0, MAX_MESSAGES);
      }
      pairs.warnings = warnings;
      return pairs;
    });
  }
}
