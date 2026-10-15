import { Controller, Get, Inject, UseGuards } from "@nestjs/common";
import {
  AuthenticatedGuard,
  Caller,
} from "../../common/access/authenticated.guard";
import type { AuthenticatedCaller } from "../sessions/sessions.service";
import {
  AccountService,
  type AccountProfile,
  type AccountTenants,
} from "./account.service";

// User-only endpoints: they need a signed-in caller but no tenant.
@Controller("me")
@UseGuards(AuthenticatedGuard)
export class AccountController {
  constructor(
    @Inject(AccountService) private readonly account: AccountService,
  ) {}

  @Get()
  me(@Caller() caller: AuthenticatedCaller): { user: AccountProfile } {
    return { user: this.account.profile(caller.user) };
  }

  @Get("tenants")
  tenants(@Caller() caller: AuthenticatedCaller): Promise<AccountTenants> {
    return this.account.tenantsOf(caller.userId);
  }
}
