import "reflect-metadata";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../app.module";
import { DomainError } from "../common/domain-error";
import { ConfigError, loadConfig } from "../config/app-config";
import { loadEnvFileIfPresent } from "../config/env-file";
import { DatabaseService } from "../database/database.service";
import { parseWireId, toWireId } from "../database/object-id";
import {
  parseConnectorSpec,
  type ConnectorSpec,
} from "../modules/connectors/connector";
import {
  probeConnector,
  type ProbeOptions,
  type ProbeReport,
} from "../modules/connectors/connector-probe";
import { isRole } from "../modules/memberships/membership";
import {
  OperatorService,
  type AssignRoleCommand,
  type EnsureTenantIndexesCommand,
  type FollowUpsReportCommand,
  type HelpersReportCommand,
  type ProvisionTenantCommand,
} from "../modules/operator/operator.service";
import { toolchainPackages } from "../modules/skills/skill-bundle";

// A definition file is a small JSON document; anything larger is a mistake.
const MAX_DEFINITION_BYTES = 1_000_000;
import type { TenantKind } from "../modules/tenants/tenant";

const USAGE = `Usage:
  operator provision-tenant --operator <name> --tenant <id> --name <name> --kind default|organization
  operator assign-role --operator <name> --user <id|email> --tenant <id> --role user|admin
  operator ensure-tenant-indexes --operator <name> --tenant <id> | --all
  operator model-put --operator <name> --file <definition.json> [--allow-dev-credentials]
  operator model-enable|model-disable --operator <name> --slug <slug>
  operator model-list --operator <name>
  operator builtin-agent-put --operator <name> --file <definition.json>
  operator builtin-agent-enable|builtin-agent-disable --operator <name> --slug <slug>
  operator builtin-agent-list --operator <name>
  operator connector-put --operator <name> --file <definition.json>
  operator connector-enable|connector-disable --operator <name> --slug <slug>
  operator connector-list --operator <name>
  operator connector-probe --operator <name> --url <mcp url> [--token <file>] [--file <definition.json>] [--allow-loopback]
  operator skill-put --operator <name> --folder <skill folder> [--toolchain <requirements.in>]
  operator skill-enable|skill-disable --operator <name> --slug <slug>
  operator skill-list --operator <name>
  operator followups-report --operator <name> [--since 7d] [--tenant <id>] [--min-sets 200] [--close 0.6]
  operator helpers-report --operator <name> [--since 7d] [--tenant <id>]

Tenant IDs are 24-character lowercase hex ObjectIds. Re-running a command with
the same arguments is safe. Models are never deleted: disable them instead.
ensure-tenant-indexes --all builds the indexes of every provisioned tenant
behind this release; run it as a deploy step after an index change.
followups-report prints counts and rates only (never message text). --since
takes d, h or m (default 7d); --min-sets hides small cells; --close sets the
word-overlap threshold for "typed something close" (default 0.6).
connector-probe reports an MCP server's OAuth discovery and the client
registration modes it supports, without the database. With --token (a file
holding a test account's access token, never printed) it lists the tools and
drafts allowedTools, writeTools and toolHashes for a person to review; --file
limits the draft to an existing definition's allowedTools. It never calls a
tool. --allow-loopback accepts an http loopback server, for local fixtures.
helpers-report prints helper-agent counts, rates, latency and tokens for
chats whose agent allowed helpers (never a helper's task or result).
--allow-dev-credentials accepts a plaintext apiKey and an http loopback
baseUrl, for local development only.
skill-put publishes the folder as the skill's newest version (new chats get it
within a minute; existing chats keep theirs). --toolchain lists the Python
packages the runtime image ships; it defaults to the repository's
runtime-adapter/toolchain/requirements.in.`;

// The repository's toolchain list, from src/cli or dist/cli.
const DEFAULT_TOOLCHAIN = join(
  __dirname,
  "..",
  "..",
  "..",
  "runtime-adapter",
  "toolchain",
  "requirements.in",
);

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
  | ({ command: "ensure-tenant-indexes" } & EnsureTenantIndexesCommand)
  | ({
      command: "model-put";
      allowDevCredentials: boolean;
    } & DefinitionCommand)
  | ({ command: "builtin-agent-put" } & DefinitionCommand)
  | ({ command: "connector-put" } & DefinitionCommand)
  | {
      command: "skill-put";
      operator: string;
      folder: string;
      // Null: the default list.
      toolchain: string | null;
    }
  | {
      command: "model-set-enabled" | "builtin-agent-set-enabled";
      operator: string;
      slug: string;
      enabled: boolean;
    }
  | {
      command: "connector-set-enabled" | "skill-set-enabled";
      operator: string;
      slug: string;
      enabled: boolean;
    }
  | {
      command:
        "model-list" | "builtin-agent-list" | "connector-list" | "skill-list";
      operator: string;
    }
  | ({ command: "followups-report" } & FollowUpsReportCommand)
  | ({ command: "helpers-report" } & HelpersReportCommand)
  | ConnectorProbeCommand;

export interface ConnectorProbeCommand {
  command: "connector-probe";
  operator: string;
  url: string;
  // Null: discovery only, no tool list.
  tokenFile: string | null;
  // Null: draft every listed tool.
  definitionFile: string | null;
  allowLoopback: boolean;
}

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
        folder: { type: "string" },
        toolchain: { type: "string" },
        slug: { type: "string" },
        all: { type: "boolean" },
        "allow-dev-credentials": { type: "boolean" },
        url: { type: "string" },
        token: { type: "string" },
        "allow-loopback": { type: "boolean" },
        since: { type: "string" },
        "min-sets": { type: "string" },
        close: { type: "string" },
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
    case "ensure-tenant-indexes": {
      const all = values.all === true;
      if (all === (values.tenant !== undefined))
        throw new UsageError("Give either --tenant <id> or --all.");
      return all
        ? { command: "ensure-tenant-indexes", operator }
        : {
            command: "ensure-tenant-indexes",
            operator,
            tenantId: tenantIdOf(values),
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
    case "connector-put":
      return {
        command: "connector-put",
        operator,
        file: required(values, "file"),
      };
    case "connector-enable":
    case "connector-disable":
      return {
        command: "connector-set-enabled",
        operator,
        slug: required(values, "slug"),
        enabled: positionals[0] === "connector-enable",
      };
    case "skill-put":
      return {
        command: "skill-put",
        operator,
        folder: required(values, "folder"),
        toolchain:
          values.toolchain === undefined ? null : required(values, "toolchain"),
      };
    case "skill-enable":
    case "skill-disable":
      return {
        command: "skill-set-enabled",
        operator,
        slug: required(values, "slug"),
        enabled: positionals[0] === "skill-enable",
      };
    case "model-list":
    case "builtin-agent-list":
    case "connector-list":
    case "skill-list":
      return { command: positionals[0], operator };
    case "connector-probe":
      return {
        command: "connector-probe",
        operator,
        url: required(values, "url"),
        tokenFile: typeof values.token === "string" ? values.token : null,
        definitionFile: typeof values.file === "string" ? values.file : null,
        allowLoopback: values["allow-loopback"] === true,
      };
    case "followups-report": {
      const sinceMs = sinceMsOf(values.since);
      const minSets = positiveInt(values["min-sets"], "min-sets", 200);
      const close = fraction(values.close, "close", 0.6);
      return {
        command: "followups-report",
        operator,
        since: new Date(Date.now() - sinceMs),
        ...(values.tenant !== undefined
          ? { tenantId: tenantIdOf(values) }
          : {}),
        minSets,
        close,
      };
    }
    case "helpers-report":
      return {
        command: "helpers-report",
        operator,
        since: new Date(Date.now() - sinceMsOf(values.since)),
        ...(values.tenant !== undefined
          ? { tenantId: tenantIdOf(values) }
          : {}),
      };
    default:
      throw new UsageError(`Unknown command "${positionals[0]}".`);
  }
}

// DURATION: 7d, 24h or 30m. The plan uses days; hours and minutes keep a
// quick check against the dev database practical.
export function durationMs(value: string | undefined): number {
  if (value === undefined) return 7 * 24 * 60 * 60_000;
  const match = /^(\d{1,4})([dhm])$/.exec(value);
  if (!match) throw new UsageError("--since must look like 7d, 24h or 30m.");
  const amount = Number(match[1]);
  if (amount < 1)
    throw new UsageError("--since must be at least 1d, 1h or 1m.");
  const unit =
    match[2] === "d" ? 86_400_000 : match[2] === "h" ? 3_600_000 : 60_000;
  const ms = amount * unit;
  if (ms > 366 * 86_400_000)
    throw new UsageError("--since must be at most 366 days.");
  return ms;
}

function sinceMsOf(value: unknown): number {
  return durationMs(typeof value === "string" ? value : undefined);
}

function positiveInt(value: unknown, flag: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (
    typeof value !== "string" ||
    !/^\d{1,6}$/.test(value) ||
    Number(value) < 1
  )
    throw new UsageError(`--${flag} must be a whole number of at least 1.`);
  return Number(value);
}

function fraction(value: unknown, flag: string, fallback: number): number {
  if (value === undefined) return fallback;
  const number =
    typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  if (!Number.isFinite(number) || number < 0 || number > 1)
    throw new UsageError(`--${flag} must be a number from 0 to 1.`);
  return number;
}

// A token file holds one access token for a test account. Its content is
// never echoed, not even in an error.
const MAX_TOKEN_FILE_BYTES = 16 * 1024;
const TOKEN = /^[\x21-\x7e]{1,8192}$/;

export function readTokenFile(file: string): string {
  let text: string;
  try {
    if (statSync(file).size > MAX_TOKEN_FILE_BYTES)
      throw new UsageError(`${file} is larger than 16 KB.`);
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(`Cannot read ${file}.`);
  }
  const token = text.trim();
  if (!TOKEN.test(token))
    throw new UsageError(
      `${file} must hold one access token on a single line.`,
    );
  return token;
}

// Probes the server for the operator. With a definition, the draft is limited
// to its allowedTools and sends its fixed headers; its url must be the one
// probed, or the hashes would be drafted for a different server.
export async function runConnectorProbe(
  command: ConnectorProbeCommand,
  read: (file: string) => unknown = readDefinition,
  readToken: (file: string) => string = readTokenFile,
  probe: (options: ProbeOptions) => Promise<ProbeReport> = probeConnector,
): Promise<ProbeReport> {
  let spec: ConnectorSpec | undefined;
  if (command.definitionFile) {
    spec = parseConnectorSpec(read(command.definitionFile));
    if (spec.url !== command.url)
      throw new UsageError(`--url must be the definition's url (${spec.url}).`);
  }
  return probe({
    url: command.url,
    allowLoopback: command.allowLoopback,
    ...(command.tokenFile ? { accessToken: readToken(command.tokenFile) } : {}),
    ...(spec?.allowedTools ? { allowedTools: spec.allowedTools } : {}),
    ...(spec ? { fixedHeaders: spec.fixedHeaders } : {}),
  });
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

// The Python packages a skill's scripts may import. An explicit file must
// be readable; without one, a missing default list means none are known.
export function readToolchain(file: string | null): Set<string> | null {
  try {
    return toolchainPackages(readFileSync(file ?? DEFAULT_TOOLCHAIN, "utf8"));
  } catch {
    if (file) throw new UsageError(`Cannot read ${file}.`);
    return null;
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
    case "connector-put":
      return operator.putConnector({
        operator: command.operator,
        definition: read(command.file),
      });
    case "connector-set-enabled":
      return operator.setConnectorEnabled(command);
    case "connector-list":
      return { connectors: await operator.listConnectors() };
    case "skill-put":
      return operator.putSkill({
        operator: command.operator,
        folder: command.folder,
        toolchain: readToolchain(command.toolchain),
      });
    case "skill-set-enabled":
      return operator.setSkillEnabled(command);
    case "skill-list":
      return { skills: await operator.listSkills() };
  }
  if (command.command === "connector-probe")
    return runConnectorProbe(command, read);
  if (command.command === "followups-report")
    return operator.followUpsReport(command);
  if (command.command === "helpers-report")
    return operator.helpersReport(command);
  if (command.command === "ensure-tenant-indexes") {
    const tenants = await operator.ensureTenantIndexes(command);
    return {
      tenants: tenants.map((tenant) => ({
        tenantId: toWireId(tenant._id),
        dbName: tenant.dbName,
        indexVersion: tenant.indexVersion,
      })),
    };
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
  // The probe only talks to the MCP server: no config, no database.
  if (command.command === "connector-probe") {
    console.log(JSON.stringify(await runConnectorProbe(command), null, 2));
    return;
  }
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
