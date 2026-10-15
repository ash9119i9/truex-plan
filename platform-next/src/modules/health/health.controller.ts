import { Controller, Get, Inject, Logger } from "@nestjs/common";
import { ApiError } from "../../common/http/api-error";
import { DatabaseService } from "../../database/database.service";

// Liveness says the process is running. Readiness says it can serve requests,
// which needs MongoDB; load balancers route traffic only to ready instances.
@Controller("health")
export class HealthController {
  private readonly logger = new Logger("Health");

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  @Get("live")
  live(): { status: "ok" } {
    return { status: "ok" };
  }

  @Get("ready")
  async ready(): Promise<{ status: "ready" }> {
    try {
      await this.database.ping();
    } catch (error) {
      this.logger.warn({
        message: "database unavailable",
        cause: error instanceof Error ? error.message : String(error),
      });
      throw new ApiError(503, "UNAVAILABLE", "The database is unavailable.");
    }
    return { status: "ready" };
  }
}
