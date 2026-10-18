import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from "@nestjs/common";
import {
  MongoClient,
  MongoClientBulkWriteError,
  MongoError,
  type AnyClientBulkWriteModel,
  type ClientBulkWriteResult,
  type ClientSession,
  type Db,
  type Document,
} from "mongodb";
import { observeDatabase } from "../common/http/server-timing";
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
      // Command events time each request's database work (Server-Timing).
      monitorCommands: true,
    });
    observeDatabase(this.client);
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

  // Writes to several collections in one round trip (MongoDB 8.0+). Inside
  // withTransaction, pass its session: the writes then commit or abort with
  // it. Without one, each write stands alone. Ordered: a failed write stops
  // the rest. `verbose` adds each write's own result (updateResults by
  // index), for callers that check one write among several.
  async bulkWrite(
    models: readonly AnyClientBulkWriteModel<Document>[],
    session?: ClientSession,
    verbose = false,
  ): Promise<ClientBulkWriteResult> {
    // The same namespace guard as tenantDb.
    for (const model of models)
      this.tenantDb(model.namespace.slice(0, model.namespace.indexOf(".")));
    try {
      return await this.client.bulkWrite(models, {
        ...(session ? { session } : {}),
        ordered: true,
        ...(verbose ? { verboseResults: true } : {}),
      });
    } catch (error) {
      // The driver (6.21) wraps a failure of the whole command, such as a
      // write conflict, in MongoClientBulkWriteError without its labels, so
      // withTransaction would not retry a TransientTransactionError. The
      // original error is what every other write would have thrown.
      if (
        error instanceof MongoClientBulkWriteError &&
        error.cause instanceof MongoError
      )
        throw error.cause;
      throw error;
    }
  }

  // The server's major version, for the startup check that chat's writes
  // can run (client bulkWrite needs MongoDB 8.0).
  async serverMajorVersion(): Promise<number> {
    const info = (await this.catalog().admin().command({ buildInfo: 1 })) as {
      versionArray?: number[];
    };
    return info.versionArray?.[0] ?? 0;
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
