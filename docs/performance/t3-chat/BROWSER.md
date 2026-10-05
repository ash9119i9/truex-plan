# Browser fixture and recorded results

[browser-results.json](browser-results.json) records measurements from the native T3 collaborative browser on 2026-10-05. Both versions were production webpack builds, viewed sequentially in the same **visible** 1280×800 tab. Keep the preview open during measurement: background tabs throttle animation frames and invalidate this comparison.

The fixture uses synthetic messages, an empty project list and no authentication or real runtime. It binds only to loopback port 4400. Its window path imports the actual platform history-window helper. Recovery waits 600 ms and persisted reads wait 15 ms. It provides 40-message A/B chats and a 1,000-message long chat. Runtime snapshot messages are empty so durable recovery—not a conveniently complete stream snapshot—must recover user history.

Run from the modified repository root with installed dependencies:

```sh
node --import ./platform/node_modules/tsx/dist/loader.mjs docs/performance/t3-chat/browser-fixture.mjs
```

Prepare a detached baseline at the commit recorded in the JSON, link its existing frontend dependencies, and build both versions with `NEXT_PUBLIC_PLATFORM_URL=http://127.0.0.1:4400 npm run build -- --webpack` from each frontend directory. Serve the baseline on port 3101 and modified build on 3102 using `npm run start -- --port 3101 --hostname 127.0.0.1` and the corresponding 3102 command. These ports are fixture previews, not the normal application stack.

Navigate to each version, open Sidebar, and evaluate this expression in the visible page. Set `recent=true` for the modified build and `false` for the baseline. It times two cold opens followed by three retained/repeated opens. Recovery settles before the next switch.

```js
(async () => {
  const recent = location.port === "3102";
  const results = [];
  for (const id of ["a", "b", "a", "b", "a"]) {
    const button = [...document.querySelectorAll(".convo")].find((row) =>
      row.textContent.includes(`Fixture ${id.toUpperCase()}`),
    );
    const start = performance.now();
    button.click();
    while (
      ![...document.querySelectorAll(".msg")].some((row) =>
        row.textContent.includes(`fixture-${id} question ${recent ? 20 : 0}`),
      )
    ) {
      if (performance.now() - start > 5000)
        throw new Error("Transcript timeout");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
    results.push({
      id,
      ms: performance.now() - start,
      rows: document.querySelectorAll(".msg").length,
    });
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  return results;
})();
```

For the long chat, click Fixture LONG and wait for `fixture-long question 0` in the baseline or `fixture-long question 980` in the modified version, then two frames. Only one sample per version was recorded; do not interpret it as a median or percentile.

## Experience and failure probes

- Open LONG, scroll away from bottom, capture the first visible `.msg[id]` and its offset relative to `[role=log]`. Click “Load earlier messages,” wait for 60 rows and two frames, then compare the same anchor. Recorded movement: 0.1875 CSS pixels.
- Enter an unsent draft, switch to B, then back to LONG. The draft and 60 expanded rows return before recovery completes. Scroll is restored by row offset, rather than requiring identical absolute scrollTop after composer height changes.
- `POST /__configure` with `{id:"fixture-a",persistedDelay:300}`; open A and then B 30 ms later. Late A data must not replace B. Reset fixture configuration before measuring.
- Configure an already cached thread with `{id:"fixture-long",error:403}`; reopen it. The transcript clears and an actionable error and Retry appear.
- `POST /__emit` with `{id,event}` sends an ordinary domain event. During an opening recovery, send a `message.delta` and a second `snapshot` containing newer text and running state. The recovery request remains single-flight and its older result cannot erase the newer text/state.
- Configure `{id,append:[message]}` to add a durable-only user message. Disconnect/reconnect the stream; the user message must appear even though the snapshot has no messages. A named event can be sent with `{id,name:"stream.error",event:{error:"Fixture connection closed",code:"STREAM_FAILED"}}`; click Reconnect to exercise manual catch-up.
- `GET /__metrics` exposes fixture requests, and `DELETE /__metrics` resets counters. Restart the fixture between independent experiments to reset histories/configuration.

These browser checks use fixture endpoints only. API authorization, tenancy and partial-write behavior are exercised by the separate real-Mongo and HTTP test suites. They do not establish production latency or memory bounds. Stop fixture and preview processes when finished; rebuild normally before running a production frontend against the real platform.
