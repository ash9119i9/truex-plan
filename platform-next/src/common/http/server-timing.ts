import { AsyncLocalStorage } from "node:async_hooks";
import type { NextFunction, Request, Response } from "express";
import type { MongoClient } from "mongodb";

// Where each API request spent its time, returned in a Server-Timing header
// so the browser's network panel shows it: named steps with their MongoDB
// calls, the time a MongoDB command was in flight, any MongoDB connection
// the request had to open, and the total. Fixed names, durations and counts
// only; never IDs, queries or data.

export const SERVER_TIMING_HEADER = "server-timing";
// A long-lived stream keeps its timing; bound what it can collect.
const MAX_STEPS = 32;

interface Step {
  readonly name: string;
  readonly ms: number;
  readonly dbCalls: number;
}

export class RequestTiming {
  private readonly startedAt: number;
  private readonly steps: Step[] = [];
  private dbCalls = 0;
  private dbInFlight = 0;
  private dbSince = 0;
  private dbMs = 0;
  private connections = 0;
  private connectMs = 0;

  constructor(private readonly now: () => number = () => performance.now()) {
    this.startedAt = now();
  }

  // Steps run one after another, so a step's database calls are the calls
  // made while it ran.
  async step<T>(name: string, work: () => Promise<T>): Promise<T> {
    const started = this.now();
    const calls = this.dbCalls;
    try {
      return await work();
    } finally {
      if (this.steps.length < MAX_STEPS)
        this.steps.push({
          name,
          ms: this.now() - started,
          dbCalls: this.dbCalls - calls,
        });
    }
  }

  commandStarted(): void {
    this.dbCalls++;
    if (this.dbInFlight++ === 0) this.dbSince = this.now();
  }

  commandEnded(): void {
    if (this.dbInFlight === 0) return;
    if (--this.dbInFlight === 0) this.dbMs += this.now() - this.dbSince;
  }

  connectionOpened(ms: number): void {
    this.connections++;
    this.connectMs += ms;
  }

  header(): string {
    const now = this.now();
    const dbMs = this.dbMs + (this.dbInFlight > 0 ? now - this.dbSince : 0);
    const metrics = this.steps.map((s) =>
      metric(
        s.name,
        s.ms,
        s.dbCalls ? `${s.name} (${plural(s.dbCalls, "db call")})` : undefined,
      ),
    );
    metrics.push(
      metric("db", dbMs, `MongoDB (${plural(this.dbCalls, "call")})`),
    );
    if (this.connections)
      metrics.push(
        metric(
          "db-connect",
          this.connectMs,
          `Opened ${plural(this.connections, "MongoDB connection")}`,
        ),
      );
    metrics.push(metric("total", now - this.startedAt, "platform-next total"));
    return metrics.join(", ");
  }
}

function metric(name: string, ms: number, desc?: string): string {
  return `${name};dur=${ms.toFixed(1)}${desc ? `;desc="${desc}"` : ""}`;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

const storage = new AsyncLocalStorage<RequestTiming>();

// The timing of the request this code is running for, if any.
export function currentTiming(): RequestTiming | undefined {
  return storage.getStore();
}

// Times `work` as a step of the current request; outside a request it only
// runs it.
export function timed<T>(name: string, work: () => Promise<T>): Promise<T> {
  const timing = storage.getStore();
  return timing ? timing.step(name, work) : work();
}

// Runs work that outlives the request (a chat run's reader) outside the
// request's timing, so its later database calls are not counted against it.
export function detached<T>(work: () => T): T {
  return storage.exit(work);
}

// Starts the request's timing. The header is written when the response
// headers go out: for an event stream, that is when it starts streaming.
export function serverTiming(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  const timing = new RequestTiming();
  const writeHead = res.writeHead.bind(res) as (...args: unknown[]) => Response;
  res.writeHead = ((...args: unknown[]) => {
    if (!res.headersSent) res.setHeader(SERVER_TIMING_HEADER, timing.header());
    return writeHead(...args);
  }) as Response["writeHead"];
  storage.run(timing, next);
}

// Counts each MongoDB command against the request that issued it: command
// events run in the issuing operation's async context. A new connection is
// counted against the request whose checkout opened it; when requests
// overlap, the pool may hand it to another waiting request instead.
export function observeDatabase(client: MongoClient): void {
  client.on("commandStarted", () => storage.getStore()?.commandStarted());
  client.on("commandSucceeded", () => storage.getStore()?.commandEnded());
  client.on("commandFailed", () => storage.getStore()?.commandEnded());
  client.on("connectionReady", (event) =>
    storage.getStore()?.connectionOpened(event.durationMS),
  );
}
