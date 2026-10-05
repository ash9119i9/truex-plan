// Run this function with T3 preview_evaluate in a visible production-build tab.
// Start browser-fixture.mjs on4400 and open the sidebar before running.
export const measureSyncSwitches = async () => {
  const results = [];
  for (let i = 0; i < 3; i++) {
    await fetch("http://127.0.0.1:4400/__metrics", { method: "DELETE" });
    const id = i % 2 ? "fixture-b" : "fixture-a";
    const title = i % 2 ? "Fixture B conversation" : "Fixture A conversation";
    const button = [...document.querySelectorAll(".convo-title")]
      .find((n) => n.textContent === title)
      ?.closest("button");
    if (!button) throw Error("No fixture target");
    const start = performance.now();
    button.click();
    let observed = false;
    while (performance.now() - start < 6000) {
      await new Promise((r) => requestAnimationFrame(r));
      const state =
        document.querySelector(".status-pill .muted:last-child") ||
        [...document.querySelectorAll(".muted")].find((n) =>
          ["ready", "syncing…", "loading…"].includes(n.textContent),
        );
      if (state?.textContent !== "ready") observed = true;
      if (observed && state?.textContent === "ready") break;
    }
    const requests = await (
      await fetch("http://127.0.0.1:4400/__metrics")
    ).json();
    const detail = requests.filter(
      (x) =>
        x.path === `/api/sessions/${id}?window=1` ||
        x.path === `/api/sessions/${id}?window=1&persisted=1`,
    );
    results.push({
      readyMs: performance.now() - start,
      requests: detail.map((x) => ({
        persisted: x.path.includes("persisted"),
        startedMs: x.at - detail[0].at,
        completedMs: x.finishedAt - detail[0].at,
      })),
      exactlyTwo: detail.length === 2,
    });
  }
  return results;
};
