import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../config/app-config";
import { toWireId } from "../../database/object-id";
import { TenantsService } from "../tenants/tenants.service";
import { ChatsService } from "./chats.service";
import { RunExecutor } from "./run-executor";

// How often every tenant's lapsed runs are looked for.
export const RECOVERY_SWEEP_MS = 60_000;

// Finds replies whose reading process went away (a crash, a restart, or a
// reader that gave up) and recovers them, so a chat is not left answering
// until its owner happens to open it. One indexed query per ready tenant per
// sweep (active_lease), plus recovery's own reads for each orphan found.
//
// Safe with more than one platform process: a run is taken over only by
// moving the lease it was seen with (ChatStore.takeOverLease), so two
// processes never both read it. Browsers still need to reach the process
// that reads it (backlog/performance/06-multi-instance-streams.md).
@Injectable()
export class RecoverySweep
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger("RecoverySweep");
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<number> | undefined;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(ChatsService) private readonly chats: ChatsService,
    @Inject(TenantsService) private readonly tenants: TenantsService,
    @Inject(RunExecutor) private readonly executor: RunExecutor,
  ) {}

  onApplicationBootstrap(): void {
    const every = this.config.chat?.recoverySweepMs ?? RECOVERY_SWEEP_MS;
    if (!this.config.chat || every <= 0) return;
    this.timer = setInterval(() => void this.runOnce(), every);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  // One sweep; a call while one runs joins it. Returns how many lapsed
  // chats it looked at. Never throws: a tenant that fails is logged and the
  // rest are swept.
  runOnce(): Promise<number> {
    this.running ??= this.sweep().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async sweep(): Promise<number> {
    if (!this.executor.configured || this.executor.isDraining) return 0;
    let tenants;
    try {
      tenants = await this.tenants.listReady();
    } catch (error) {
      this.logger.warn({
        message: "recovery sweep could not list tenants",
        error: error instanceof Error ? error.name : "unknown",
      });
      return 0;
    }
    let found = 0;
    for (const tenant of tenants) {
      if (this.executor.isDraining) break;
      try {
        found += await this.chats.recoverOrphans({
          tenantId: tenant._id,
          dbName: tenant.dbName,
        });
      } catch (error) {
        this.logger.warn({
          message: "recovery sweep failed for a tenant",
          tenantId: toWireId(tenant._id),
          error: error instanceof Error ? error.name : "unknown",
        });
      }
    }
    if (found > 0)
      this.logger.log({
        message: "recovery sweep found lapsed replies",
        chats: found,
        tenants: tenants.length,
      });
    return found;
  }
}
