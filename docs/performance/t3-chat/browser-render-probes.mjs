// Browser-side probes for the native T3 preview's preview_evaluate tool.
// Run against production builds and browser-fixture.mjs in a visible tab.
// These functions inspect/interact with the UI; they are not application code.
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
const viewport = () =>
  document.querySelector(".chat-timeline-scroll, main > .scroll");
const conversation = (title) =>
  [...document.querySelectorAll(".convo-title")]
    .find((element) => element.textContent === title)
    ?.closest("button");

export async function expandHistory() {
  const samples = [];
  for (let page = 0; page < 30; page++) {
    const node = viewport();
    node.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    node.scrollTop = 0;
    await pause(35);
    const button = [...document.querySelectorAll("button")].find(
      (element) => element.textContent === "Load earlier messages",
    );
    if (!button) break;
    button.click();
    await pause(100);
    samples.push(document.querySelectorAll(".msg").length);
  }
  const node = viewport();
  node.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  node.scrollTop = node.scrollHeight;
  await pause(150);
  return {
    samples,
    rows: document.querySelectorAll(".msg").length,
    loadedAll: ![...document.querySelectorAll("button")].some((b) =>
      b.textContent.includes("earlier messages"),
    ),
    latestPresent: document.body.innerText.includes("fixture-long reply 999"),
  };
}

export async function measureWarmSwitches() {
  const samples = [];
  for (let index = 0; index < 6; index++) {
    const title =
      index % 2 ? "Fixture LONG conversation" : "Fixture A conversation";
    const expected =
      index % 2 ? "fixture-long reply 999" : "fixture-a reply 39";
    const button = conversation(title);
    if (!button)
      throw new Error("Open the sidebar and wait for its session list");
    const start = performance.now();
    button.click();
    let found = false;
    for (let attempt = 0; attempt < 300; attempt++) {
      await frame();
      if (viewport()?.innerText.includes(expected)) {
        found = true;
        break;
      }
    }
    if (!found) throw new Error(`Target transcript did not paint: ${title}`);
    samples.push({
      title,
      ms: performance.now() - start,
      rows: document.querySelectorAll(".msg").length,
    });
    await pause(700);
  }
  return { samples, visibility: document.visibilityState };
}

export async function measureBurst(id = "fixture-b") {
  const original = Storage.prototype.setItem;
  const writes = [];
  Storage.prototype.setItem = function (key, value) {
    if (this === sessionStorage && key === `cursor:${id}`) writes.push(value);
    return original.call(this, key, value);
  };
  try {
    await fetch("http://127.0.0.1:4400/__burst", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, count: 1000, delta: "x", final: false }),
    });
    await pause(600);
    return {
      exact: [...document.querySelectorAll(".answer")].some(
        (node) => node.textContent === "x".repeat(1000),
      ),
      cursorWrites: writes.length,
      lastCursor: writes.at(-1),
    };
  } finally {
    Storage.prototype.setItem = original;
  }
}
