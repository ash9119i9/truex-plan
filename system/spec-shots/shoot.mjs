// Screen captures for DESIGN-SPEC.html. Drives the study screens (chat demo
// commands, panel tabs) over the Chrome DevTools protocol and saves PNGs here.
// usage: node system/spec-shots/shoot.mjs        (needs Google Chrome; then rebuild the spec)
import { spawn } from "node:child_process";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SYS = dirname(HERE);
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9333;
const prof = mkdtempSync(join(tmpdir(), "spec-shoot-"));
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
  `--user-data-dir=${prof}`, `--remote-debugging-port=${PORT}`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let wsUrl;
for (let i = 0; i < 50 && !wsUrl; i++) {
  try { wsUrl = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === "page")?.webSocketDebuggerUrl; } catch {}
  if (!wsUrl) await sleep(200);
}
if (!wsUrl) throw new Error("Chrome did not start");
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let seq = 0;
const waiting = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
});
const send = (method, params = {}) => new Promise((r) => { const id = ++seq; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });

// type a command into whichever chat composer is showing, then press Enter
const typeIn = (cmd) => `(() => {
  const el = document.querySelector(".is-new") ? document.getElementById("cs-hero-input") : document.getElementById("cs-input");
  el.focus(); el.value = ${JSON.stringify(cmd)}; el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
})()`;

async function shot(name, path, { cmd, wait = 7000, clip } = {}) {
  await send("Page.navigate", { url: `file://${SYS}/${path}` });
  await sleep(2500);
  if (cmd) { await send("Runtime.evaluate", { expression: typeIn(cmd) }); await sleep(wait); }
  const r = await send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
  writeFileSync(join(HERE, `${name}.png`), Buffer.from(r.result.data, "base64"));
  console.log("saved", name);
}

const column = { x: 340, y: 60, width: 760, height: 830 };   // the chat thread + composer
const dock = { x: 340, y: 500, width: 760, height: 390 };   // the pinned request card above the composer
const panel = { x: 940, y: 96, width: 384, height: 800 };    // the Activity Panel frame

await shot("chat-light", "screens/chat.html?theme=light");
await shot("chat-dark", "screens/chat.html?theme=dark");
await shot("chat-turn", "screens/chat.html?theme=light", { cmd: "Summarise the Q3 pipeline in three bullets.", wait: 9000, clip: column });
await shot("req-ask", "screens/chat.html?theme=light", { cmd: "/ask", clip: dock });
await shot("req-tool", "screens/chat.html?theme=light", { cmd: "/ask tool", clip: dock });
await shot("req-plan", "screens/chat.html?theme=light", { cmd: "/plan", clip: column });
await shot("req-elicit", "screens/chat.html?theme=light", { cmd: "/elicit", clip: { x: 340, y: 370, width: 760, height: 520 } });
await shot("turn-error", "screens/chat.html?theme=light", { cmd: "/error", clip: column });
for (const [tab, name] of [["activity", "activity-light"], ["agent", "activity-agent"], ["files", "activity-files"], ["insights", "activity-insights"]])
  await shot(name, `screens/business-activity.html?theme=light&tab=${tab}`, { clip: panel });
await shot("activity-dark", "screens/business-activity.html?theme=dark&tab=activity", { clip: panel });
await shot("agents-light", "screens/agents.html?theme=light");
await shot("agents-dark", "screens/agents.html?theme=dark");
await shot("agent-id", "screens/agent-id.html?theme=light");
await shot("charts", "chart-studies.html?theme=light");
await shot("patterns", "06-patterns.html?theme=light");

ws.close();
chrome.kill();
await sleep(300);
rmSync(prof, { recursive: true, force: true });
