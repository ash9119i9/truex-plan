import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, relative } from "node:path";
import ts from "typescript";
import { AUTHORIZATION_ROUTES } from "../src/authorization-routes";
import { CAPABILITY_ACTIONS, isAction } from "../../shared/authorization";
import { businessCapabilities } from "../../shared/business-capabilities";

const root = resolve("..");
const methods = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "all",
  "head",
  "options",
]);
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(resolve(directory, entry.name))
      : entry.name.endsWith(".ts")
        ? [resolve(directory, entry.name)]
        : [],
  );
}
function scan(
  source: string,
  text = readFileSync(resolve(root, source), "utf8"),
) {
  const file = ts.createSourceFile(source, text, ts.ScriptTarget.Latest, true);
  const found: {
    source: string;
    owner: string;
    method: string;
    path: string;
  }[] = [];
  function visit(node: ts.Node, owner = "module") {
    if (ts.isFunctionDeclaration(node) && node.name) owner = node.name.text;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      methods.has(node.expression.name.text)
    ) {
      const argument = node.arguments[0];
      const receiver = node.expression.expression.getText(file);
      // Discover literal route declarations regardless of receiver naming.
      // Known routers must use statically inventoried paths.
      if (
        argument &&
        ts.isStringLiteralLike(argument) &&
        argument.text.startsWith("/")
      )
        found.push({
          source,
          owner,
          method: node.expression.name.text.toUpperCase(),
          path: argument.text,
        });
      else if (["http", "app", "router"].includes(receiver))
        assert.fail(
          `Dynamic HTTP route needs an explicit inventory: ${source}: ${node.getText(file)}`,
        );
    }
    ts.forEachChild(node, (child) => visit(child, owner));
  }
  visit(file);
  return found;
}
const key = (r: {
  source: string;
  owner: string;
  method: string;
  path: string;
}) => `${r.source} ${r.owner} ${r.method} ${r.path}`;

test("every platform/runtime HTTP route declares a required authorization boundary", () => {
  const found = ["platform/src", "agent-core/src"].flatMap((dir) =>
    files(resolve(root, dir)).flatMap((file) => scan(relative(root, file))),
  );
  const expected = new Map(AUTHORIZATION_ROUTES.map((r) => [key(r), r]));
  assert.equal(
    expected.size,
    AUTHORIZATION_ROUTES.length,
    "duplicate route mapping",
  );
  assert.deepEqual(
    found.map(key).sort(),
    [...expected.keys()].sort(),
    "missing/stale route mapping",
  );
  for (const route of AUTHORIZATION_ROUTES) {
    assert.ok(route.actions.every(isAction), key(route));
    if (
      ["resource", "admission", "control-plane", "worker", "stream"].includes(
        route.boundary,
      )
    )
      assert.ok(route.actions.length, `No action: ${key(route)}`);
    if (["health", "blocked"].includes(route.boundary))
      assert.equal(route.actions.length, 0, key(route));
  }
});

test("route discovery catches renamed receivers and rejects dynamic known routes", () => {
  const route = scan(
    "fixture.ts",
    'function routes() { newRouter.post("/secret", handler); }',
  );
  assert.equal(route[0].owner, "routes");
  assert.equal(route[0].path, "/secret");
  assert.ok(!AUTHORIZATION_ROUTES.some((r) => key(r) === key(route[0])));
  assert.throws(
    () => scan("fixture.ts", "app.post(path, handler)"),
    /Dynamic HTTP route/,
  );
});

test("every allowed business capability has a fixed action", () => {
  assert.deepEqual(
    Object.keys(CAPABILITY_ACTIONS).sort(),
    Object.keys(businessCapabilities).sort(),
  );
  assert.ok(Object.values(CAPABILITY_ACTIONS).every(isAction));
});
