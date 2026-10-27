import { Controller, Get, Inject, UseGuards } from "@nestjs/common";
import { TenantGuard } from "../../common/access/tenant.guard";
import { APP_CONFIG, type AppConfig } from "../../config/app-config";
import { skillView, type SkillView } from "./skill";
import { SkillsService } from "./skills.service";

// The skills a member can attach to an agent.
@Controller("skills")
@UseGuards(TenantGuard)
export class SkillsController {
  constructor(
    @Inject(SkillsService) private readonly skills: SkillsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // `scripts`: whether a skill's scripts can run here. They need the
  // runtime's coding profile, which CHAT_UPLOADS_ENABLED=1 already requires
  // (files-config.ts); without it the dialog marks script skills
  // "Needs coding".
  @Get()
  async list(): Promise<{ skills: SkillView[]; scripts: boolean }> {
    return {
      skills: (await this.skills.enabledSkills()).map(skillView),
      scripts: this.config.files?.uploads === true,
    };
  }
}
