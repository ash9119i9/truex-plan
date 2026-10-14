import { randomUUID } from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { lstat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import Ajv from "ajv";
import type { DynamicToolSpec } from "../../../shared/protocol/v2/DynamicToolSpec";
import { HttpError } from "../errors";

export type ScriptLanguage = "node" | "python";
export interface ScriptRunOptions {
  workRoot: string;
  language: ScriptLanguage;
  path: string;
  args: string[];
  timeoutMs: number;
}
export interface ScriptResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
}
export interface ScriptRunner {
  run(opts: ScriptRunOptions): Promise<ScriptResult>;
}
export type SpawnFn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;

const DEFAULT_TIMEOUT = 30;
const MAX_TIMEOUT = 120;
const MAX_OUTPUT = 65_536;
const KILL_GRACE_MS = 5_000;
const interpreters: Record<ScriptLanguage, string> = {
  node: "node",
  python: "python3",
};

export const scriptTools: DynamicToolSpec[] = [
  {
    type: "function",
    name: "run_script",
    description:
      "Run a Node.js or Python script that already exists in the workspace (write it first, e.g. under tmp/). Runs sandboxed with no network, a writable workspace at the current directory, and a time limit. Returns exit code, stdout and stderr (each capped at 64 KB). Delete temporary scripts when done.",
    inputSchema: {
      type: "object",
      properties: {
        language: { type: "string", enum: ["node", "python"] },
        path: { type: "string", minLength: 1, maxLength: 512 },
        args: {
          type: "array",
          maxItems: 32,
          items: { type: "string", maxLength: 4096 },
        },
        timeout_seconds: {
          type: "integer",
          minimum: 1,
          maximum: MAX_TIMEOUT,
        },
      },
      required: ["language", "path"],
      additionalProperties: false,
    },
  },
];
const ajv = new Ajv({ strict: false });
const validate = ajv.compile<any>(
  (scriptTools[0] as { inputSchema: object }).inputSchema,
);

export class DisabledScriptRunner implements ScriptRunner {
  async run(): Promise<ScriptResult> {
    throw new HttpError(503, "Script execution is not enabled on this server");
  }
}

export class DockerScriptRunner implements ScriptRunner {
  private readonly image: string;
  private readonly user: string;
  private readonly docker: string;
  private readonly spawn: SpawnFn;
  private readonly maxOutput: number;
  private readonly killGraceMs: number;
  constructor(
    opts: {
      image?: string;
      user?: string;
      docker?: string;
      spawn?: SpawnFn;
      maxOutput?: number;
      killGraceMs?: number;
    } = {},
  ) {
    this.image = opts.image || "truex-script-runner:local";
    this.user = opts.user || "65534:65534";
    this.docker = opts.docker || "docker";
    this.spawn = opts.spawn || nodeSpawn;
    this.maxOutput = opts.maxOutput ?? MAX_OUTPUT;
    this.killGraceMs = opts.killGraceMs ?? KILL_GRACE_MS;
  }
  dockerArgs(name: string, o: ScriptRunOptions): string[] {
    if (!isAbsolute(o.workRoot) || /[:,\0\n]/.test(o.workRoot))
      throw new HttpError(500, "Unsupported workspace path for script runner");
    return [
      "run",
      "--rm",
      "--name",
      name,
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "128",
      "--memory",
      "512m",
      "--cpus",
      "1",
      "--user",
      this.user,
      "--tmpfs",
      "/tmp:size=64m",
      "-v",
      `${o.workRoot}:/work:rw`,
      "-w",
      "/work",
      this.image,
      interpreters[o.language],
      // Absolute in-container path so a file named like a flag is never parsed as one.
      `/work/${o.path}`,
      ...o.args,
    ];
  }
  run(o: ScriptRunOptions): Promise<ScriptResult> {
    const name = `truex-script-${randomUUID()}`;
    const started = Date.now();
    return new Promise((resolve, reject) => {
      // Inside the executor so an unsafe mount path rejects instead of throwing.
      const args = this.dockerArgs(name, o);
      const out = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
      const size = { stdout: 0, stderr: 0 };
      let truncated = false,
        timedOut = false,
        settled = false,
        grace: NodeJS.Timeout | undefined,
        abandon: NodeJS.Timeout | undefined;
      let child: ChildProcess;
      try {
        child = this.spawn(this.docker, args, {
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch {
        reject(new HttpError(503, "Script runner is unavailable"));
        return;
      }
      const collect = (key: "stdout" | "stderr") => (chunk: Buffer) => {
        const room = this.maxOutput - size[key];
        if (chunk.length > room) truncated = true;
        if (room <= 0) return;
        const part = chunk.subarray(0, room);
        out[key].push(part);
        size[key] += part.length;
      };
      child.stdout?.on("data", collect("stdout"));
      child.stderr?.on("data", collect("stderr"));
      const killContainer = () => {
        try {
          const killer = this.spawn(this.docker, ["kill", name], {
            stdio: "ignore",
          });
          killer.on("error", () => {});
        } catch {}
      };
      const timer = setTimeout(() => {
        timedOut = true;
        killContainer();
        grace = setTimeout(() => {
          killContainer();
          child.kill("SIGKILL");
          // A child that survives SIGKILL, or a grandchild holding the pipes
          // open, must not leave the tool call pending forever.
          abandon = setTimeout(() => {
            child.stdout?.destroy();
            child.stderr?.destroy();
            done(null);
          }, this.killGraceMs);
        }, this.killGraceMs);
      }, o.timeoutMs);
      const finish = () => {
        settled = true;
        clearTimeout(timer);
        if (grace) clearTimeout(grace);
        if (abandon) clearTimeout(abandon);
      };
      const done = (code: number | null) => {
        if (settled) return;
        finish();
        resolve({
          exitCode: timedOut ? null : code,
          stdout: Buffer.concat(out.stdout).toString("utf8"),
          stderr: Buffer.concat(out.stderr).toString("utf8"),
          timedOut,
          truncated,
          durationMs: Date.now() - started,
        });
      };
      child.on("error", () => {
        if (settled) return;
        finish();
        reject(new HttpError(503, "Script runner is unavailable"));
      });
      child.on("close", (code: number | null) => done(code));
    });
  }
}

export function scriptRunnerFromEnv(env = process.env): ScriptRunner {
  if (env.SCRIPT_RUNNER === "docker")
    return new DockerScriptRunner({
      image: env.SCRIPT_RUNNER_IMAGE,
      user: env.SCRIPT_RUNNER_USER,
    });
  return new DisabledScriptRunner();
}

async function scriptPath(root: string, value: string): Promise<string> {
  const parts = value.split("/");
  if (
    isAbsolute(value) ||
    /[\\\0]/.test(value) ||
    parts.some((p) => p === "" || p === "." || p === "..")
  )
    throw new HttpError(400, "Use a relative script path inside the workspace");
  let current = root;
  for (const [i, part] of parts.entries()) {
    current = join(current, part);
    const stat = await lstat(current).catch(() => undefined);
    if (!stat) throw new HttpError(404, "Script not found");
    const last = i === parts.length - 1;
    if (stat.isSymbolicLink() || (last ? !stat.isFile() : !stat.isDirectory()))
      throw new HttpError(400, "Script must be a regular file, not a link");
  }
  return parts.join("/");
}

export class ScriptTools {
  constructor(
    private readonly workRoot: (threadId: string) => string,
    private readonly runner: ScriptRunner,
  ) {}
  async execute(threadId: string, name: string, args: any) {
    if (name !== "run_script" || !validate(args))
      throw new HttpError(400, "Invalid script tool arguments");
    if ((args.args || []).some((a: string) => a.includes("\0")))
      throw new HttpError(400, "Script arguments cannot contain NUL");
    const workRoot = this.workRoot(threadId);
    const path = await scriptPath(workRoot, args.path);
    return this.runner.run({
      workRoot,
      language: args.language,
      path,
      args: args.args || [],
      timeoutMs: (args.timeout_seconds ?? DEFAULT_TIMEOUT) * 1000,
    });
  }
}
