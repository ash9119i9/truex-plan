import { idCandidates } from "../persistence/configuration-documents";
import { errorFields, log } from "../../../shared/logging";
import type { Store } from "../persistence/store";
import {
  DEFAULT_TENANT_ID,
  effectivePrivacy,
  tenantDbName,
  tenantId,
  type TenantDocument,
} from "../tenancy/tenant";

// Public demo admission.
//
// One registered tenant, named by DEMO_TENANT_ID, may admit anyone with a
// Google account, and only while its registry record says admissionPolicy
// "open". Everything here fails closed: a missing variable, a missing or
// disabled tenant, a shared database, a missing index or a missing limit
// means nobody is enrolled. DEMO_TENANT_ID names a tenant, never a database,
// and never falls back to the implicit "default" tenant.

export interface DemoConfig {
  tenantId: string;
  /** New turns per person per UTC day. */
  turnsPerUser: number;
  /** New turns across the whole demo per UTC day; unset blocks admission. */
  turnsGlobal?: number;
  /** New accounts per UTC day; unset blocks admission. */
  signupsPerDay?: number;
}

const positive = (name: string, value: string | undefined, max: number) => {
  if (value === undefined || value.trim() === "") return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max)
    throw new Error(`${name} must be a whole number from 1 to ${max}.`);
  return n;
};

/** undefined when the demo is not enabled. Throws on an invalid value. */
export function demoConfig(
  env: NodeJS.ProcessEnv = process.env,
): DemoConfig | undefined {
  const raw = env.DEMO_TENANT_ID?.trim();
  if (!raw) return undefined;
  const id = tenantId(raw);
  if (id === DEFAULT_TENANT_ID)
    throw new Error(
      'DEMO_TENANT_ID cannot be "default": the implicit default tenant may hold existing data. Provision a fresh demo tenant.',
    );
  return {
    tenantId: id,
    turnsPerUser:
      positive(
        "DEMO_DAILY_TURNS_PER_USER",
        env.DEMO_DAILY_TURNS_PER_USER,
        100_000,
      ) ?? 50,
    turnsGlobal: positive(
      "DEMO_DAILY_TURNS_GLOBAL",
      env.DEMO_DAILY_TURNS_GLOBAL,
      100_000_000,
    ),
    signupsPerDay: positive(
      "DEMO_DAILY_SIGNUPS",
      env.DEMO_DAILY_SIGNUPS,
      10_000_000,
    ),
  };
}

export interface DemoReadiness {
  /** Everything needed to admit people is in place. */
  ready: boolean;
  /** Stable codes, safe to expose on a health endpoint. */
  problems: string[];
}

const indexName = (indexes: { name?: string }[]) =>
  new Set(indexes.map((i) => i.name));

/**
 * What must hold before the demo may admit anyone. `requireOpen: false` is the
 * pre-flight form: everything except the admission switch itself.
 */
export async function demoReadiness(
  store: Store,
  config: DemoConfig,
  options: { authMode: string; requireOpen?: boolean },
): Promise<DemoReadiness> {
  const problems: string[] = [];
  if (options.authMode !== "google") problems.push("AUTH_MODE_NOT_GOOGLE");
  if (config.turnsGlobal === undefined)
    problems.push("DEMO_DAILY_TURNS_GLOBAL_UNSET");
  if (config.signupsPerDay === undefined)
    problems.push("DEMO_DAILY_SIGNUPS_UNSET");
  try {
    if (!(await store.supportsTransactions()))
      problems.push("TRANSACTIONS_UNAVAILABLE");
  } catch {
    problems.push("TRANSACTIONS_UNAVAILABLE");
  }

  const doc: TenantDocument | null = await store.tenantRegistry.findOne({
    _id: config.tenantId,
  });
  if (!doc) return { ready: false, problems: [...problems, "TENANT_MISSING"] };
  if (doc.status !== "active") problems.push("TENANT_DISABLED");

  // The generated database name, owned by this tenant alone and separate from
  // the catalog and the default tenant's database.
  if (doc.dbName !== tenantDbName(config.tenantId))
    problems.push("DB_NAME_MISMATCH");
  if (doc.dbName === store.catalogDatabase || doc.dbName === store.database)
    problems.push("DB_SHARED");
  const sharing = await store.tenantRegistry.countDocuments({
    dbName: doc.dbName,
    _id: { $ne: doc._id },
  });
  if (sharing) problems.push("DB_NOT_UNIQUE");

  const privacy = effectivePrivacy(doc);
  if (privacy.invalid) problems.push("PRIVACY_INVALID");
  else if (privacy.isUserSpecific !== true)
    problems.push("PRIVACY_NOT_USER_SPECIFIC");
  if (options.requireOpen !== false && doc.admissionPolicy !== "open")
    problems.push("ADMISSION_NOT_OPEN");

  // The demo gets models and skills by explicit approval only.
  const models = doc.allowedModelIds;
  if (!Array.isArray(models) || !models.length)
    problems.push("MODELS_NOT_ALLOW_LISTED");
  else {
    const found = await store.profiles
      .find(
        { _id: { $in: models.flatMap(idCandidates) }, enabled: { $ne: false } },
        { projection: { _id: 1 } },
      )
      .toArray();
    if (new Set(found.map((m) => String(m._id))).size !== new Set(models).size)
      problems.push("MODEL_UNAVAILABLE");
  }
  if (!Array.isArray(doc.allowedSkillIds))
    problems.push("SKILLS_NOT_ALLOW_LISTED");

  // Owner-aware agent handles, and no workspace-wide handle index.
  const db = store.client.db(doc.dbName);
  const list = async (collection: string) =>
    indexName(
      await db
        .collection(collection)
        .indexes()
        .catch(() => []),
    );
  const agentIndexes = await list("truex_agents");
  if (!agentIndexes.has("agent_creator_handle"))
    problems.push("INDEX_MISSING:agent_creator_handle");
  if (agentIndexes.has("handle_1"))
    problems.push("GLOBAL_HANDLE_INDEX_PRESENT");
  if (!(await list("sessions")).has("userId_1_createdAt_-1"))
    problems.push("INDEX_MISSING:sessions_user");
  if (!(await list("truex_mcp")).has("user_mcp_name"))
    problems.push("INDEX_MISSING:user_mcp_name");

  return { ready: problems.length === 0, problems };
}

export type DemoAdmission =
  /** DEMO_TENANT_ID is not set. */
  | { state: "off" }
  /** Configured, but the tenant does not currently admit by open signup. */
  | { state: "closed" }
  /** Configured and meant to be open, but something is missing. */
  | { state: "unavailable"; problems: string[] }
  | { state: "open"; tenant: TenantDocument; config: DemoConfig };

// How long an answer is reused (DEMO_CACHE_MS caps the positive one; a negative
// answer is reused for at most a fifth of that, and never longer than 5 s).
export function cacheMs(env: NodeJS.ProcessEnv = process.env) {
  const raw = env.DEMO_CACHE_MS?.trim();
  // Blank (a copied .env.example line) means the default, not "no caching".
  if (!raw) return 30_000;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0
    ? Math.min(value, 300_000)
    : 30_000;
}

/**
 * The one place enrolment asks "may this person be added to the demo, and
 * where". A positive answer is reused for a short while; a negative one is
 * rechecked sooner, so fixing a problem or closing admission takes effect
 * within seconds, and closing it is never delayed by a cached "open".
 */
export class DemoGate {
  private cached?: { at: number; value: DemoAdmission };
  private readonly readyMs = cacheMs();
  private readonly notReadyMs = Math.min(5_000, Math.floor(this.readyMs / 5));
  constructor(
    private readonly store: Store,
    readonly config: DemoConfig | undefined,
    private readonly authMode: string,
  ) {}

  get enabled() {
    return !!this.config;
  }
  /** True for the tenant that carries the demo's public limits. */
  isDemoTenant(id: string) {
    return !!this.config && this.config.tenantId === id;
  }

  async readiness(requireOpen = true): Promise<DemoReadiness | undefined> {
    if (!this.config) return undefined;
    return demoReadiness(this.store, this.config, {
      authMode: this.authMode,
      requireOpen,
    });
  }

  async admission(): Promise<DemoAdmission> {
    if (!this.config) return { state: "off" };
    const hit = this.cached;
    if (
      hit &&
      Date.now() - hit.at <
        (hit.value.state === "open" ? this.readyMs : this.notReadyMs)
    ) {
      // An "open" answer is only trusted while the registry still agrees.
      if (hit.value.state !== "open") return hit.value;
      const current = await this.store.tenantRegistry.findOne(
        { _id: this.config.tenantId },
        { projection: { admissionPolicy: 1, status: 1 } },
      );
      if (current?.admissionPolicy === "open" && current.status === "active")
        return hit.value;
    }
    const value = await this.compute(this.config);
    this.cached = { at: Date.now(), value };
    return value;
  }

  private async compute(config: DemoConfig): Promise<DemoAdmission> {
    try {
      const doc = await this.store.tenantRegistry.findOne({
        _id: config.tenantId,
      });
      // Closed on purpose: not registered, disabled, or not set to open.
      if (doc && (doc.status !== "active" || doc.admissionPolicy !== "open"))
        return { state: "closed" };
      const readiness = await this.readiness();
      if (!readiness?.ready || !doc) {
        const problems = readiness?.problems ?? ["TENANT_MISSING"];
        log("error", "demo admission unavailable", {
          tenantId: config.tenantId,
          problems: problems.join(","),
        });
        return { state: "unavailable", problems };
      }
      return { state: "open", tenant: doc, config };
    } catch (error) {
      log("error", "demo admission check failed", {
        tenantId: config.tenantId,
        ...errorFields(error),
      });
      return { state: "unavailable", problems: ["CHECK_FAILED"] };
    }
  }
}
