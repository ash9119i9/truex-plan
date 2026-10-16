import { Controller, Get, Inject, UseGuards } from "@nestjs/common";
import { TenantGuard } from "../../common/access/tenant.guard";
import { modelView, type ModelView } from "./model";
import { ModelsService } from "./models.service";

// The models a member can choose for an agent. Display fields only.
@Controller("models")
@UseGuards(TenantGuard)
export class ModelsController {
  constructor(@Inject(ModelsService) private readonly models: ModelsService) {}

  @Get()
  async list(): Promise<{ models: ModelView[] }> {
    return { models: (await this.models.enabledModels()).map(modelView) };
  }
}
