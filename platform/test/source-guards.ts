import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

export type AccessMode = "read" | "write" | "method";
type BodyFunction = ts.FunctionLikeDeclaration & { body: ts.ConciseBody };
type Bindings = Map<string, AccessMode>;

function descendants(node: ts.Node): ts.Node[] {
  const result: ts.Node[] = [];
  const visit = (child: ts.Node) => {
    result.push(child);
    ts.forEachChild(child, visit);
  };
  visit(node);
  return result;
}

export function readPlatformSources(directory = resolve("src")) {
  const sources = new Map<string, string>();
  const visit = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = resolve(path, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.name.endsWith(".ts"))
        sources.set(file, readFileSync(file, "utf8"));
    }
  };
  visit(directory);
  return sources;
}

export function createSourceAudit(sources: Map<string, string>) {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    noLib: true,
    experimentalDecorators: true,
  };
  const host = ts.createCompilerHost(options);
  const originalRead = host.readFile.bind(host);
  const originalExists = host.fileExists.bind(host);
  host.readFile = (file) => sources.get(resolve(file)) ?? originalRead(file);
  host.fileExists = (file) =>
    sources.has(resolve(file)) || originalExists(file);
  const program = ts.createProgram([...sources.keys()], options, host);
  const checker = program.getTypeChecker();
  const files = [...sources.keys()].map((file) => {
    const source = program.getSourceFile(file);
    assert.ok(source, `Source guard cannot parse ${file}`);
    assert.equal(
      program.getSyntacticDiagnostics(source).length,
      0,
      `Invalid source: ${file}`,
    );
    return source;
  });
  const nodes = files.flatMap(descendants);
  const constructors = nodes.filter(ts.isNewExpression);
  const routes = nodes
    .filter(ts.isCallExpression)
    .filter(
      (call) =>
        ts.isPropertyAccessExpression(call.expression) &&
        call.expression.expression.getText() === "http" &&
        /^(get|post|delete|put|patch)$/.test(call.expression.name.text),
    )
    .map((call) => {
      const path = call.arguments[0];
      assert.ok(
        path && ts.isStringLiteral(path),
        "HTTP route must use a literal full path",
      );
      const member = call.expression as ts.PropertyAccessExpression;
      return {
        key: `${member.name.text.toUpperCase()} ${path.text}`,
        method: member.name.text.toUpperCase(),
        path: path.text,
        call,
      };
    });
  assert.equal(
    new Set(routes.map((route) => route.key)).size,
    routes.length,
    "Duplicate HTTP routes",
  );

  function targets(call: ts.CallExpression): BodyFunction[] {
    const declaration = checker.getResolvedSignature(call)?.declaration;
    if (declaration && "body" in declaration && declaration.body)
      return [declaration as BodyFunction];
    // A collaborator's constructor callback is a real dependency, not an
    // access check just because its property happens to be named sessionFor.
    if (!ts.isPropertyAccessExpression(call.expression)) return [];
    const declarations =
      checker.getSymbolAtLocation(call.expression.name)?.declarations ?? [];
    const callbacks: BodyFunction[] = [];
    for (const parameter of declarations) {
      if (
        !ts.isParameter(parameter) ||
        !ts.isConstructorDeclaration(parameter.parent)
      )
        continue;
      const owner = parameter.parent.parent;
      if (!ts.isClassDeclaration(owner) || !owner.name) continue;
      const index = parameter.parent.parameters.indexOf(parameter);
      const ownerSymbol = checker.getSymbolAtLocation(owner.name);
      let instances = 0;
      for (const creation of constructors) {
        let symbol = checker.getSymbolAtLocation(creation.expression);
        if (symbol && symbol.flags & ts.SymbolFlags.Alias)
          symbol = checker.getAliasedSymbol(symbol);
        if (symbol !== ownerSymbol) continue;
        instances++;
        assert.equal(
          instances,
          1,
          `Ambiguous callback instance: ${owner.name.text}.${parameter.name.getText()}`,
        );
        let callback = creation.arguments?.[index];
        if (callback && ts.isIdentifier(callback)) {
          const value = checker.getSymbolAtLocation(callback)?.valueDeclaration;
          if (value && ts.isVariableDeclaration(value))
            callback = value.initializer;
        }
        if (
          callback &&
          (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
        )
          callbacks.push(callback);
      }
    }
    return callbacks;
  }

  const modeOf = (
    value: ts.Expression | undefined,
    bindings: Bindings,
  ): AccessMode => {
    if (
      value &&
      ts.isStringLiteral(value) &&
      (value.text === "read" || value.text === "write")
    )
      return value.text;
    if (value && ts.isIdentifier(value))
      return bindings.get(value.text) ?? "method";
    return "method";
  };

  function accessModes(node: ts.Node): AccessMode[] {
    const modes: AccessMode[] = [];
    const visited = new Set<string>();
    const canonical = (target: BodyFunction) =>
      ts.isMethodDeclaration(target) &&
      target.name.getText() === "sessionFor" &&
      ts.isClassDeclaration(target.parent) &&
      target.parent.name?.text === "PlatformService";
    const argumentsFor = (
      target: BodyFunction,
      call: ts.CallExpression,
      bindings: Bindings,
    ) => {
      const next = new Map<string, AccessMode>();
      target.parameters.forEach((parameter, index) => {
        if (ts.isIdentifier(parameter.name))
          next.set(
            parameter.name.text,
            modeOf(call.arguments[index], bindings),
          );
      });
      return next;
    };
    const inspect = (body: ts.Node, bindings: Bindings) => {
      const calls = descendants(body).filter(ts.isCallExpression);
      const direct: AccessMode[] = [];
      for (const call of calls)
        for (const target of targets(call)) {
          if (canonical(target))
            direct.push(modeOf(call.arguments[1], bindings));
          else if (
            ts.isArrowFunction(target) &&
            ts.isCallExpression(target.body)
          ) {
            // The injected callback must actually forward to the canonical
            // access method; its argument bindings preserve the caller's mode.
            if (targets(target.body).some(canonical))
              direct.push(
                modeOf(
                  target.body.arguments[1],
                  argumentsFor(target, call, bindings),
                ),
              );
          }
        }
      // Once this operation checks access, downstream operations may perform
      // further capability-specific checks. Preserve the original guard's
      // focus on the route's initial direct/delegated access rule.
      if (direct.length) {
        modes.push(...direct);
        return;
      }
      for (const call of calls)
        for (const target of targets(call)) {
          const next = argumentsFor(target, call, bindings);
          const key = `${target.getSourceFile().fileName}:${target.pos}:${JSON.stringify([...next])}`;
          if (visited.has(key)) continue;
          visited.add(key);
          inspect(target.body, next);
        }
    };
    inspect(node, new Map());
    return modes;
  }
  return { routes, accessModes };
}

export function assertSessionRouteAccess(
  audit: ReturnType<typeof createSourceAudit>,
  expected: Record<string, AccessMode>,
) {
  const routes = audit.routes.filter((route) =>
    route.path.startsWith("/api/sessions/:id"),
  );
  assert.ok(routes.length, "No session routes discovered");
  assert.deepEqual(
    routes.map((route) => route.key).sort(),
    Object.keys(expected).sort(),
  );
  for (const route of routes) {
    const modes = audit.accessModes(route.call);
    assert.ok(modes.length, `${route.key} skips sessionFor`);
    if (expected[route.key] !== "method")
      assert.ok(
        modes.every((mode) => mode === expected[route.key]),
        `${route.key} should check "${expected[route.key]}"; found ${modes.join(", ")}`,
      );
    const calls = descendants(route.call).filter(ts.isCallExpression);
    const bare = calls.find(
      (call) =>
        ts.isPropertyAccessExpression(call.expression) &&
        call.expression.getText() === "service.session",
    );
    if (bare) {
      const direct = calls.find(
        (call) =>
          ts.isPropertyAccessExpression(call.expression) &&
          call.expression.getText() === "service.sessionFor",
      );
      assert.ok(
        direct && direct.pos < bare.pos,
        `${route.key} loads the session before checking access`,
      );
    }
  }
}
