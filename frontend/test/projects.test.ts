import { beforeEach } from "node:test";
import { signInForTest, TENANT_ID } from "./auth-fixture.ts";
beforeEach(() => signInForTest());
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkProjectName,
  createProject,
  createSessionBody,
  deleteProject,
  draftProject,
  listProjectSessions,
  renameProject,
  sessionProjectActions,
  setSessionProject,
  sortProjects,
} from "../lib/projects.ts";
import type { Project } from "../../shared/contracts.ts";

const project = (id: string, name: string, updatedAt: string): Project => ({
  _id: id,
  name,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt,
});
const a = project("proj_a", "Alpha", "2026-02-01T00:00:00.000Z");
const b = project("proj_b", "Beta", "2026-03-01T00:00:00.000Z");
const c = project("proj_c", "Gamma", "2026-02-01T00:00:00.000Z");

function mockFetch(t: any, reply: unknown = {}, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(
      new URL(url, "http://test").searchParams.get("tenantId"),
      TENANT_ID,
    );
    calls.push({ url: url.replace(/[?&]tenantId=[0-9a-f]+/, ""), init });
    return new Response(JSON.stringify(reply), { status });
  });
  return calls;
}

test("project names are trimmed and limited to 80 characters", () => {
  assert.deepEqual(checkProjectName("  MCP Proj  "), {
    ok: true,
    name: "MCP Proj",
  });
  assert.equal(checkProjectName("   ").ok, false);
  assert.equal(checkProjectName("").ok, false);
  assert.equal(checkProjectName("x".repeat(80)).ok, true);
  assert.equal(checkProjectName("x".repeat(81)).ok, false);
  assert.equal(checkProjectName(` ${"x".repeat(80)} `).ok, true);
});

test("projects sort by most recent update, then name", () => {
  const input = [a, c, b];
  assert.deepEqual(
    sortProjects(input).map((p) => p._id),
    ["proj_b", "proj_a", "proj_c"],
  );
  assert.deepEqual(input, [a, c, b], "input is not mutated");
});

test("menu offers add for loose conversations and move/remove otherwise", () => {
  const loose = sessionProjectActions({}, [a, b]);
  assert.equal(loose.mode, "add");
  assert.equal(loose.canRemove, false);
  assert.deepEqual(
    loose.targets.map((p) => p._id),
    ["proj_a", "proj_b"],
  );
  const inA = sessionProjectActions({ projectId: "proj_a" }, [a, b]);
  assert.equal(inA.mode, "move");
  assert.equal(inA.canRemove, true);
  assert.equal(inA.current?._id, "proj_a");
  assert.deepEqual(
    inA.targets.map((p) => p._id),
    ["proj_b"],
  );
  const orphan = sessionProjectActions({ projectId: "proj_gone" }, [a]);
  assert.equal(orphan.canRemove, true);
  assert.equal(orphan.current, null);
});

test("draft project resolves only while the project exists", () => {
  assert.equal(draftProject(null, [a]), null);
  assert.equal(draftProject("proj_a", [a])?.name, "Alpha");
  assert.equal(draftProject("proj_gone", [a]), null);
});

test("session body includes projectId only when set", () => {
  assert.deepEqual(createSessionBody("agent", { on: true }), {
    agentId: "agent",
    subAgents: { on: true },
  });
  assert.deepEqual(createSessionBody("agent", 1, null), {
    agentId: "agent",
    subAgents: 1,
  });
  assert.deepEqual(createSessionBody("agent", 1, "proj_a"), {
    agentId: "agent",
    subAgents: 1,
    projectId: "proj_a",
  });
});

test("API helpers call the project endpoints", async (t) => {
  const calls = mockFetch(t, { ok: true });
  await createProject("  New one ");
  await renameProject("proj/a", "Renamed");
  await deleteProject("proj_a");
  await setSessionProject("s1", null);
  await setSessionProject("s1", "proj_b");
  await listProjectSessions("proj a");
  const summary = calls.map((c) => [
    c.init.method,
    c.url.replace(/^https?:\/\/[^/]+/, ""),
    c.init.body ? JSON.parse(String(c.init.body)) : undefined,
  ]);
  assert.deepEqual(summary, [
    ["POST", "/api/projects", { name: "New one" }],
    ["POST", "/api/projects/proj%2Fa", { name: "Renamed" }],
    ["POST", "/api/projects/proj_a/delete", {}],
    ["POST", "/api/sessions/s1/project", { projectId: null }],
    ["POST", "/api/sessions/s1/project", { projectId: "proj_b" }],
    ["GET", "/api/sessions?projectId=proj%20a", undefined],
  ]);
});

test("invalid names are rejected before any request", async (t) => {
  const calls = mockFetch(t);
  await assert.rejects(createProject("  "), /Enter a project name/);
  await assert.rejects(renameProject("proj_a", "x".repeat(81)), /80/);
  assert.equal(calls.length, 0);
});

test("server validation errors surface with their code", async (t) => {
  mockFetch(t, { error: "Invalid project name", code: "INVALID_PROJECT" }, 400);
  await assert.rejects(createProject("ok"), {
    message: "Invalid project name",
    code: "INVALID_PROJECT",
    status: 400,
  });
});

test("creation includes an explicit approval mode while preserving old body defaults", () => {
  assert.deepEqual(createSessionBody("agent", {}, "proj_a", "readOnly"), {
    agentId: "agent",
    subAgents: {},
    projectId: "proj_a",
    approvalMode: "readOnly",
  });
  assert.deepEqual(createSessionBody("agent", {}, null, "ask"), {
    agentId: "agent",
    subAgents: {},
    approvalMode: "ask",
  });
});
