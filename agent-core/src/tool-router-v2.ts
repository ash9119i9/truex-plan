import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

/** Schema metadata only. Credentials and permission decisions belong outside this registry. */
export interface RegisteredTool {
  id: string;
  serverId: string;
  serverName?: string;
  toolName: string;
  sourceType: "mcp" | "native";
  inputSchema: Record<string, unknown>;
  name?: string;
  source?: "mcp" | "native";
  tenantId?: string;
  scope?: "tenant" | "global";
  description?: string;
  vendor?: string;
  tags?: string[];
  aliases?: string[];
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  enabled?: boolean;
  available?: boolean;
  mandatory?: boolean;
  readOnly?: boolean;
  destructive?: boolean;
  requiresApproval?: boolean;
  bindingName?: string;
  configVersion?: string;
}
export interface RoutingContext {
  recentServerIds?: string[];
  recentToolIds?: string[];
  /** Explicit agent attachments; native tools do not belong to MCP servers. */
  allowedServerIds?: string[];
  activeServerId?: string;
  activeEntities?: {
    kind?: string;
    serverId: string;
    id?: string;
    guid?: string;
    name?: string;
    stream?: string;
  }[];
  registryState?: "initializing" | "ready" | "degraded" | "failed";
  unavailableServerIds?: string[];
}
export interface RoutingRequest {
  query: string;
  tenantId: string;
  userId: string;
  conversationContext?: string;
  context?: RoutingContext;
  maxTools?: number;
}
export interface ToolCandidate {
  tool: RegisteredTool;
  score: number;
  reason: string;
  queryScores?: { query: string; score: number }[];
}
export interface RoutePlan {
  query: string;
  mode: "no_tools" | "direct_tools" | "discovery";
  /** A deterministic retrieval score, NOT a probability of correctness. */
  confidence: number;
  candidates: ToolCandidate[];
  selected: RegisteredTool[];
  fallbackReason?: string;
  authorizationRemoved: string[];
  routingLatencyMs: number;
  /** Additive diagnostics; no permission decision or probability is cached. */
  exposedBindings?: string[];
  thresholds?: RoutingThresholds;
  fallbackCode?:
    | "registry_unavailable"
    | "missing_task_coverage"
    | "task_budget_exceeded"
    | "ambiguous_task_server"
    | "task_confidence_below_threshold";
  task?: {
    kind: "app_explanation";
    serverId: string;
    requiredTools: string[];
    missingTools: string[];
  };
  taskRetrieval?: {
    originalQuery: string;
    expandedQuery: string;
    anchorToolId: string;
    originalAnchorScore: number;
    expandedAnchorScore: number;
    originalBestScore: number;
    expandedBestScore: number;
    reason: string;
  };
  retrievalIndex?: {
    startedAt: string;
    completedAt: string;
    durationMs: number;
    toolCount: number;
    cacheHits?: number;
    cacheMisses?: number;
    queryCount?: number;
  };
}
export type ToolAuthorizer = (
  tool: RegisteredTool,
  request: RoutingRequest,
) => boolean | Promise<boolean>;
export interface ToolRetriever {
  retrieve(request: RoutingRequest, tools: RegisteredTool[]): ToolCandidate[];
  /** Purges descriptor/index metadata; must not store permission decisions. */
  invalidate?(): void;
}
export interface RoutingThresholds {
  highConfidenceThreshold: number;
  ambiguityMargin: number;
}
export interface ToolRouterOptions extends Partial<RoutingThresholds> {
  topK?: number;
  retriever?: ToolRetriever;
}

const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
function normalizeTool(tool: RegisteredTool): RegisteredTool {
  if (
    !record(tool) ||
    [tool.id, tool.serverId, tool.toolName].some(
      (value) => typeof value !== "string" || !value.trim(),
    ) ||
    !["mcp", "native"].includes(tool.sourceType) ||
    !record(tool.inputSchema)
  )
    throw new Error("Invalid tool registry metadata");
  if (
    (tool.name !== undefined && tool.name !== tool.toolName) ||
    (tool.source !== undefined && tool.source !== tool.sourceType)
  )
    throw new Error("Conflicting normalized tool aliases");
  const scope = tool.scope || "tenant";
  if (scope === "tenant" && !tool.tenantId)
    throw new Error("Tenant-scoped tools require tenantId");
  if (
    !["tenant", "global"].includes(scope) ||
    (scope === "global" && tool.sourceType !== "native")
  )
    throw new Error(
      "Only explicitly global native schemas may cross tenant boundaries",
    );
  if (
    tool.bindingName !== undefined &&
    !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(tool.bindingName)
  )
    throw new Error("Invalid tool binding name");
  // Whitelist descriptors rather than retaining an accidental MCP auth/config object.
  const normalized: RegisteredTool = {
    id: tool.id,
    serverId: tool.serverId,
    toolName: tool.toolName,
    sourceType: tool.sourceType,
    name: tool.toolName,
    source: tool.sourceType,
    inputSchema: structuredClone(tool.inputSchema),
    scope,
    enabled: tool.enabled !== false,
    available: tool.available !== false,
    ...(scope === "tenant" ? { tenantId: tool.tenantId } : {}),
  };
  for (const field of [
    "description",
    "serverName",
    "vendor",
    "bindingName",
    "configVersion",
  ] as const) {
    if (tool[field] !== undefined) {
      if (typeof tool[field] !== "string")
        throw new Error(`Invalid ${field} metadata`);
      normalized[field] = tool[field];
    }
  }
  for (const field of [
    "enabled",
    "available",
    "mandatory",
    "readOnly",
    "destructive",
    "requiresApproval",
  ] as const) {
    if (tool[field] !== undefined) {
      if (typeof tool[field] !== "boolean")
        throw new Error(`Invalid ${field} metadata`);
      normalized[field] = tool[field];
    }
  }
  for (const field of ["tags", "aliases"] as const) {
    if (tool[field] !== undefined) {
      if (
        !Array.isArray(tool[field]) ||
        tool[field]!.some((value) => typeof value !== "string")
      )
        throw new Error(`Invalid ${field} metadata`);
      normalized[field] = [...new Set(tool[field])];
    }
  }
  for (const field of ["outputSchema", "annotations"] as const) {
    if (tool[field] !== undefined) {
      if (!record(tool[field])) throw new Error(`Invalid ${field} metadata`);
      normalized[field] = structuredClone(tool[field]);
    }
  }
  return normalized;
}
const registryKey = (tool: RegisteredTool) =>
  JSON.stringify([tool.scope, tool.tenantId || "", tool.id]);

/** Replacements are atomic; every metadata/config mutation bumps revision. No auth cache exists. */
export class GlobalToolRegistry {
  private tools = new Map<string, RegisteredTool>();
  private generation = 0;
  get revision(): number {
    return this.generation;
  }
  upsert(tool: RegisteredTool): void {
    const normalized = normalizeTool(tool);
    const previous = this.tools.get(registryKey(normalized));
    if (
      previous &&
      (previous.serverId !== normalized.serverId ||
        previous.sourceType !== normalized.sourceType)
    )
      throw new Error(
        "Tool identity cannot be reassigned to another server/source",
      );
    this.tools.set(registryKey(normalized), normalized);
    this.generation++;
  }
  replaceServer(
    serverId: string,
    tools: RegisteredTool[],
    tenantId?: string,
  ): void {
    const replacements = tools.map(normalizeTool);
    if (
      replacements.some(
        (tool) =>
          tool.serverId !== serverId ||
          (tenantId !== undefined && tool.tenantId !== tenantId),
      )
    )
      throw new Error("Replacement tools do not match server/tenant scope");
    const keys = replacements.map(registryKey);
    if (new Set(keys).size !== keys.length)
      throw new Error("Duplicate replacement tool identity");
    const next = new Map(this.tools);
    for (const [key, tool] of next)
      if (
        tool.serverId === serverId &&
        (tenantId === undefined || tool.tenantId === tenantId)
      )
        next.delete(key);
    for (const tool of replacements) next.set(registryKey(tool), tool);
    this.tools = next;
    this.generation++;
  }
  invalidate(serverId?: string, tenantId?: string): void {
    for (const [key, tool] of this.tools)
      if (
        (serverId === undefined || tool.serverId === serverId) &&
        (tenantId === undefined || tool.tenantId === tenantId)
      )
        this.tools.delete(key);
    this.generation++;
  }
  all(): RegisteredTool[] {
    return [...this.tools.values()].map((tool) => structuredClone(tool));
  }
}

/** Dispatch names are stable per identity and never depend on insertion order. */
export function createExposedBindings(
  tools: RegisteredTool[],
  reservedNames: Iterable<string> = [],
): RegisteredTool[] {
  const used = new Set(reservedNames);
  const normalized = tools.map(normalizeTool);
  const nameCounts = new Map<string, number>();
  for (const tool of normalized)
    nameCounts.set(tool.toolName, (nameCounts.get(tool.toolName) || 0) + 1);
  const proposals = normalized.map(
    (tool) =>
      tool.bindingName ||
      (nameCounts.get(tool.toolName) === 1 && !used.has(tool.toolName)
        ? tool.toolName
        : `${tool.serverId}__${tool.toolName}`
            .replace(/[^A-Za-z0-9_-]/g, "_")
            .slice(0, 64)),
  );
  return normalized.map((tool, index) => {
    let bindingName = proposals[index];
    if (
      !tool.bindingName &&
      (proposals.filter((name) => name === bindingName).length > 1 ||
        used.has(bindingName) ||
        !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(bindingName))
    ) {
      const prefix =
        `${tool.serverId.slice(0, 16)}_${tool.toolName.slice(0, 24)}`.replace(
          /[^A-Za-z0-9_-]/g,
          "_",
        );
      const digest = createHash("sha256")
        .update(registryKey(tool))
        .digest("hex")
        .slice(0, 16);
      bindingName = `t_${prefix}_${digest}`;
    }
    if (
      !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(bindingName) ||
      used.has(bindingName)
    )
      throw new Error("Tool binding collision or invalid name");
    used.add(bindingName);
    return { ...tool, bindingName };
  });
}

const stopWords = new Set(
  "a an the i me my we our you your please can could would will do does did is are was were be been being of in on at to for from with and or it its this that these those them down up then now also just hi hello hey bro what which who how give get list show provide tell make use using want need about".split(
    " ",
  ),
);
const tokens = (text: string): string[] =>
  text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((word) =>
      word.length > 4 && word.endsWith("ies")
        ? `${word.slice(0, -3)}y`
        : word.length > 3 && word.endsWith("s") && !word.endsWith("ss")
          ? word.slice(0, -1)
          : word,
    )
    .filter((word) => !stopWords.has(word));
const unique = (values: string[]) => [...new Set(values)];
const clamp = (number: number) => Math.max(0, Math.min(1, number));
const appListingIntent = (query: string) =>
  /\b(?:list|show|find|search)\b.*\b(?:apps?|applications?)\b/i.test(query) ||
  (/\bwhat\b/i.test(query) &&
    /\b(?:apps|applications)\b/i.test(query) &&
    /\b(?:qlik|available|connected)\b/i.test(query));
const followup = (query: string) =>
  /\b(next(?:\s+\d+)?(?:\s+(?:page|batch|app[s]?))?|more|continue|those|that app|this app|them|ones|these results|same (?:app|server|system))\b/i.test(
    query,
  );
const contextualOnly = (query: string) =>
  followup(query) &&
  tokens(query).every(
    (word) =>
      [
        "next",
        "page",
        "batch",
        "more",
        "continue",
        "result",
        "same",
        "server",
        "system",
        "app",
        "one",
        "modified",
        "updated",
        "recently",
        "recent",
      ].includes(word) || /^\d+$/.test(word),
  );
const corpusText = (tool: RegisteredTool) =>
  [
    tool.toolName,
    ...(tool.aliases || []),
    tool.description || "",
    ...(tool.tags || []),
    tool.vendor || "",
    tool.serverName || "",
    tool.serverId,
  ].join(" ");
const queryParts = (query: string) =>
  query
    .split(/\b(?:and|then|versus|vs|with)\b/i)
    .map((part) => part.trim().replace(/^compare\s+/i, ""))
    .filter(Boolean);

/** BM25 plus explainable title/tag/vendor features. This performs no model call. */
export class LexicalToolRetriever implements ToolRetriever {
  private readonly descriptorIndex = new Map<
    string,
    {
      digest: string;
      document: string[];
      title: string[];
      tags: string[];
      description: Set<string>;
      vendor: string[];
    }
  >();
  private hits = 0;
  private misses = 0;
  get indexStats(): { size: number; hits: number; misses: number } {
    return {
      size: this.descriptorIndex.size,
      hits: this.hits,
      misses: this.misses,
    };
  }
  invalidate(): void {
    this.descriptorIndex.clear();
  }
  private indexed(tool: RegisteredTool) {
    const key = registryKey(tool);
    const digest = createHash("sha256")
      .update(JSON.stringify([corpusText(tool), tool.configVersion || ""]))
      .digest("hex");
    const cached = this.descriptorIndex.get(key);
    if (cached?.digest === digest) {
      this.hits++;
      this.descriptorIndex.delete(key);
      this.descriptorIndex.set(key, cached);
      return cached;
    }
    this.misses++;
    const entry = {
      digest,
      document: tokens(corpusText(tool)),
      title: unique(
        tokens(`${tool.toolName} ${(tool.aliases || []).join(" ")}`),
      ),
      tags: unique(tokens((tool.tags || []).join(" "))),
      description: new Set(tokens(tool.description || "")),
      vendor: tokens(
        `${tool.serverId} ${tool.serverName || ""} ${tool.vendor || ""}`,
      ),
    };
    this.descriptorIndex.delete(key);
    this.descriptorIndex.set(key, entry);
    if (this.descriptorIndex.size > 512)
      this.descriptorIndex.delete(this.descriptorIndex.keys().next().value!);
    return entry;
  }
  retrieve(request: RoutingRequest, tools: RegisteredTool[]): ToolCandidate[] {
    const parts = queryParts(request.query);
    if (parts.length > 1) {
      const combined = new Map<string, ToolCandidate>();
      for (const part of parts)
        for (const candidate of this.retrieve(
          { ...request, query: part },
          tools,
        )) {
          const key = registryKey(candidate.tool);
          const previous = combined.get(key);
          combined.set(key, {
            ...((previous?.score || 0) > candidate.score
              ? previous!
              : candidate),
            queryScores: [
              ...(previous?.queryScores || []),
              { query: part, score: candidate.score },
            ],
          });
        }
      return [...combined.values()].sort(
        (a, b) => b.score - a.score || a.tool.id.localeCompare(b.tool.id),
      );
    }
    const queryTokens = unique(tokens(request.query));
    const indexed = tools.map((tool) => this.indexed(tool));
    const documents = indexed.map((entry) => entry.document);
    // Frequency and ranking always use the CURRENT authorized set. Only descriptor
    // tokenization is cached; prior authorization never enters this metadata cache.
    const averageLength =
      documents.reduce((sum, doc) => sum + doc.length, 0) /
      Math.max(1, documents.length);
    const frequency = new Map<string, number>();
    for (const doc of documents)
      for (const word of unique(doc))
        frequency.set(word, (frequency.get(word) || 0) + 1);
    const bm25 = documents.map((doc) =>
      queryTokens.reduce((score, word) => {
        const count = doc.filter((token) => token === word).length;
        if (!count) return score;
        const idf = Math.log(
          1 +
            (documents.length - (frequency.get(word) || 0) + 0.5) /
              ((frequency.get(word) || 0) + 0.5),
        );
        return (
          score +
          (idf * count * 2.2) /
            (count +
              1.2 * (0.25 + (0.75 * doc.length) / Math.max(1, averageLength)))
        );
      }, 0),
    );
    const maxBm25 = Math.max(0, ...bm25);
    const knownVendorTokens = new Set(indexed.flatMap((entry) => entry.vendor));
    const contentTokens = queryTokens.filter(
      (word) => !knownVendorTokens.has(word),
    );
    const queryText = ` ${tokens(request.query).join(" ")} `;
    const recentServers = new Set([
      ...(request.context?.recentServerIds || []),
      ...(request.context?.activeServerId
        ? [request.context.activeServerId]
        : []),
    ]);
    const recentTools = new Set(request.context?.recentToolIds || []);
    const contextOnly = contextualOnly(request.query);
    return tools
      .map((tool, index) => {
        const titleTokens = indexed[index].title;
        const titleMatches = titleTokens.filter((word) =>
          contentTokens.includes(word),
        );
        const tagTokens = indexed[index].tags.filter(
          (word) => !knownVendorTokens.has(word),
        );
        const tagMatches = tagTokens.filter((word) =>
          contentTokens.includes(word),
        );
        const descriptionTokens = indexed[index].description;
        const descriptionCoverage =
          contentTokens.filter((word) => descriptionTokens.has(word)).length /
          Math.max(1, contentTokens.length);
        const vendorTokens = indexed[index].vendor;
        const explicitVendor = vendorTokens.some((word) =>
          queryTokens.includes(word),
        );
        const exactName = [tool.toolName, ...(tool.aliases || [])].some(
          (name) => {
            const phrase = tokens(name).join(" ");
            const genericNoun = /^(app|application|tool|data)$/.test(phrase);
            const literalName = new RegExp(
              `\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
              "i",
            ).test(request.query);
            return (
              literalName ||
              (phrase.length > 0 &&
                !genericNoun &&
                queryText.includes(` ${phrase} `))
            );
          },
        );
        const attachedOnly =
          tool.sourceType === "mcp" &&
          request.context?.allowedServerIds?.length === 1 &&
          request.context.allowedServerIds[0] === tool.serverId;
        let score =
          (0.5 * titleMatches.length) / Math.max(1, titleTokens.length) +
          (0.15 * tagMatches.length) / Math.max(1, tagTokens.length) +
          0.1 * descriptionCoverage +
          0.15 * (maxBm25 ? bm25[index] / maxBm25 : 0) +
          (explicitVendor ? 0.15 : 0) +
          (exactName && titleMatches.length ? 0.2 : 0) +
          (attachedOnly && titleMatches.length ? 0.05 : 0);
        // Explicit server + capability tags resolves conceptual names such as "SAP sales"
        // without requiring the user to know the function name "get_sales_orders".
        if (explicitVendor && tagMatches.length) score += 0.2;
        const appListing =
          tool.toolName === "get_apps" && appListingIntent(request.query);
        if (appListing) score += 0.2;
        const contextual =
          followup(request.query) &&
          (recentServers.has(tool.serverId) || recentTools.has(tool.id));
        if (contextOnly && recentTools.has(tool.id))
          score = Math.max(score, 0.9);
        else if (contextual && titleMatches.length) score += 0.1;
        const reason = [
          `BM25=${bm25[index].toFixed(3)}`,
          `title=${titleMatches.join(",") || "none"}`,
          ...(tagMatches.length ? [`tags=${tagMatches.join(",")}`] : []),
          ...(explicitVendor ? ["explicit server/vendor"] : []),
          ...(exactName && titleMatches.length ? ["exact tool phrase"] : []),
          ...(appListing ? ["app-listing capability intent"] : []),
          ...(contextual ? ["compact recent-tool context"] : []),
        ].join("; ");
        return { tool, score: clamp(score), reason };
      })
      .filter((candidate) => candidate.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          a.tool.id.localeCompare(b.tool.id) ||
          a.tool.serverId.localeCompare(b.tool.serverId),
      );
  }
}

function scopedTools(
  tools: RegisteredTool[],
  request: RoutingRequest,
): RegisteredTool[] {
  return tools.filter(
    (tool) =>
      tool.enabled !== false &&
      tool.available !== false &&
      (tool.sourceType === "native" ||
        !request.context?.unavailableServerIds?.includes(tool.serverId)) &&
      !tool.mandatory &&
      ((tool.scope === "global" && tool.sourceType === "native") ||
        tool.tenantId === request.tenantId) &&
      (tool.sourceType === "native" ||
        !request.context?.allowedServerIds ||
        request.context.allowedServerIds.includes(tool.serverId)),
  );
}

const appExplanationTools = [
  "get_apps",
  "get_app_details",
  "get_app_script",
  "get_lineage",
  "get_app_sheets",
] as const;
const knownAppReference = (request: RoutingRequest) =>
  (request.context?.activeEntities || []).some(
    (entity) =>
      (!entity.kind ||
        entity.kind === "app" ||
        entity.kind === "application") &&
      [entity.guid, entity.id, entity.name].some(
        (value) =>
          value &&
          value.length >= 2 &&
          new RegExp(
            `\\b${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
            "i",
          ).test(request.query),
      ),
  );
const contextualAppIdentifier = (request: RoutingRequest) =>
  !!(
    request.context?.activeServerId || request.context?.recentServerIds?.length
  ) && /\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+){2,}\b/.test(request.query);
const explainAppReference = (request: RoutingRequest) =>
  /\b(explain|describe|understand|document|analy[sz]e)\b/i.test(
    request.query,
  ) &&
  (/\b(app|application|dashboard)\b/i.test(request.query) ||
    knownAppReference(request) ||
    contextualAppIdentifier(request));
/** A vendor word inside a known app title is not a separate server request. */
const serverReferenceQuery = (request: RoutingRequest) => {
  let query = request.query;
  for (const entity of request.context?.activeEntities || []) {
    if (entity.kind && entity.kind !== "app" && entity.kind !== "application")
      continue;
    for (const value of [entity.name, entity.guid, entity.id])
      if (value && value.length >= 2)
        query = query.replace(
          new RegExp(
            `\\b${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
            "gi",
          ),
          " ",
        );
  }
  return query;
};
const mentionsServer = (
  query: string,
  server: string,
  tools: RegisteredTool[],
) => {
  const words = new Set(tokens(query));
  return (
    tokens(server).some((word) => words.has(word)) ||
    tools.some(
      (tool) =>
        tool.serverId === server &&
        tokens(`${tool.vendor || ""} ${tool.serverName || ""}`).some((word) =>
          words.has(word),
        ),
    )
  );
};
function registryUnavailable(
  request: RoutingRequest,
  tools: RegisteredTool[],
): boolean {
  if (
    !enterpriseIntent(request.query) &&
    !followup(request.query) &&
    !explainAppReference(request)
  )
    return false;
  const unavailable = new Set(request.context?.unavailableServerIds || []);
  if (
    request.context?.registryState === "failed" ||
    request.context?.registryState === "initializing"
  )
    for (const server of request.context?.allowedServerIds || [])
      unavailable.add(server);
  if (!unavailable.size) return false;
  const allServers = unique([
    ...tools
      .filter((tool) => tool.sourceType === "mcp")
      .map((tool) => tool.serverId),
    ...unavailable,
    ...(request.context?.allowedServerIds || []),
  ]);
  const serverQuery = serverReferenceQuery(request);
  const explicit = allServers.filter((server) =>
    mentionsServer(serverQuery, server, tools),
  );
  if (explicit.length)
    return explicit.some((server) => unavailable.has(server));
  // An explicitly different vendor must not inherit an unavailable previous connector.
  if (/\b(qlik|sap|snowflake|salesforce|power\s?bi)\b/i.test(serverQuery))
    return false;
  const active =
    request.context?.activeServerId ||
    (request.context?.recentServerIds?.length === 1
      ? request.context.recentServerIds[0]
      : undefined);
  if ((followup(request.query) || explainAppReference(request)) && active)
    return unavailable.has(active);
  const business =
    /\b(apps?|applications?|dashboards?|data|databases?|tables?|invoices?|customers?|opportunit(?:y|ies)|margins?)\b/i.test(
      request.query,
    );
  return (
    business &&
    request.context?.allowedServerIds?.length === 1 &&
    unavailable.has(request.context.allowedServerIds[0])
  );
}

/** Task expansion chooses a bounded complementary schema set; it never executes or approves a tool. */
function appExplanationDecision(
  request: RoutingRequest,
  scoped: RegisteredTool[],
  authorized: RegisteredTool[],
  candidates: ToolCandidate[],
  maxTools: number,
): Omit<RoutePlan, "authorizationRemoved" | "routingLatencyMs"> | undefined {
  if (!explainAppReference(request)) return;
  const registered = scoped.filter((tool) => tool.sourceType === "mcp");
  const servers = unique(
    registered
      .filter((tool) =>
        (appExplanationTools as readonly string[]).includes(tool.toolName),
      )
      .map((tool) => tool.serverId),
  );
  if (!servers.length) return;
  const serverQuery = serverReferenceQuery(request);
  const allExplicit = unique(registered.map((tool) => tool.serverId)).filter(
    (server) => mentionsServer(serverQuery, server, registered),
  );
  let targets = servers.filter((server) => allExplicit.includes(server));
  if (/\bqlik\b/i.test(serverQuery))
    targets = servers.filter(
      (server) =>
        mentionsServer("qlik", server, registered) ||
        registered.some(
          (tool) =>
            tool.serverId === server &&
            tool.toolName === "get_apps" &&
            /\bqlik\b/i.test(tool.description || ""),
        ),
    );
  if (!targets.length && allExplicit.length) return;
  if (
    !targets.length &&
    /\b(sap|snowflake|salesforce|power\s?bi)\b/i.test(serverQuery)
  )
    return;
  if (!targets.length) {
    const named = unique(
      (request.context?.activeEntities || [])
        .filter(
          (entity) =>
            servers.includes(entity.serverId) &&
            [entity.guid, entity.id, entity.name].some(
              (value) =>
                value &&
                request.query.toLowerCase().includes(value.toLowerCase()),
            ),
        )
        .map((entity) => entity.serverId),
    );
    const active =
      request.context?.activeServerId ||
      (request.context?.recentServerIds?.length === 1
        ? request.context.recentServerIds[0]
        : undefined);
    targets = named.length
      ? named
      : active && servers.includes(active)
        ? [active]
        : request.context?.allowedServerIds?.length === 1 &&
            servers.includes(request.context.allowedServerIds[0])
          ? [request.context.allowedServerIds[0]]
          : servers;
  }
  const base = {
    query: request.query,
    confidence: candidates[0]?.score || 0,
    candidates,
  };
  if (targets.length !== 1)
    return {
      ...base,
      mode: "discovery",
      selected: [],
      fallbackCode: "ambiguous_task_server",
      fallbackReason:
        "App explanation has no unambiguous authorized server context",
    };
  const serverId = targets[0];
  const selected = appExplanationTools.map((name) =>
    authorized.find(
      (tool) => tool.serverId === serverId && tool.toolName === name,
    ),
  );
  const missingTools = appExplanationTools.filter(
    (_, index) => !selected[index],
  );
  const task: NonNullable<RoutePlan["task"]> = {
    kind: "app_explanation",
    serverId,
    requiredTools: [...appExplanationTools],
    missingTools,
  };
  const additionalTask =
    allExplicit.some((server) => server !== serverId) ||
    /\b(?:and|then)\b.*\b(?:create|write|build|export|save|send)\b.*\b(?:documents?|reports?|spreadsheets?|files?|emails?)\b/i.test(
      request.query,
    );
  if (additionalTask)
    return {
      ...base,
      task,
      mode: "discovery",
      selected: [],
      fallbackCode: "missing_task_coverage",
      fallbackReason:
        "App-explanation bundle cannot cover additional server or output tasks; use discovery rather than silently dropping them",
    };
  if (missingTools.length)
    return {
      ...base,
      task,
      mode: "discovery",
      selected: [],
      fallbackCode: "missing_task_coverage",
      fallbackReason: "Authorized available tools cannot cover app explanation",
    };
  if (selected.length > maxTools)
    return {
      ...base,
      task,
      mode: "discovery",
      selected: [],
      fallbackCode: "task_budget_exceeded",
      fallbackReason:
        "Top-K cannot cover app explanation lookup, details, script, lineage and sheets",
    };
  return {
    ...base,
    task,
    mode: "direct_tools",
    selected: selected as RegisteredTool[],
  };
}
const enterpriseIntent = (query: string) =>
  /\b(apps?|applications?|dashboard[s]?|data|database[s]?|table[s]?|invoice[s]?|customer[s]?|opportunit(?:y|ies)|margin[s]?|report[s]?|spreadsheet[s]?|document[s]?|workspace|file[s]?|directory|directories|folder[s]?|delegate|agent[s]?|goal[s]?|plan|sap|snowflake|qlik|salesforce|power\s?bi)\b/i.test(
    query,
  );
function decide(
  request: RoutingRequest,
  candidates: ToolCandidate[],
  thresholds: RoutingThresholds,
  topK: number,
): Omit<RoutePlan, "authorizationRemoved" | "routingLatencyMs"> {
  const base = {
    query: request.query,
    confidence: candidates[0]?.score || 0,
    candidates,
  };
  if (
    contextualOnly(request.query) &&
    !request.context?.recentToolIds?.length &&
    !request.context?.recentServerIds?.length
  )
    return {
      ...base,
      mode: "discovery",
      selected: [],
      fallbackReason: "Follow-up requires compact previous-tool context",
    };
  if (!candidates.length) {
    if (enterpriseIntent(request.query) || followup(request.query))
      return {
        ...base,
        mode: "discovery",
        selected: [],
        fallbackReason: "No authorized matching enterprise tool",
      };
    return { ...base, mode: "no_tools", selected: [] };
  }
  const best = candidates[0];
  if (best.score < thresholds.highConfidenceThreshold) {
    if (
      !enterpriseIntent(request.query) &&
      !followup(request.query) &&
      !candidates.some((candidate) =>
        candidate.reason.includes("explicit server/vendor"),
      )
    )
      return { ...base, mode: "no_tools", selected: [] };
    return {
      ...base,
      mode: "discovery",
      selected: [],
      fallbackReason: "Retrieval score below calibrated threshold",
    };
  }
  const selected = candidates
    .filter(
      (candidate) => candidate.score >= thresholds.highConfidenceThreshold,
    )
    .slice(0, topK);
  const multiIntent =
    /\b(and|then|versus|vs|compare|both|across|combine|join)\b/i.test(
      request.query,
    );
  const second = candidates[1];
  if (
    second &&
    !multiIntent &&
    best.score - second.score < thresholds.ambiguityMargin &&
    best.tool.serverId !== second.tool.serverId &&
    !(
      followup(request.query) &&
      request.context?.recentServerIds?.length === 1 &&
      request.context.recentServerIds[0] === best.tool.serverId
    )
  )
    return {
      ...base,
      mode: "discovery",
      selected: [],
      fallbackReason: "Ambiguous tools across servers; no reliable preference",
    };
  if (!multiIntent) {
    // Alternate connectors must not be silently bundled to resolve ambiguity.
    const other = selected.filter(
      (candidate) =>
        candidate !== best &&
        candidate.tool.sourceType === best.tool.sourceType,
    );
    for (const candidate of other)
      selected.splice(selected.indexOf(candidate), 1);
  }
  const mentionedServers = unique(
    candidates
      .filter((candidate) =>
        tokens(
          `${candidate.tool.serverId} ${candidate.tool.serverName || ""} ${candidate.tool.vendor || ""}`,
        ).some((word) => tokens(request.query).includes(word)),
      )
      .map((candidate) => candidate.tool.serverId),
  );
  if (
    mentionedServers.some(
      (server) =>
        !selected.some((candidate) => candidate.tool.serverId === server),
    )
  )
    return {
      ...base,
      mode: "discovery",
      selected: [],
      fallbackReason: "Top-K cannot cover all explicitly requested servers",
    };
  if (
    multiIntent &&
    candidates.some((candidate) => candidate.queryScores) &&
    queryParts(request.query).some(
      (part) =>
        enterpriseIntent(part) &&
        !selected.some((candidate) =>
          candidate.queryScores?.some(
            (match) =>
              match.query === part &&
              match.score >= thresholds.highConfidenceThreshold,
          ),
        ),
    )
  )
    return {
      ...base,
      mode: "discovery",
      selected: [],
      fallbackReason:
        "No confident tool coverage for part of the multi-step request",
    };
  return {
    ...base,
    mode: "direct_tools",
    selected: selected.map((candidate) => candidate.tool),
  };
}

export interface RoutingCalibrationExample extends RoutingRequest {
  expectedMode: RoutePlan["mode"];
  expectedToolIds: string[];
}
const calibrationTool = (
  serverId: string,
  toolName: string,
  description: string,
  tags: string[] = [],
  sourceType: RegisteredTool["sourceType"] = "mcp",
): RegisteredTool => ({
  id: `${serverId}:${toolName}`,
  serverId,
  toolName,
  sourceType,
  tenantId: "fixture",
  scope: "tenant",
  description,
  tags,
  vendor: serverId,
  inputSchema: { type: "object", properties: {} },
});
export const routingCalibrationTools: RegisteredTool[] = [
  calibrationTool(
    "qlik",
    "get_apps",
    "List Qlik applications with names identifiers and pagination",
    ["apps", "applications"],
  ),
  calibrationTool(
    "qlik",
    "get_app_details",
    "Get details and metadata for an application",
    ["details", "metadata"],
  ),
  calibrationTool(
    "sap",
    "get_invoices",
    "Retrieve SAP invoices and invoice status",
    ["invoice", "billing"],
  ),
  calibrationTool("sap", "get_customers", "Retrieve customer records", [
    "customer",
  ]),
  calibrationTool("salesforce", "get_customers", "Retrieve customer records", [
    "customer",
  ]),
  calibrationTool(
    "snowflake",
    "list_tables",
    "List Snowflake database tables",
    ["table", "database"],
  ),
  calibrationTool(
    "workspace",
    "create_document",
    "Create a Word document report",
    ["document", "word", "report"],
    "native",
  ),
  calibrationTool(
    "workspace",
    "create_spreadsheet",
    "Create an Excel spreadsheet workbook",
    ["spreadsheet", "excel", "workbook"],
    "native",
  ),
  calibrationTool(
    "workspace",
    "list_files",
    "List files and folders in the workspace directory",
    ["file", "folder", "directory"],
    "native",
  ),
  calibrationTool(
    "qlik",
    "get_kpi",
    "Retrieve related Qlik KPI measures and revenue indicators",
    ["kpi", "revenue", "analytics"],
  ),
  calibrationTool(
    "sap",
    "get_sales_orders",
    "Retrieve SAP sales orders using customer product company country and date filters",
    ["sales", "orders", "erp"],
  ),
  calibrationTool(
    "sap",
    "get_revenue",
    "Retrieve current SAP sales revenue by customer and company",
    ["sales", "revenue"],
  ),
  calibrationTool(
    "snowflake",
    "sales_analysis",
    "Analyze historical sales data stored in Snowflake",
    ["sales", "historical", "analytics", "warehouse"],
  ),
];
const calibrationExample = (
  query: string,
  expectedMode: RoutePlan["mode"],
  expectedToolIds: string[],
  context?: RoutingContext,
): RoutingCalibrationExample => ({
  query,
  tenantId: "fixture",
  userId: "fixture-user",
  expectedMode,
  expectedToolIds,
  ...(context ? { context } : {}),
});
/** Local labeled fixtures; these are not live integrations or production accuracy measurements. */
export const routingCalibrationExamples: RoutingCalibrationExample[] = [
  calibrationExample("Hi bro ?", "no_tools", []),
  calibrationExample("What is the capital of India?", "no_tools", []),
  calibrationExample("Hello I am Ashok what is your name", "no_tools", []),
  calibrationExample(
    "Can you list down the apps in the qlik ?",
    "direct_tools",
    ["qlik:get_apps"],
  ),
  calibrationExample("Get app details in Qlik", "direct_tools", [
    "qlik:get_app_details",
  ]),
  calibrationExample("Retrieve invoices from SAP", "direct_tools", [
    "sap:get_invoices",
  ]),
  calibrationExample("List Snowflake tables", "direct_tools", [
    "snowflake:list_tables",
  ]),
  calibrationExample("Get customers", "discovery", []),
  calibrationExample("Help me with Qlik", "discovery", []),
  calibrationExample("Find enterprise data", "discovery", []),
  calibrationExample("Compare Qlik apps and Snowflake tables", "direct_tools", [
    "qlik:get_apps",
    "snowflake:list_tables",
  ]),
  calibrationExample("Create a Word document", "direct_tools", [
    "workspace:create_document",
  ]),
  calibrationExample("Create an Excel spreadsheet", "direct_tools", [
    "workspace:create_spreadsheet",
  ]),
  calibrationExample("List files in the workspace", "direct_tools", [
    "workspace:list_files",
  ]),
  calibrationExample("Show the next page", "direct_tools", ["qlik:get_apps"], {
    recentServerIds: ["qlik"],
    recentToolIds: ["qlik:get_apps"],
  }),
  calibrationExample("Show the next page", "discovery", []),
  calibrationExample(
    "Which ones were modified recently?",
    "direct_tools",
    ["qlik:get_apps"],
    { recentServerIds: ["qlik"], recentToolIds: ["qlik:get_apps"] },
  ),
  calibrationExample(
    "Compare SAP sales with historical Snowflake sales and retrieve the related Qlik KPI.",
    "direct_tools",
    ["sap:get_sales_orders", "snowflake:sales_analysis", "qlik:get_kpi"],
  ),
  calibrationExample(
    "Find why European enterprise customer margins declined and compare that with our current opportunities.",
    "discovery",
    [],
  ),
  calibrationExample(
    "List Qlik apps and create an Excel spreadsheet",
    "direct_tools",
    ["qlik:get_apps", "workspace:create_spreadsheet"],
  ),
];
export interface RoutingCalibrationResult extends RoutingThresholds {
  examples: number;
  correct: number;
  unsafeDirect: number;
  missedDirect: number;
  accuracy: number;
  cases: {
    query: string;
    expectedMode: RoutePlan["mode"];
    actualMode: RoutePlan["mode"];
    expectedToolIds: string[];
    actualToolIds: string[];
    confidence: number;
    correct: boolean;
  }[];
}
/** Select thresholds by exact-mode/tool-set labels. Scores remain heuristic after calibration. */
export function calibrateRoutingThresholds(
  tools = routingCalibrationTools,
  examples = routingCalibrationExamples,
  retriever: ToolRetriever = new LexicalToolRetriever(),
): RoutingCalibrationResult {
  if (!examples.length)
    throw new Error("Calibration requires labeled examples");
  const retrieved = examples.map((example) =>
    retriever.retrieve(example, scopedTools(tools, example)),
  );
  let best: RoutingCalibrationResult | undefined;
  let bestLoss = Infinity;
  for (let thresholdStep = 12; thresholdStep <= 38; thresholdStep++)
    for (let marginStep = 1; marginStep <= 10; marginStep++) {
      const thresholds = {
        highConfidenceThreshold: thresholdStep / 40,
        ambiguityMargin: marginStep / 40,
      };
      const cases = examples.map((example, index) => {
        const actual = decide(example, retrieved[index], thresholds, 5);
        const actualToolIds = actual.selected.map((tool) => tool.id).sort();
        const expectedToolIds = [...example.expectedToolIds].sort();
        return {
          query: example.query,
          expectedMode: example.expectedMode,
          actualMode: actual.mode,
          expectedToolIds,
          actualToolIds,
          confidence: actual.confidence,
          correct:
            actual.mode === example.expectedMode &&
            JSON.stringify(actualToolIds) === JSON.stringify(expectedToolIds),
        };
      });
      const correct = cases.filter((example) => example.correct).length;
      const unsafeDirect = cases.filter(
        (example) =>
          !example.correct &&
          example.actualMode === "direct_tools" &&
          example.actualToolIds.length > 0,
      ).length;
      const missedDirect = cases.filter(
        (example) =>
          !example.correct &&
          example.actualMode === "discovery" &&
          example.expectedMode === "direct_tools",
      ).length;
      const loss = unsafeDirect * 5 + (cases.length - correct);
      // Prefer the stricter threshold among equally accurate candidates, with the smaller necessary ambiguity margin.
      if (
        loss < bestLoss ||
        (loss === bestLoss &&
          thresholds.highConfidenceThreshold > best!.highConfidenceThreshold)
      ) {
        bestLoss = loss;
        best = {
          ...thresholds,
          examples: cases.length,
          correct,
          unsafeDirect,
          missedDirect,
          accuracy: correct / cases.length,
          cases,
        };
      }
    }
  return best!;
}
const calibratedDefaults = calibrateRoutingThresholds();
export const DEFAULT_ROUTING_THRESHOLDS: Readonly<RoutingThresholds> =
  Object.freeze({
    highConfidenceThreshold: calibratedDefaults.highConfidenceThreshold,
    ambiguityMargin: calibratedDefaults.ambiguityMargin,
  });

export class ToolRouter {
  readonly thresholds: Readonly<RoutingThresholds>;
  private readonly retriever: ToolRetriever;
  private readonly topK: number;
  private indexRevision = -1;
  constructor(
    private readonly registry: GlobalToolRegistry,
    private readonly authorizer: ToolAuthorizer,
    options: ToolRouterOptions = {},
  ) {
    this.thresholds = Object.freeze({
      highConfidenceThreshold:
        options.highConfidenceThreshold ??
        DEFAULT_ROUTING_THRESHOLDS.highConfidenceThreshold,
      ambiguityMargin:
        options.ambiguityMargin ?? DEFAULT_ROUTING_THRESHOLDS.ambiguityMargin,
    });
    for (const number of Object.values(this.thresholds))
      if (!Number.isFinite(number) || number < 0 || number > 1)
        throw new Error(
          "Routing thresholds must be finite scores between 0 and 1",
        );
    this.topK = options.topK ?? 5;
    if (!Number.isInteger(this.topK) || this.topK < 1 || this.topK > 16)
      throw new Error("Routing Top-K must be between 1 and 16");
    this.retriever = options.retriever || new LexicalToolRetriever();
  }
  async route(request: RoutingRequest): Promise<RoutePlan> {
    const started = performance.now();
    if (
      !request.tenantId ||
      !request.userId ||
      typeof request.query !== "string"
    )
      throw new Error("Routing requires query, tenantId and userId");
    const maxTools = request.maxTools ?? this.topK;
    if (!Number.isInteger(maxTools) || maxTools < 1 || maxTools > 16)
      throw new Error("Routing maxTools must be between 1 and 16");
    const scopedRevision = this.registry.revision;
    const scoped = scopedTools(this.registry.all(), request);
    if (this.indexRevision !== this.registry.revision) {
      this.retriever.invalidate?.();
      this.indexRevision = this.registry.revision;
    }
    const authorizationRemoved: string[] = [];
    const authorized = (
      await Promise.all(
        scoped.map(async (tool) => {
          let allowed = false;
          try {
            allowed =
              (await this.authorizer(structuredClone(tool), request)) === true;
          } catch {
            /* Fail closed; never cache authorization. */
          }
          if (!allowed) authorizationRemoved.push(tool.id);
          return allowed ? tool : undefined;
        }),
      )
    ).filter((tool): tool is RegisteredTool => !!tool);
    if (this.registry.revision !== scopedRevision)
      return {
        query: request.query,
        mode: "discovery",
        confidence: 0,
        candidates: [],
        selected: [],
        fallbackReason:
          "Registry metadata/config changed during authorization; route again",
        exposedBindings: [
          "discover_server",
          "discover_tools",
          "get_tool_schema",
          "invoke_tool",
        ],
        thresholds: { ...this.thresholds },
        authorizationRemoved: authorizationRemoved.sort(),
        routingLatencyMs: performance.now() - started,
      };
    const indexStartedAt = new Date().toISOString();
    const indexStarted = performance.now();
    const statsBefore =
      this.retriever instanceof LexicalToolRetriever
        ? this.retriever.indexStats
        : undefined;
    const retrieved = this.retriever.retrieve(request, authorized);
    // A pluggable retriever cannot smuggle in schemas outside the current permission-filtered registry.
    const identities = new Map(
      authorized.map((tool) => [registryKey(tool), tool]),
    );
    const trustedCandidates = (retrieval: ToolCandidate[]): ToolCandidate[] =>
      retrieval
        .filter(
          (candidate) =>
            identities.has(registryKey(candidate.tool)) &&
            Number.isFinite(candidate.score),
        )
        .map((candidate) => ({
          tool: identities.get(registryKey(candidate.tool))!,
          score: clamp(candidate.score),
          reason: String(candidate.reason),
          ...(candidate.queryScores
            ? {
                queryScores: candidate.queryScores
                  .filter(
                    (match) =>
                      typeof match.query === "string" &&
                      Number.isFinite(match.score),
                  )
                  .map((match) => ({
                    query: match.query,
                    score: clamp(match.score),
                  })),
              }
            : {}),
        }))
        .sort(
          (a, b) => b.score - a.score || a.tool.id.localeCompare(b.tool.id),
        );
    let candidates = trustedCandidates(retrieved);
    const unavailable = registryUnavailable(request, this.registry.all());
    let taskDecision = unavailable
      ? undefined
      : appExplanationDecision(
          request,
          scoped,
          authorized,
          candidates,
          maxTools,
        );
    let taskRetrieval: RoutePlan["taskRetrieval"];
    // A recognized bounded task expands the retrieval QUERY, not a confidence
    // constant. The same current authorized catalog/retriever supplies its score.
    // An arbitrary or low-confidence custom retriever remains subject to the threshold.
    if (taskDecision?.mode === "direct_tools" && taskDecision.task) {
      const anchor = authorized.find(
        (tool) =>
          tool.serverId === taskDecision!.task!.serverId &&
          tool.toolName === "get_app_details",
      )!;
      const expandedQuery = `${request.query} ${taskDecision.task.serverId} app details`;
      const originalAnchorScore =
        candidates.find(
          (candidate) => registryKey(candidate.tool) === registryKey(anchor),
        )?.score || 0;
      const originalBestScore = candidates[0]?.score || 0;
      candidates = trustedCandidates(
        this.retriever.retrieve(
          { ...request, query: expandedQuery },
          authorized,
        ),
      );
      const expandedAnchorScore =
        candidates.find(
          (candidate) => registryKey(candidate.tool) === registryKey(anchor),
        )?.score || 0;
      taskRetrieval = {
        originalQuery: request.query,
        expandedQuery,
        anchorToolId: anchor.id,
        originalAnchorScore,
        expandedAnchorScore,
        originalBestScore,
        expandedBestScore: candidates[0]?.score || 0,
        reason:
          "Recognized app explanation adds the resolved server and app-details capability to metadata retrieval; no model call or invented score",
      };
      taskDecision = {
        ...taskDecision,
        candidates,
        confidence: expandedAnchorScore,
      };
      if (expandedAnchorScore < this.thresholds.highConfidenceThreshold)
        taskDecision = {
          ...taskDecision,
          mode: "discovery",
          selected: [],
          fallbackCode: "task_confidence_below_threshold",
          fallbackReason:
            "App-details task retrieval score is below the configured threshold",
        };
    }
    const statsAfter =
      this.retriever instanceof LexicalToolRetriever
        ? this.retriever.indexStats
        : undefined;
    const retrievalIndex: NonNullable<RoutePlan["retrievalIndex"]> = {
      startedAt: indexStartedAt,
      completedAt: new Date().toISOString(),
      durationMs: performance.now() - indexStarted,
      toolCount: authorized.length,
      queryCount: taskRetrieval ? 2 : 1,
      ...(statsBefore && statsAfter
        ? {
            cacheHits: statsAfter.hits - statsBefore.hits,
            cacheMisses: statsAfter.misses - statsBefore.misses,
          }
        : {}),
    };
    const decision = unavailable
      ? {
          query: request.query,
          confidence: 0,
          candidates: [],
          mode: "discovery" as const,
          selected: [],
          fallbackCode: "registry_unavailable" as const,
          fallbackReason:
            "Requested connector registry is initializing or unavailable",
        }
      : taskDecision || decide(request, candidates, this.thresholds, maxTools);
    return {
      ...decision,
      ...(taskRetrieval ? { taskRetrieval } : {}),
      exposedBindings:
        decision.mode === "discovery"
          ? [
              "discover_server",
              "discover_tools",
              "get_tool_schema",
              "invoke_tool",
            ]
          : decision.selected.map((tool) => tool.bindingName || tool.toolName),
      thresholds: { ...this.thresholds },
      retrievalIndex,
      authorizationRemoved: authorizationRemoved.sort(),
      routingLatencyMs: performance.now() - started,
    };
  }
}
