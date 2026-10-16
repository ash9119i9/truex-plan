import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from "@nestjs/common";
import { MongoClient, type ClientSession, type Db } from "mongodb";
import {
  APP_CONFIG,
  isOwnedDatabaseName,
  type AppConfig,
} from "../config/app-config";

// How long an operation waits for a reachable MongoDB server before failing.
// Kept short so readiness reports an outage quickly instead of hanging.
const SERVER_SELECTION_TIMEOUT_MS = 2_000;
// Reconnect backoff while MongoDB has never been reached.
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 10_000;

// The app's single MongoDB client. The app starts and stays live while MongoDB
// is down, and reports it through readiness and 503 errors.
//
// The driver (6.x) closes its topology for good when its first connection
// attempt fails: every later operation throws MongoTopologyClosedError, even
// after MongoDB is back. Only an explicit connect() recovers, so until the
// first connection succeeds this service keeps retrying in the background.
// After that the driver's own monitoring handles outages.
@Injectable()
export class DatabaseService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger("Database");
  private readonly client: MongoClient;
  private reconnectTimer?: NodeJS.Timeout;
  private shuttingDown = false;
  private connected = false;
  private readonly connectWaiters = new Set<() => void>();

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.client = new MongoClient(config.mongodbUri, {
      appName: "platform-next",
      serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS,
    });
  }

  // Not awaited: startup must not wait for, or fail on, MongoDB.
  onModuleInit(): void {
    this.connectUntilReachable(RECONNECT_MIN_MS);
  }

  private connectUntilReachable(delayMs: number): void {
    if (this.shuttingDown) return;
    this.client.connect().then(
      () => {
        this.connected = true;
        for (const wake of this.connectWaiters) wake();
        this.connectWaiters.clear();
        if (delayMs > RECONNECT_MIN_MS)
          this.logger.log({ message: "database connected" });
      },
      (error: unknown) => {
        if (this.shuttingDown) return;
        // The error name only: messages can echo connection details.
        this.logger.warn({
          message: "database unreachable; retrying",
          error: error instanceof Error ? error.name : "unknown",
          retryInMs: delayMs,
        });
        // Jitter keeps many instances from reconnecting in lockstep.
        const wait = delayMs / 2 + Math.random() * (delayMs / 2);
        this.reconnectTimer = setTimeout(
          () =>
            this.connectUntilReachable(Math.min(delayMs * 2, RECONNECT_MAX_MS)),
          wait,
        );
        this.reconnectTimer.unref();
      },
    );
  }

  // Resolves once the first connection succeeds. For one-shot commands: a cold
  // connection (TLS, SRV lookup, auth) can outlast SERVER_SELECTION_TIMEOUT_MS,
  // and an operation started before it would fail. The server never waits.
  waitUntilConnected(timeoutMs: number): Promise<void> {
    if (this.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const wake = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.connectWaiters.delete(wake);
        reject(new Error(`MongoDB was not reachable within ${timeoutMs} ms.`));
      }, timeoutMs);
      this.connectWaiters.add(wake);
    });
  }

  // The shared catalog: users, tenants and memberships.
  catalog(): Db {
    return this.client.db(this.config.catalogDbName);
  }

  // A tenant's own database. Names come from the tenant registry, never from
  // request data; the guard still refuses anything outside our namespace.
  tenantDb(dbName: string): Db {
    if (!isOwnedDatabaseName(dbName) || dbName === this.config.catalogDbName)
      throw new Error(
        `Refusing to open database outside the tenant namespace.`,
      );
    return this.client.db(dbName);
  }

  // Runs work in a majority-committed transaction. The driver retries the
  // callback on transient errors, so it must only write through `session`.
  async withTransaction<T>(
    work: (session: ClientSession) => Promise<T>,
  ): Promise<T> {
    return this.client.withSession((session) =>
      session.withTransaction(() => work(session), {
        readConcern: { level: "majority" },
        writeConcern: { w: "majority" },
      }),
    );
  }

  async ping(): Promise<void> {
    await this.catalog().command({ ping: 1 });
  }

  async onApplicationShutdown(): Promise<void> {
    this.shuttingDown = true;
    clearTimeout(this.reconnectTimer);
    await this.client.close();
  }
}
