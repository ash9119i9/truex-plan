import { signInForTest, TENANT_ID } from "./auth-fixture.ts";
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
  createTenantAgent,
  defaultAgent,
  fetchTenantAgents,
  formChanges,
  formOf,
  formProblem,
  groupAgents,
  parseAgent,
  requestIds,
  updateTenantAgent,
  withAgent,
  type TenantAgent,
} from "../lib/tenant-agents.ts";

const MODEL = {
  id: "64b7f0c2a1b2c3d4e5f60001",
  displayName: "Claude Sonnet 4.5",
  shortLabel: "sonnet 4.5",
  family: "anthropic",
};

const agent = (overrides: Partial<TenantAgent> = {}): TenantAgent => ({
  id: "64b7f0c2a1b2c3d4e5f60aa1",
  source: "personal",
  name: "Scout",
  description: "Finds sources.",
  look: 4,
  tint: "mint",
  model: MODEL,
  available: true,
  connectors: [],
  skills: [],
  helpers: false,
  revision: 3,
  createdByMe: true,
  status: "active",
  canEdit: true,
  canArchive: true,
  canPromote: true,
  ...overrides,
});

interface Sent {
  url: string;
  method: string;
  body: unknown;
}

function mockFetch(t: { after: (fn: () => void) => void }, reply: unknown) {
  const sent: Sent[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    sent.push({
      url,
      method: init.method ?? "GET",
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    return Response.json(reply);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  return sent;
}

beforeEach(() => signInForTest());

test("lists agents for this tab's tenant and drops malformed entries", async (t) => {
  const sent = mockFetch(t, {
    agents: [
      agent(),
      { id: "nope", name: "x" },
      agent({ id: "64b7f0c2a1b2c3d4e5f60aa2", source: "builtin" }),
    ],
  });
  const { agents, helpers } = await fetchTenantAgents();
  assert.equal(helpers, false);
  assert.equal(sent[0]?.url, `/api/v1/agents?tenantId=${TENANT_ID}`);
  assert.deepEqual(
    agents.map((a) => a.source),
    ["personal", "builtin"],
  );
});

test("create sends the trimmed form, scope and request ID", async (t) => {
  const sent = mockFetch(t, { agent: agent() });
  await createTenantAgent(
    {
      name: "  Scout ",
      description: " Finds sources. ",
      modelId: MODEL.id,
      look: 4,
      tint: "mint",
      connectorSlugs: [],
      connectorAccess: {},
      skillIds: [],
      helpers: false,
    },
    "tenant",
    "req-12345678",
  );
  assert.equal(sent[0]?.method, "POST");
  assert.deepEqual(sent[0]?.body, {
    clientRequestId: "req-12345678",
    scope: "tenant",
    name: "Scout",
    description: "Finds sources.",
    modelId: MODEL.id,
    look: 4,
    tint: "mint",
    connectors: [],
    skillIds: [],
    helpers: false,
  });
});

test("edit is a PATCH with the revision it started from", async (t) => {
  const sent = mockFetch(t, { agent: agent({ revision: 4 }) });
  const updated = await updateTenantAgent(agent().id, 3, { name: "Lead" });
  assert.equal(sent[0]?.method, "PATCH");
  assert.equal(
    sent[0]?.url,
    `/api/v1/agents/${agent().id}?tenantId=${TENANT_ID}`,
  );
  assert.deepEqual(sent[0]?.body, { revision: 3, name: "Lead" });
  assert.equal(updated.revision, 4);
});

test("parseAgent treats missing permissions as none", () => {
  const { canEdit, canArchive, canPromote, ...rest } = agent();
  const parsed = parseAgent(rest);
  assert.deepEqual(
    [parsed?.canEdit, parsed?.canArchive, parsed?.canPromote],
    [false, false, false],
  );
  assert.equal(parseAgent({ ...agent(), source: "global" }), null);
  assert.equal(parseAgent(null), null);
});

test("formProblem mirrors the server's rules", () => {
  const form = formOf(null, [MODEL]);
  assert.equal(form.modelId, MODEL.id);
  assert.match(formProblem(form) ?? "", /name/);
  assert.match(
    formProblem({ ...form, name: "A" }) ?? "",
    /what the agent is for/,
  );
  assert.equal(formProblem({ ...form, name: "A", description: "B" }), null);
  assert.match(
    formProblem({ ...form, name: "x".repeat(61), description: "B" }) ?? "",
    /under 61/,
  );
  assert.match(
    formProblem({ ...form, name: "A", description: "B", modelId: "" }) ?? "",
    /model/,
  );
});

test("formChanges sends only what changed", () => {
  const a = agent();
  assert.deepEqual(formChanges(a, formOf(a, [])), {});
  assert.deepEqual(
    formChanges(a, { ...formOf(a, []), name: " Lead ", tint: "ice" }),
    { name: "Lead", tint: "ice" },
  );
  // An unavailable model must be replaced explicitly.
  assert.deepEqual(
    formChanges(agent({ model: null }), {
      ...formOf(agent({ model: null }), []),
      modelId: MODEL.id,
    }),
    { modelId: MODEL.id },
  );
});

test("skills: parsed from the agent, and an edit sends only a changed list", () => {
  const parsed = parseAgent({
    ...agent(),
    skills: [
      {
        id: "64b7f0c2a1b2c3d4e5f60b01",
        slug: "invoice-check",
        displayName: "Invoice check",
        description: "Checks invoices.",
        hasScripts: true,
        available: false,
      },
      { id: "bad", slug: "x", displayName: "X", description: "" },
    ],
  });
  assert.deepEqual(
    parsed?.skills.map((s) => [s.slug, s.available, s.hasScripts]),
    [["invoice-check", false, true]],
  );
  const a = agent({ skills: parsed!.skills });
  assert.deepEqual(formChanges(a, formOf(a, [])), {});
  assert.deepEqual(formChanges(a, { ...formOf(a, []), skillIds: [] }), {
    skillIds: [],
  });
  const many = Array.from(
    { length: 12 },
    (_, i) => `64b7f0c2a1b2c3d4e5f60c${String(i).padStart(2, "0")}`,
  );
  assert.equal(
    formChanges(a, { ...formOf(a, []), skillIds: [...many, many[0]!] }).skillIds
      ?.length,
    10,
  );
});

test("a retried create reuses its request ID; a changed form gets a new one", () => {
  let n = 0;
  const ids = requestIds(() => `id-${++n}`);
  const form = formOf(null, [MODEL]);
  assert.equal(ids.for(form, "personal"), "id-1");
  assert.equal(ids.for({ ...form }, "personal"), "id-1");
  assert.equal(ids.for(form, "tenant"), "id-2");
  assert.equal(ids.for({ ...form, name: "x" }, "tenant"), "id-3");
  ids.reset();
  assert.equal(ids.for({ ...form, name: "x" }, "tenant"), "id-4");
});

test("groups, updates and picks agents", () => {
  const builtin = agent({
    id: "64b7f0c2a1b2c3d4e5f60bb1",
    source: "builtin",
    available: false,
  });
  const shared = agent({ id: "64b7f0c2a1b2c3d4e5f60bb2", source: "tenant" });
  const mine = agent();
  const groups = groupAgents([builtin, mine, shared]);
  assert.deepEqual(groups.builtin, [builtin]);
  assert.deepEqual(groups.personal, [mine]);
  assert.deepEqual(groups.tenant, [shared]);
  assert.equal(defaultAgent([builtin, mine])?.id, mine.id);
  assert.equal(defaultAgent([builtin]), null);

  const renamed = withAgent([builtin, mine], { ...mine, name: "New" });
  assert.deepEqual(
    renamed.map((a) => a.name),
    ["Scout", "New"],
  );
  assert.deepEqual(
    withAgent([builtin, mine], { ...mine, status: "archived" }).map(
      (a) => a.id,
    ),
    [builtin.id],
  );
  assert.equal(withAgent([builtin], mine).length, 2);
});

// ---- Write access: per-connector access in the agent body ----

const ref = (slug: string, access: "read_write" | "read_only") => ({
  slug,
  displayName: slug.charAt(0).toUpperCase() + slug.slice(1),
  icon: "plug",
  available: true,
  access,
});

test("create sends a read_only connector as an object and read_write as a string", async (t) => {
  const sent = mockFetch(t, { agent: agent() });
  await createTenantAgent(
    {
      name: "Builder",
      description: "Ships branches.",
      modelId: MODEL.id,
      look: 2,
      tint: "ice",
      connectorSlugs: ["github", "jira"],
      // github read_only (object), jira read_write (string, the default).
      connectorAccess: { github: "read_only" },
      skillIds: [],
      helpers: false,
    },
    "personal",
    "req-abcdef12",
  );
  const body = sent[0]?.body as { connectors: unknown[] };
  assert.deepEqual(body.connectors, [
    { slug: "github", access: "read_only" },
    "jira",
  ]);
});

test("formOf reads per-connector access from the agent", () => {
  const form = formOf(
    agent({
      connectors: [ref("github", "read_only"), ref("jira", "read_write")],
    }),
    [],
  );
  assert.deepEqual(form.connectorSlugs, ["github", "jira"]);
  // Only read_only is recorded; read_write is the default and left out.
  assert.deepEqual(form.connectorAccess, { github: "read_only" });
});

test("formChanges treats an access-only edit as a change and carries both fields", () => {
  const a = agent({ connectors: [ref("github", "read_write")] });
  const base = formOf(a, []);
  // Switch github to read_only: slugs are unchanged, access differs.
  const changes = formChanges(a, {
    ...base,
    connectorAccess: { github: "read_only" },
  });
  assert.deepEqual(changes.connectorSlugs, ["github"]);
  assert.deepEqual(changes.connectorAccess, { github: "read_only" });
});

test("formChanges reports no change when access matches", () => {
  const a = agent({ connectors: [ref("github", "read_only")] });
  assert.deepEqual(formChanges(a, formOf(a, [])), {});
});

test("edit PATCH sends connectors as the mixed shape when access changes", async (t) => {
  const a = agent({ connectors: [ref("github", "read_write")] });
  const sent = mockFetch(t, { agent: a });
  await updateTenantAgent(a.id, a.revision, {
    connectorSlugs: ["github"],
    connectorAccess: { github: "read_only" },
  });
  const body = sent[0]?.body as { connectors: unknown[] };
  assert.deepEqual(body.connectors, [{ slug: "github", access: "read_only" }]);
});

test("a read_write connector change sends a plain slug string", async (t) => {
  const a = agent({ connectors: [ref("github", "read_only")] });
  const sent = mockFetch(t, { agent: a });
  // Switch github back to read_write: the body is the plain slug.
  await updateTenantAgent(a.id, a.revision, {
    connectorSlugs: ["github"],
    connectorAccess: {},
  });
  const body = sent[0]?.body as { connectors: unknown[] };
  assert.deepEqual(body.connectors, ["github"]);
});

test("helpers: parsed from the agent, sent on create, and an edit sends only a change", () => {
  assert.equal(parseAgent({ ...agent(), helpers: true })?.helpers, true);
  assert.equal(parseAgent({ ...agent(), helpers: "yes" })?.helpers, false);
  const off = agent();
  assert.equal(formOf(null, []).helpers, false);
  assert.deepEqual(formChanges(off, { ...formOf(off, []), helpers: true }), {
    helpers: true,
  });
  const on = agent({ helpers: true });
  assert.deepEqual(formChanges(on, formOf(on, [])), {});
  assert.deepEqual(formChanges(on, { ...formOf(on, []), helpers: false }), {
    helpers: false,
  });
});

test("the list says whether this server allows helpers", async (t) => {
  mockFetch(t, { agents: [agent()], helpers: true });
  assert.equal((await fetchTenantAgents()).helpers, true);
});
