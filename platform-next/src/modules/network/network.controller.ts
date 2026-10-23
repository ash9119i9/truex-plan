import {
  Body,
  Controller,
  Get,
  Inject,
  Put,
  Res,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import type { Response } from "express";
import {
  CurrentTenant,
  TenantGuard,
  type TenantContext,
} from "../../common/access/tenant.guard";
import { DomainErrorsInterceptor } from "../../common/http/domain-errors.interceptor";
import { requestIdOf } from "../../common/http/request-id";
import {
  parseUpdateTenantNetwork,
  TenantNetworkService,
  type TenantNetworkView,
} from "./tenant-network.service";

// The tenant's allowed sites for sandbox commands. Every member may read the
// list (it says what their agents can reach); only an admin may change it.
@Controller("tenant/network")
@UseGuards(TenantGuard)
@UseInterceptors(DomainErrorsInterceptor)
export class NetworkController {
  constructor(
    @Inject(TenantNetworkService)
    private readonly network: TenantNetworkService,
  ) {}

  @Get()
  async get(
    @CurrentTenant() context: TenantContext,
  ): Promise<{ network: TenantNetworkView }> {
    return { network: await this.network.get(context) };
  }

  @Put()
  async update(
    @CurrentTenant() context: TenantContext,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ network: TenantNetworkView }> {
    return {
      network: await this.network.update(
        context,
        parseUpdateTenantNetwork(body),
        requestIdOf(res),
      ),
    };
  }
}
