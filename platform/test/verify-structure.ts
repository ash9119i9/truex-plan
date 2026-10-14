// Explicit review evidence, not an automatic test that depends on /tmp:
// node node_modules/tsx/dist/cli.mjs test/verify-structure.ts <original-src>
import assert from "node:assert/strict";
import { resolve } from "node:path";
import ts from "typescript";
import { createSourceAudit, readPlatformSources } from "./source-guards";

const printer = ts.createPrinter({ removeComments: true });
const print = (node: ts.Node) =>
  printer.printNode(ts.EmitHint.Unspecified, node, node.getSourceFile());

function executableShape(node: ts.Node): string {
  const shape = (current: ts.Node): unknown => {
    const children: unknown[] = [];
    ts.forEachChild(current, (child) => {
      children.push(shape(child));
    });
    return [
      current.kind,
      ts.isIdentifier(current)
        ? current.escapedText
        : ts.isLiteralExpression(current) || ts.isTemplateLiteralToken(current)
          ? current.text
          : null,
      children,
    ];
  };
  return JSON.stringify(shape(node));
}

function executableDefinitions(sources: Map<string, string>) {
  const definitions = new Map<string, ts.Node>();
  const add = (name: string, node: ts.Node) => {
    assert.ok(
      !definitions.has(name),
      `Duplicate executable definition: ${name}`,
    );
    definitions.set(name, node);
  };
  for (const [path, text] of sources) {
    const source = ts.createSourceFile(
      path,
      text,
      ts.ScriptTarget.ES2022,
      true,
    );
    for (const statement of source.statements) {
      if (
        ts.isFunctionDeclaration(statement) &&
        statement.body &&
        statement.name
      )
        add(statement.name.text, statement.body);
      else if (ts.isClassDeclaration(statement) && statement.name) {
        for (const member of statement.members)
          if (
            (ts.isMethodDeclaration(member) ||
              ts.isGetAccessorDeclaration(member) ||
              ts.isSetAccessorDeclaration(member) ||
              ts.isConstructorDeclaration(member)) &&
            member.body
          )
            add(
              `${statement.name.text}.${ts.isConstructorDeclaration(member) ? "constructor" : member.name.getText(source)}`,
              member.body,
            );
      } else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations)
          if (declaration.initializer)
            add(declaration.name.getText(source), declaration.initializer);
      }
    }
  }
  return definitions;
}

export function verifyPublicAndStore(
  original: Map<string, string>,
  current: Map<string, string>,
) {
  let compared = 0;
  for (const [file, directories] of [
    ["public.ts", ["public", "streaming"]],
    ["store.ts", ["persistence"]],
  ] as const) {
    const before = new Map(
      [...original].filter(([path]) => path.endsWith(`/${file}`)),
    );
    assert.equal(before.size, 1, `Expected one original ${file}`);
    const after = new Map(
      [...current].filter(([path]) =>
        directories.some((directory) => path.includes(`/${directory}/`)),
      ),
    );
    const definitions = executableDefinitions(before);
    const moved = executableDefinitions(after);
    assert.ok(definitions.size, `Empty original definitions in ${file}`);
    for (const [name, body] of definitions) {
      const target =
        name === "Store.savePlan"
          ? "savePlan"
          : name === "Store.persist"
            ? "persist"
            : name;
      const implementation = moved.get(target);
      assert.ok(
        implementation,
        `Missing public/storage implementation: ${name}`,
      );
      assert.equal(
        executableShape(implementation),
        executableShape(body),
        `Public/storage executable body changed: ${name}`,
      );
      compared++;
    }
  }
  return compared;
}

function nodesOf(sources: Map<string, string>) {
  const nodes: ts.Node[] = [];
  for (const [path, text] of sources) {
    const source = ts.createSourceFile(
      path,
      text,
      ts.ScriptTarget.ES2022,
      true,
    );
    const visit = (node: ts.Node) => {
      nodes.push(node);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return nodes;
}

function assertForwarding(
  parameters: ts.NodeArray<ts.ParameterDeclaration>,
  arguments_: ts.NodeArray<ts.Expression>,
  label: string,
) {
  assert.equal(
    arguments_.length,
    parameters.length,
    `${label}: argument count`,
  );
  parameters.forEach((parameter, index) => {
    const argument = arguments_[index];
    if (ts.isIdentifier(parameter.name)) {
      const expected = `${parameter.dotDotDotToken ? "..." : ""}${parameter.name.text}`;
      assert.equal(
        print(argument),
        expected,
        `${label}: forwarding ${parameter.name.text}`,
      );
    } else {
      assert.ok(
        ts.isObjectBindingPattern(parameter.name),
        `${label}: unsupported binding`,
      );
      assert.ok(
        ts.isObjectLiteralExpression(argument),
        `${label}: missing destructured arguments`,
      );
      const expected = parameter.name.elements.map((element) => {
        assert.ok(
          ts.isIdentifier(element.name) && !element.dotDotDotToken,
          `${label}: unsupported destructuring`,
        );
        return [
          element.propertyName?.getText() ?? element.name.text,
          element.name.text,
        ];
      });
      const actual = argument.properties.map((property) => {
        if (ts.isShorthandPropertyAssignment(property))
          return [property.name.text, property.name.text];
        assert.ok(
          ts.isPropertyAssignment(property) &&
            ts.isIdentifier(property.initializer),
          `${label}: altered destructured argument`,
        );
        return [property.name.getText(), property.initializer.text];
      });
      assert.deepEqual(
        actual,
        expected,
        `${label}: destructured argument forwarding`,
      );
    }
  });
}

function signature(method: ts.MethodDeclaration) {
  // Keep defaults, destructuring, modifiers, generics and return annotations.
  const copy = ts.factory.updateMethodDeclaration(
    method,
    method.modifiers,
    method.asteriskToken,
    method.name,
    method.questionToken,
    method.typeParameters,
    method.parameters,
    method.type,
    ts.factory.createBlock([]),
  );
  return printer.printNode(
    ts.EmitHint.Unspecified,
    copy,
    method.getSourceFile(),
  );
}

const aliases: Record<string, Record<string, string>> = {
  "ProjectService.renameProject": { projectFor: "project" },
  "ProjectService.deleteProject": { projectFor: "project" },
  "ProjectService.setSessionProject": { projectFor: "project" },
  "ConnectorService.setAgentMcp": { agentMcpFor: "agentMcp" },
  "ConnectorService.setAgentTenantMcp": { agentTenantMcpFor: "agentTenantMcp" },
};

function normalizedBody(method: ts.MethodDeclaration) {
  assert.ok(method.body);
  assert.ok(ts.isClassDeclaration(method.parent));
  const map =
    aliases[`${method.parent.name?.text}.${method.name.getText()}`] ?? {};
  const transformation = ts.transform(method.body, [
    (context) => {
      const visit: ts.Visitor = (node) => {
        if (
          ts.isPropertyAccessExpression(node) &&
          node.expression.kind === ts.SyntaxKind.ThisKeyword &&
          map[node.name.text]
        )
          return ts.factory.updatePropertyAccessExpression(
            node,
            node.expression,
            ts.factory.createIdentifier(map[node.name.text]),
          );
        return ts.visitEachChild(node, visit, context);
      };
      return (node) => ts.visitNode(node, visit) as ts.Block;
    },
  ]);
  try {
    return printer.printNode(
      ts.EmitHint.Unspecified,
      transformation.transformed[0],
      method.getSourceFile(),
    );
  } finally {
    transformation.dispose();
  }
}

export function verifyStructure(
  original: Map<string, string>,
  current: Map<string, string>,
) {
  const oldNodes = nodesOf(original);
  const newNodes = nodesOf(current);
  const oldRoutes = createSourceAudit(original).routes;
  const newRoutes = createSourceAudit(current).routes;
  assert.ok(oldRoutes.length, "Original route inventory is empty");
  assert.deepEqual(
    newRoutes.map((route) => route.key).sort(),
    oldRoutes.map((route) => route.key).sort(),
    "HTTP route inventory changed",
  );
  for (const route of oldRoutes) {
    const moved = newRoutes.find((candidate) => candidate.key === route.key)!;
    assert.equal(
      print(moved.call),
      print(route.call),
      `Route body changed: ${route.key}`,
    );
  }

  const methods = (nodes: ts.Node[]) =>
    nodes
      .filter(ts.isMethodDeclaration)
      .filter(
        (method) => ts.isClassDeclaration(method.parent) && !!method.body,
      );
  const oldMethods = methods(oldNodes).filter(
    (method) =>
      (method.parent as ts.ClassDeclaration).name?.text === "PlatformService",
  );
  const newMethods = methods(newNodes);
  const facadeClass = newNodes.find(
    (node): node is ts.ClassDeclaration =>
      ts.isClassDeclaration(node) && node.name?.text === "PlatformService",
  );
  assert.ok(facadeClass, "Missing PlatformService class");
  const collaborators = new Map<string, string>();
  const visitBindings = (node: ts.Node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
      ts.isNewExpression(node.right)
    )
      collaborators.set(node.left.name.text, node.right.expression.getText());
    ts.forEachChild(node, visitBindings);
  };
  visitBindings(facadeClass);
  assert.ok(oldMethods.length, "Original PlatformService methods are missing");
  let extracted = 0;
  for (const before of oldMethods) {
    const name = before.name.getText();
    const facade = newMethods.find(
      (method) =>
        (method.parent as ts.ClassDeclaration).name?.text ===
          "PlatformService" && method.name.getText() === name,
    );
    if (
      !facade &&
      before.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword,
      )
    ) {
      const moved = newMethods.filter(
        (method) => method.name.getText() === name,
      );
      assert.equal(
        moved.length,
        1,
        `Missing/ambiguous private implementation: ${name}`,
      );
      assert.equal(
        signature(moved[0]),
        signature(before),
        `Private signature changed: ${name}`,
      );
      assert.equal(
        normalizedBody(moved[0]),
        normalizedBody(before),
        `Private method body changed: ${name}`,
      );
      extracted++;
      continue;
    }
    assert.ok(facade, `Missing facade method: ${name}`);
    assert.equal(
      signature(facade),
      signature(before),
      `Public signature changed: ${name}`,
    );
    if (normalizedBody(facade) === normalizedBody(before)) continue;
    const moved = newMethods.filter(
      (method) =>
        (method.parent as ts.ClassDeclaration).name?.text !==
          "PlatformService" && method.name.getText() === name,
    );
    assert.equal(
      moved.length,
      1,
      `Ambiguous/missing extracted implementation: ${name}`,
    );
    assert.equal(
      normalizedBody(moved[0]),
      normalizedBody(before),
      `Extracted method body changed: ${name}`,
    );
    assert.equal(
      facade.body!.statements.length,
      1,
      `${name}: facade does more than forward`,
    );
    const statement = facade.body!.statements[0];
    assert.ok(
      ts.isReturnStatement(statement) &&
        statement.expression &&
        ts.isCallExpression(statement.expression),
      `${name}: facade must return the delegated call`,
    );
    const call = statement.expression;
    assert.ok(
      ts.isPropertyAccessExpression(call.expression) &&
        call.expression.name.text === name,
      `${name}: wrong delegated method`,
    );
    const receiver = call.expression.expression;
    assert.ok(
      ts.isPropertyAccessExpression(receiver) &&
        receiver.expression.kind === ts.SyntaxKind.ThisKeyword,
      `${name}: wrong collaborator receiver`,
    );
    assert.equal(
      collaborators.get(receiver.name.text),
      (moved[0].parent as ts.ClassDeclaration).name!.text,
      `${name}: delegation targets the wrong constructed collaborator`,
    );
    assertForwarding(before.parameters, call.arguments, name);
    extracted++;
  }

  const functions = newNodes
    .filter(ts.isFunctionDeclaration)
    .filter((fn) => fn.name && fn.body);
  const expand = (statements: readonly ts.Statement[]): ts.Statement[] =>
    statements.flatMap((statement) => {
      if (
        !ts.isExpressionStatement(statement) ||
        !ts.isCallExpression(statement.expression) ||
        !ts.isIdentifier(statement.expression.expression) ||
        !/^register/.test(statement.expression.expression.text)
      )
        return [statement];
      const call = statement.expression;
      const name = (call.expression as ts.Identifier).text;
      const targets = functions.filter((fn) => fn.name!.text === name);
      assert.equal(
        targets.length,
        1,
        `Missing/ambiguous registration function: ${name}`,
      );
      assertForwarding(targets[0].parameters, call.arguments, name);
      return expand(targets[0].body!.statements);
    });
  const main = (nodes: ts.Node[]) => {
    const found = nodes
      .filter(ts.isFunctionDeclaration)
      .filter((fn) => fn.name?.text === "main" && fn.body);
    assert.equal(found.length, 1, "Expected one main bootstrap implementation");
    return found[0].body!;
  };
  assert.deepEqual(
    expand(main(newNodes).statements).map(print),
    main(oldNodes).statements.map(print),
    "Bootstrap/security/route/shutdown executable order changed",
  );
  return { routes: oldRoutes.length, methods: oldMethods.length, extracted };
}

if (require.main === module) {
  assert.ok(
    process.argv[2],
    "Usage: verify-structure.ts <original-src-directory>",
  );
  const original = readPlatformSources(resolve(process.argv[2]));
  const current = readPlatformSources();
  const result = verifyStructure(original, current);
  const publicStorage = verifyPublicAndStore(original, current);
  console.log(
    `AST preservation verified: ${result.routes} route bodies, ${result.methods} service methods (${result.extracted} delegated), ${publicStorage} public/storage bodies and initializers, complete expanded bootstrap order.`,
  );
}
