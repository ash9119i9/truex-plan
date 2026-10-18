import net from "node:net";

// True when something accepts connections on the port at IPv4 or IPv6
// loopback. A bind test misses some listeners: on macOS, binding the wildcard
// address succeeds while another process listens on 127.0.0.1.
export function portInUse(port, { timeoutMs = 1000 } = {}) {
  const probe = (host) =>
    new Promise((resolve) => {
      const socket = net.createConnection({ port, host });
      const finish = (busy) => {
        socket.destroy();
        resolve(busy);
      };
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
      socket.setTimeout(timeoutMs, () => finish(false));
    });
  return Promise.all([probe("127.0.0.1"), probe("::1")]).then((found) =>
    found.includes(true),
  );
}

// The platform opens its listener only after initialization. Waiting here avoids
// mounting the UI while its initial API requests would still be refused.
export function waitForPort(
  port,
  { host = "127.0.0.1", signal, timeoutMs = 60000 } = {},
) {
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  )
    return Promise.reject(
      new RangeError("Invalid backend readiness port or timeout"),
    );
  return new Promise((resolve, reject) => {
    let socket;
    let retry;
    let finished = false;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      clearTimeout(retry);
      signal?.removeEventListener("abort", abort);
      socket?.destroy();
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish(signal.reason ?? new Error("Startup cancelled"));
    const deadline = setTimeout(
      () =>
        finish(
          new Error(
            `Backend on port ${port} did not start within ${timeoutMs} ms`,
          ),
        ),
      timeoutMs,
    );
    const attempt = () => {
      if (finished) return;
      socket = net.createConnection({ port, host });
      socket.once("connect", () => finish());
      socket.setTimeout(1000, () =>
        socket.destroy(new Error("Connection timed out")),
      );
      socket.once("error", () => {
        socket.destroy();
        if (!finished) retry = setTimeout(attempt, 100);
      });
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    else attempt();
  });
}
