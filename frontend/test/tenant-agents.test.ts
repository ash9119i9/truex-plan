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
  const agents = await fetchTenantAgents();
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
