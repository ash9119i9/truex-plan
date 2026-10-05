// Evaluate this through the native T3 preview_evaluate tool after opening Sidebar.
// Warm both Fixture A/LONG first; clear /__metrics, then collect 30 switches.
export function installSwitchObserver() {
  window.__observedSwitches = [];
  window.__observeSwitch = (title, needle) =>
    new Promise((resolve, reject) => {
      const button = [...document.querySelectorAll(".convo-title")]
        .find((n) => n.textContent === title)
        ?.closest("button");
      if (!button) return reject(new Error("Missing fixture button " + title));
      const start = performance.now();
      let dom = null;
      const observer = new MutationObserver(() => {
        const timeline = document.querySelector(".chat-timeline-scroll");
        const header = document.querySelector(
          '[title="Edit Fixture Assistant"]',
        );
        if (dom === null && timeline?.innerText.includes(needle))
          dom = performance.now() - start;
        if (
          dom !== null &&
          header?.textContent.includes("ready") &&
          document.querySelectorAll(".msg").length
        ) {
          observer.disconnect();
          const result = {
            title,
            domMs: dom,
            readyMs: performance.now() - start,
            mounted: document.querySelectorAll(".msg").length,
          };
          window.__observedSwitches.push(result);
          resolve(result);
        }
      });
      observer.observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
      });
      button.click();
    });
}

export async function tenSwitches() {
  for (let i = 0; i < 10; i++) {
    const a = i % 2 === 0;
    await window.__observeSwitch(
      a ? "Fixture A conversation" : "Fixture LONG conversation",
      a ? "fixture-a reply 39" : "fixture-long reply 999",
    );
  }
  return window.__observedSwitches;
}
