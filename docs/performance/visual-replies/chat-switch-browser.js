// Evaluate in T3 preview_evaluate after loading a 40-message fixture session.
(() => {
  window.__switch = { samples: [], errors: [] };
  let i = 0;
  const run = () => {
    if (i === 30) return;
    const target = i % 2 ? "A" : "B";
    const button = [...document.querySelectorAll("button.convo")].find((x) =>
      x.innerText.startsWith("Fixture " + target),
    );
    if (!button) {
      const toggle = document.querySelector('button[aria-label="Sidebar"]');
      if (toggle.getAttribute("aria-pressed") === "false") toggle.click();
      setTimeout(run, 300);
      return;
    }
    const start = performance.now();
    let done = false;
    const finish = () => {
      if (
        done ||
        !document.body.innerText.includes(
          "fixture-" + target.toLowerCase() + " reply 39",
        )
      )
        return;
      done = true;
      observer.disconnect();
      clearTimeout(timer);
      window.__switch.samples.push(performance.now() - start);
      i++;
      setTimeout(run, 300);
    };
    const observer = new MutationObserver(finish);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    const timer = setTimeout(() => {
      if (!done) {
        observer.disconnect();
        window.__switch.errors.push("timeout " + i);
      }
    }, 5000);
    button.click();
    finish();
  };
  run();
  return "started";
})();
