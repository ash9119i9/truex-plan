import "reflect-metadata";
import { readFileSync, statSync } from "node:fs";
import { parseArgs } from "node:util";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../app.module";
import { DomainError } from "../common/domain-error";
import { ConfigError, loadConfig } from "../config/app-config";
import { loadEnvFileIfPresent } from "../config/env-file";
import { DatabaseService } from "../database/database.service";
import { parseWireId, toWireId } from "../database/object-id";
import { isRole } from "../modules/memberships/membership";
import {
  OperatorService,
  type AssignRoleCommand,
  type ProvisionTenantCommand,
} from "../modules/operator/operator.service";

// A definition file is a small JSON document; anything larger is a mistake.
const MAX_DEFINITION_BYTES = 1_000_000;
import type { TenantKind } from "../modules/tenants/tenant";

const USAGE = `Usage:
  operator provision-tenant --operator <name> --tenant <id> --name <name> --kind default|organization
  operator assign-role --operator <name> --user <id|email> --tenant <id> --role user|admin
  operator model-put --operator <name> --file <definition.json> [--allow-dev-credentials]
  operator model-enable|model-disable --operator <name> --slug <slug>
  operator model-list --operator <name>
  operator builtin-agent-put --operator <name> --file <definition.json>
  operator builtin-agent-enable|builtin-agent-disable --operator <name> --slug <slug>
  operator builtin-agent-list --operator <name>

Tenant IDs are 24-character lowercase hex ObjectIds. Re-running a command with
the same arguments is safe. Models are never deleted: disable them instead.
--allow-dev-credentials accepts a plaintext apiKey and an http loopback
baseUrl, for local development only.`;

// Long enough for a cold connection to a remote cluster.
const CONNECT_TIMEOUT_MS = 30_000;

export class UsageError extends Error {
  constructor(message: string) {
    super(`${message}\n\n${USAGE}`);
    this.name = "UsageError";
  }
}

type DefinitionCommand = {
  operator: string;
  file: string;
};

export type OperatorCommand =
  | ({ command: "provision-tenant" } & ProvisionTenantCommand)
  | ({ command: "assign-role" } & AssignRoleCommand)
  | ({
      command: "model-put";
      allowDevCredentials: boolean;
    } & DefinitionCommand)
  | ({ command: "builtin-agent-put" } & DefinitionCommand)
  | {
      command: "model-set-enabled" | "builtin-agent-set-enabled";
      operator: string;
      slug: string;
      enabled: boolean;
    }
  | { command: "model-list" | "builtin-agent-list"; operator: string };

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
        file: { type: "string" },
        slug: { type: "string" },
        "allow-dev-credentials": { type: "boolean" },
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
    case "model-put":
      return {
        command: "model-put",
        operator,
        file: required(values, "file"),
        allowDevCredentials: values["allow-dev-credentials"] === true,
      };
    case "builtin-agent-put":
      return {
        command: "builtin-agent-put",
        operator,
        file: required(values, "file"),
      };
    case "model-enable":
    case "model-disable":
      return {
        command: "model-set-enabled",
        operator,
        slug: required(values, "slug"),
        enabled: positionals[0] === "model-enable",
      };
    case "builtin-agent-enable":
    case "builtin-agent-disable":
      return {
        command: "builtin-agent-set-enabled",
        operator,
        slug: required(values, "slug"),
        enabled: positionals[0] === "builtin-agent-enable",
      };
    case "model-list":
    case "builtin-agent-list":
      return { command: positionals[0], operator };
    default:
      throw new UsageError(`Unknown command "${positionals[0]}".`);
  }
}

export function readDefinition(file: string): unknown {
  let text: string;
  try {
    if (statSync(file).size > MAX_DEFINITION_BYTES)
      throw new UsageError(`${file} is larger than 1 MB.`);
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(`Cannot read ${file}.`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new UsageError(`${file} is not valid JSON.`);
  }
}

// Runs one command and returns a printable summary with wire-format IDs.
// Nothing printed ever includes a credential.
export async function runOperatorCommand(
  operator: OperatorService,
  command: OperatorCommand,
  read: (file: string) => unknown = readDefinition,
): Promise<unknown> {
  switch (command.command) {
    case "model-put":
      return operator.putModel({
        operator: command.operator,
        definition: read(command.file),
        allowDevCredentials: command.allowDevCredentials,
      });
    case "builtin-agent-put":
      return operator.putBuiltinAgent({
        operator: command.operator,
        definition: read(command.file),
      });
    case "model-set-enabled":
      return operator.setModelEnabled(command);
    case "builtin-agent-set-enabled":
      return operator.setBuiltinAgentEnabled(command);
    case "model-list":
      return { models: await operator.listModels() };
    case "builtin-agent-list":
      return { builtinAgents: await operator.listBuiltinAgents() };
  }
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
    await app.get(DatabaseService).waitUntilConnected(CONNECT_TIMEOUT_MS);
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
