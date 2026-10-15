import "reflect-metadata";
import { parseArgs } from "node:util";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../app.module";
import { DomainError } from "../common/domain-error";
import { ConfigError, loadConfig } from "../config/app-config";
import { loadEnvFileIfPresent } from "../config/env-file";
import { parseWireId, toWireId } from "../database/object-id";
import { isRole } from "../modules/memberships/membership";
import {
  OperatorService,
  type AssignRoleCommand,
  type ProvisionTenantCommand,
} from "../modules/operator/operator.service";
import type { TenantKind } from "../modules/tenants/tenant";

const USAGE = `Usage:
  operator provision-tenant --operator <name> --tenant <id> --name <name> --kind default|organization
  operator assign-role --operator <name> --user <id|email> --tenant <id> --role user|admin

Tenant IDs are 24-character lowercase hex ObjectIds. Re-running a command with
the same arguments is safe.`;

export class UsageError extends Error {
  constructor(message: string) {
    super(`${message}\n\n${USAGE}`);
    this.name = "UsageError";
  }
}

export type OperatorCommand =
  | ({ command: "provision-tenant" } & ProvisionTenantCommand)
  | ({ command: "assign-role" } & AssignRoleCommand);

function required(values: Record<string, unknown>, flag: string): string {
  const value = values[flag];
  if (typeof value !== "string" || value.trim() === "")
    throw new UsageError(`--${flag} is required.`);
  return value.trim();
}

function tenantIdOf(values: Record<string, unknown>) {
  const tenantId = parseWireId(required(values, "tenant"));
  if (!tenantId)
    throw new UsageError("--tenant must be a 24-character lowercase hex ID.");
  return tenantId;
}

export function parseOperatorCommand(argv: readonly string[]): OperatorCommand {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        operator: { type: "string" },
        tenant: { type: "string" },
        name: { type: "string" },
        kind: { type: "string" },
        user: { type: "string" },
        role: { type: "string" },
      },
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : "Bad flags.");
  }
  const { values, positionals } = parsed;
  if (positionals.length !== 1)
    throw new UsageError("Give exactly one command.");
  const operator = required(values, "operator");

  switch (positionals[0]) {
    case "provision-tenant": {
      const kind = required(values, "kind");
      if (kind !== "default" && kind !== "organization")
        throw new UsageError('--kind must be "default" or "organization".');
      return {
        command: "provision-tenant",
        operator,
        tenantId: tenantIdOf(values),
        name: required(values, "name"),
        kind: kind satisfies TenantKind,
      };
    }
    case "assign-role": {
      const role = required(values, "role");
      if (!isRole(role))
        throw new UsageError('--role must be "user" or "admin".');
      return {
        command: "assign-role",
        operator,
        user: required(values, "user"),
        tenantId: tenantIdOf(values),
        role,
      };
    }
    default:
      throw new UsageError(`Unknown command "${positionals[0]}".`);
  }
}

// Runs one command and returns a printable summary with wire-format IDs.
export async function runOperatorCommand(
  operator: OperatorService,
  command: OperatorCommand,
): Promise<Record<string, unknown>> {
  if (command.command === "provision-tenant") {
    const tenant = await operator.provisionTenant(command);
    return {
      tenantId: toWireId(tenant._id),
      name: tenant.name,
      kind: tenant.kind,
      dbName: tenant.dbName,
      provisioningStatus: tenant.provisioningStatus,
    };
  }
  const { user, membership, previousRole } = await operator.assignRole(command);
  return {
    userId: toWireId(user._id),
    email: user.email,
    tenantId: toWireId(membership.tenantId),
    role: membership.role,
    previousRole,
  };
}

async function main(): Promise<void> {
  const command = parseOperatorCommand(process.argv.slice(2));
  loadEnvFileIfPresent();
  const config = loadConfig(process.env);
  const app = await NestFactory.createApplicationContext(
    AppModule.forRoot(config),
    { abortOnError: false, logger: ["error", "warn"] },
  );
  try {
    const result = await runOperatorCommand(app.get(OperatorService), command);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await app.close();
  }
}

if (require.main === module)
  main().catch((error: unknown) => {
    const known =
      error instanceof UsageError ||
      error instanceof ConfigError ||
      error instanceof DomainError;
    console.error(known ? error.message : error);
    process.exitCode = 1;
  });
