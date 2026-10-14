import { test } from "node:test";
import assert from "node:assert/strict";
import { createSourceAudit, assertSessionRouteAccess } from "./source-guards";

const expected = { "GET /api/sessions/:id": "read" } as const;
const audit = (source: string) =>
  createSourceAudit(new Map([["/virtual/fixture.ts", source]]));

test("source guard follows facade delegation and injected access callbacks", () => {
  const source = `
    class ProjectService {
      constructor(private sessionFor: (id: string, mode: string) => unknown) {}
      load(id: string) { return this.sessionFor(id, "read"); }
    }
    class PlatformService {
      private projects: ProjectService;
      constructor() {
        const sessionFor = (id: string, mode: string) => this.sessionFor(id, mode);
        this.projects = new ProjectService(sessionFor);
      }
      sessionFor(id: string, mode: string) { return {}; }
      session(id: string) { return {}; }
      load(id: string) { return this.projects.load(id); }
    }
    const service = new PlatformService();
    const http = { get(...args: unknown[]) {} };
    function registerRoutes() {
      http.get("/api/sessions/:id", () => service.load("id"));
    }
  `;
  assert.doesNotThrow(() => assertSessionRouteAccess(audit(source), expected));
});

test("source guard rejects absent, duplicate and unenforced routes", () => {
  for (const source of [
    "",
    `const http: any = {}; http.get("/api/sessions/:id", () => ({}));`,
    `const http: any = {}; http.get("/api/sessions/:id", () => ({})); http.get("/api/sessions/:id", () => ({}));`,
    `class PlatformService { session(id: string) { return {}; } } const service = new PlatformService(); const http: any = {}; http.get("/api/sessions/:id", () => service.session("id"));`,
  ])
    assert.throws(() => assertSessionRouteAccess(audit(source), expected));
});

test("source guard rejects wrong access mode and a bare load before its check", () => {
  const prefix = `class PlatformService { sessionFor(id: string, mode: string) { return {}; } session(id: string) { return {}; } } const service = new PlatformService(); const http: any = {};`;
  for (const body of [
    `service.sessionFor("id", "write")`,
    `{ service.session("id"); service.sessionFor("id", "read"); }`,
  ])
    assert.throws(() =>
      assertSessionRouteAccess(
        audit(`${prefix} http.get("/api/sessions/:id", () => ${body});`),
        expected,
      ),
    );
});

test("source guard does not count comments or a different route's access check", () => {
  const source = `class PlatformService { sessionFor(id: string, mode: string) { return {}; } } const service = new PlatformService(); const http: any = {};
    http.get("/api/sessions/:id", () => { /* service.sessionFor("id", "read") */ return {}; });
    http.get("/other", () => service.sessionFor("id", "read"));`;
  assert.throws(() => assertSessionRouteAccess(audit(source), expected));
});

test("a callback named sessionFor must forward to the canonical access method", () => {
  const source = `
    class ProjectService {
      constructor(private sessionFor: (id: string, mode: string) => unknown) {}
      load(id: string) { return this.sessionFor(id, "read"); }
    }
    class PlatformService {
      private projects = new ProjectService((id, mode) => ({}));
      sessionFor(id: string, mode: string) { return {}; }
      load(id: string) { return this.projects.load(id); }
    }
    const service = new PlatformService(); const http: any = {};
    http.get("/api/sessions/:id", () => service.load("id"));
  `;
  assert.throws(
    () => assertSessionRouteAccess(audit(source), expected),
    /skips sessionFor/,
  );
  assert.throws(
    () =>
      assertSessionRouteAccess(
        audit(
          source.replace(
            "(id, mode) => ({})",
            '(id, mode) => this.sessionFor(id, "write")',
          ),
        ),
        expected,
      ),
    /should check "read"/,
  );
});
