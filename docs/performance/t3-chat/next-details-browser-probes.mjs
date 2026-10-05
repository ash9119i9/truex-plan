// Evaluate these only in next-details-fixture.mjs's isolated native browser tab.
// Explicit flushSync commits isolate rendering work; do not call them production
// frame latency or compare them to provider/network measurements.
export const projectionProbe = () => {
  const initial = {
    reasoningBodyChars:
      document.querySelector(".thinking-body")?.textContent.length ?? 0,
    reasoningMarkupBytes: document.querySelector(".thinking")?.outerHTML.length,
    failed100Percent: document
      .querySelector(".live-card")
      ?.innerText.includes("100%"),
  };
  window.fixture.set({ open: false });
  window.fixtureMetrics.eventProjections = 0;
  const samples = [];
  for (let i = 1; i <= 30; i++) {
    const start = performance.now();
    window.fixture.set({
      version: i,
      reasoning: "fixture reasoning ".repeat(50000) + " appended " + i,
    });
    samples.push(performance.now() - start);
  }
  return {
    initial,
    hiddenEventProjectionCalls: window.fixtureMetrics.eventProjections,
    copyCodeControls: document.querySelectorAll('[aria-label="Copy code"]')
      .length,
    visibility: document.visibilityState,
    userAgent: navigator.userAgent,
    samples,
    scope:
      "Forced flushSync synthetic component commits; CPU+DOM update excludes layout/frame scheduling and production app latency",
  };
};

export function mobileCodeProbe() {
  window.fixture.set({
    answer:
      "```txt\n" +
      "a".repeat(500) +
      "\n```\n\n| A | B |\n|---|---|\n| " +
      "b".repeat(500) +
      " | C |",
  });
  const measure = () => ({
    viewportWidth: document.documentElement.clientWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
    codeClientWidth: document.querySelector("pre").clientWidth,
    codeScrollWidth: document.querySelector("pre").scrollWidth,
    codeWhiteSpace: getComputedStyle(document.querySelector("pre")).whiteSpace,
  });
  const before = measure();
  [...document.querySelectorAll("button")]
    .find((button) => button.textContent === "Wrap lines")
    .click();
  window.fixture.set({ version: 2 });
  return { before, after: measure() };
}
