import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import net from "node:net";
const services = [
  ["agent-core", 4100],
  ["platform", 4000],
  ["frontend", 3000],
];
for (const [name, fallback] of services) {
  const file = resolve(name, ".env");
  const env = existsSync(file) ? readFileSync(file, "utf8") : "";
  const port = Number(env.match(/^PORT=(\d+)/m)?.[1] || fallback);
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", () => {
      let owner = "";
      try {
        owner = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], {
          encoding: "utf8",
        });
      } catch {}
      reject(new Error(`${name}: port ${port} is in use\n${owner}`));
    });
    server.listen(port, () => server.close(resolve));
  });
}
mkdirSync(".runtime/workspace", { recursive: true });
const children = services.map(([name]) =>
  spawn("npm", ["run", "dev"], {
    cwd: resolve(name),
    stdio: "inherit",
    detached: true,
  }),
);
let closing = false;
function stop() {
  if (closing) return;
  closing = true;
  for (const child of children) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
  }
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, stop);
children.forEach((child) =>
  child.on("exit", (code) => {
    if (!closing) {
      stop();
      process.exitCode = code || 0;
    }
  }),
);
