import { Inject, Injectable } from "@nestjs/common";
import type { Collection, ObjectId } from "mongodb";
import type { TenantContext } from "../../common/access/tenant.guard";
import { DomainError } from "../../common/domain-error";
import { integer, invalid, objectWith } from "../../common/validation";
import { DatabaseService } from "../../database/database.service";
import { isDuplicateKeyError } from "../../database/mongo-errors";
import { AuditService } from "../audit/audit.service";
import { MembershipsService } from "../memberships/memberships.service";
import { egressHosts } from "./network-host";

// The tenant admin host allowlist (decision 3): hosts that need no token,
// such as a company API, which sandbox commands in this tenant may reach.
// One document in the tenant's own database. Private addresses stay refused
// whatever the list says (network-host.ts, and the proxy at connect time).
export const TENANT_SETTINGS_COLLECTION = "tenant_settings";
const NETWORK_ID = "network";
export const MAX_TENANT_HOSTS = 50;

// Runs read the list through this cache, so a coding run costs no extra
// round trip; an admin change reaches other processes within this time.
export const TENANT_NETWORK_CACHE_TTL_MS = 30_000;
// Bounds the cache; a tenant evicted early is just read again.
const MAX_CACHED_TENANTS = 1000;

interface TenantNetworkDoc {
  _id: typeof NETWORK_ID;
  hosts: string[];
  revision: number;
  updatedAt: Date;
  updatedBy: ObjectId;
}

export interface TenantNetworkView {
  hosts: string[];
  // 0 before the first save.
  revision: number;
  updatedAt?: string;
}

export interface UpdateTenantNetwork {
  hosts: string[];
  // The revision the admin edited, so two admins cannot overwrite each other.
  revision: number;
}

export function parseUpdateTenantNetwork(body: unknown): UpdateTenantNetwork {
  const raw = objectWith(body, ["hosts", "revision"], "The request body");
  if (raw.revision === undefined) invalid("revision is required.");
  return {
    hosts: egressHosts(raw.hosts, "hosts", MAX_TENANT_HOSTS).sort(),
    revision: integer(raw.revision, "revision", 0, Number.MAX_SAFE_INTEGER),
  };
}

function viewOf(doc: TenantNetworkDoc | null): TenantNetworkView {
  if (!doc) return { hosts: [], revision: 0 };
  return {
    hosts: [...doc.hosts],
    revision: doc.revision,
    updatedAt: doc.updatedAt.toISOString(),
  };
}

@Injectable()
export class TenantNetworkService {
  private readonly cache = new Map<
    string,
    { hosts: readonly string[]; expires: number }
  >();

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(MembershipsService)
    private readonly memberships: MembershipsService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  private settings(dbName: string): Collection<TenantNetworkDoc> {
    return this.database
      .tenantDb(dbName)
      .collection<TenantNetworkDoc>(TENANT_SETTINGS_COLLECTION);
  }

  async get(context: TenantContext): Promise<TenantNetworkView> {
    return viewOf(
      await this.settings(context.dbName).findOne({ _id: NETWORK_ID }),
    );
  }

  // The tenant's hosts for a run, possibly up to the cache TTL old.
  async runHosts(dbName: string): Promise<readonly string[]> {
    const now = Date.now();
    const cached = this.cache.get(dbName);
    if (cached && cached.expires > now) return cached.hosts;
    const doc = await this.settings(dbName).findOne(
      { _id: NETWORK_ID },
      { projection: { hosts: 1 } },
    );
    const hosts = Object.freeze([...(doc?.hosts ?? [])]);
    if (this.cache.size >= MAX_CACHED_TENANTS) this.cache.clear();
    this.cache.set(dbName, {
      hosts,
      expires: now + TENANT_NETWORK_CACHE_TTL_MS,
    });
    return hosts;
  }

  // Admins only, with the role read now: the context's role can come from an
  // access token minutes old, and a demoted admin must not widen the network.
  async update(
    context: TenantContext,
    input: UpdateTenantNetwork,
    requestId: string,
  ): Promise<TenantNetworkView> {
    const membership = await this.memberships.findActive(
      context.userId,
      context.tenantId,
    );
    if (membership?.role !== "admin") {
      await this.audit.record({
        action: "tenant.network.update",
        actor: { kind: "user", userId: context.userId },
        result: "denied",
        tenantId: context.tenantId,
        reason: "not_admin",
        requestId,
      });
      throw new DomainError(
        "FORBIDDEN",
        "Only a workspace admin can change the allowed sites.",
      );
    }
    const settings = this.settings(context.dbName);
    const current = await settings.findOne({ _id: NETWORK_ID });
    const revision = current?.revision ?? 0;
    if (revision !== input.revision)
      throw new DomainError(
        "STALE_REVISION",
        "Someone else changed the allowed sites. Reload and try again.",
      );
    if (current && sameHosts(current.hosts, input.hosts))
      return viewOf(current);
    const now = new Date();
    const next: TenantNetworkDoc = {
      _id: NETWORK_ID,
      hosts: input.hosts,
      revision: revision + 1,
      updatedAt: now,
      updatedBy: context.userId,
    };
    // Insert for the first save, compare-and-set after: a racing writer
    // either hits the duplicate key or misses the revision filter.
    const written = current
      ? await settings.findOneAndReplace({ _id: NETWORK_ID, revision }, next, {
          returnDocument: "after",
        })
      : await settings.insertOne(next).then(
          () => next,
          (error: unknown) => {
            if (isDuplicateKeyError(error)) return null;
            throw error;
          },
        );
    if (!written)
      throw new DomainError(
        "STALE_REVISION",
        "Someone else changed the allowed sites. Reload and try again.",
      );
    this.cache.delete(context.dbName);
    const before = new Set(current?.hosts ?? []);
    const after = new Set(input.hosts);
    await this.audit.record({
      action: "tenant.network.update",
      actor: { kind: "user", userId: context.userId },
      result: "success",
      tenantId: context.tenantId,
      requestId,
      details: {
        revision: next.revision,
        hosts: input.hosts.length,
        added: input.hosts
          .filter((h) => !before.has(h))
          .join(",")
          .slice(0, 2000),
        removed: [...before]
          .filter((h) => !after.has(h))
          .join(",")
          .slice(0, 2000),
      },
    });
    return viewOf(written);
  }
}

function sameHosts(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((host, i) => host === b[i]);
}
