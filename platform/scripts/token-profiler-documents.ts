import ts from "typescript";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Store } from "../src/store";
import { tenantContext, tenantId } from "../src/tenant";
import { Redactor } from "../../agent-core/src/redact";

function normalize(value: any): any {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    if (typeof value.$oid === "string" && Object.keys(value).length === 1)
      return value.$oid;
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, normalize(v)]),
    );
  }
  return value;
}
/** Parse exported Mongo shell data without evaluating user-supplied JavaScript. */
export function parseDocumentText(text: string, filename = "document"): any {
  try {
    return normalize(JSON.parse(text));
  } catch {
    /* Try a restricted data literal. */
  }
  const prefix = "const document = (";
  const source = ts.createSourceFile(
    "document.ts",
    prefix + text + "\n);",
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const diagnostics = (
    source as ts.SourceFile & { parseDiagnostics: ts.Diagnostic[] }
  ).parseDiagnostics;
  const fail = (node?: ts.Node): never => {
    const offset = Math.max(
      0,
      (node?.getStart(source) ?? diagnostics[0]?.start ?? prefix.length) -
        prefix.length,
    );
    const before = text.slice(0, offset);
    const line = before.split("\n").length;
    const column = offset - before.lastIndexOf("\n");
    throw new Error(
      `${filename}: invalid document at line ${line}, column ${column}. Use JSON or a Mongo shell object with ObjectId/NumberInt/NumberLong/ISODate constructors; executable JavaScript is not supported.`,
    );
  };
  if (
    diagnostics.length ||
    source.statements.length !== 1 ||
    !ts.isVariableStatement(source.statements[0])
  )
    fail();
  const declaration = (source.statements[0] as ts.VariableStatement)
    .declarationList.declarations;
  if (declaration.length !== 1 || !declaration[0].initializer) fail();
  const visit = (node: ts.Node): any => {
    if (ts.isParenthesizedExpression(node)) return visit(node.expression);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      return node.text;
    if (ts.isNumericLiteral(node)) {
      const value = Number(node.text);
      if (!Number.isFinite(value)) fail(node);
      return value;
    }
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    if (
      ts.isPrefixUnaryExpression(node) &&
      [ts.SyntaxKind.MinusToken, ts.SyntaxKind.PlusToken].includes(
        node.operator,
      )
    ) {
      const value = visit(node.operand);
      if (typeof value !== "number") fail(node);
      return node.operator === ts.SyntaxKind.MinusToken ? -value : value;
    }
    if (ts.isArrayLiteralExpression(node)) return node.elements.map(visit);
    if (ts.isObjectLiteralExpression(node)) {
      const entries = node.properties.map((property) => {
        if (!ts.isPropertyAssignment(property)) fail(property);
        const assignment = property as ts.PropertyAssignment;
        const name = assignment.name;
        if (
          !ts.isIdentifier(name) &&
          !ts.isStringLiteral(name) &&
          !ts.isNumericLiteral(name)
        )
          fail(name);
        return [
          (name as ts.Identifier | ts.StringLiteral | ts.NumericLiteral).text,
          visit(assignment.initializer),
        ];
      });
      return Object.fromEntries(entries);
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      if (!ts.isIdentifier(node.expression)) fail(node);
      const name = (node.expression as ts.Identifier).text;
      const args = node.arguments || [];
      if (
        args.length !== 1 ||
        !["ObjectId", "NumberInt", "NumberLong", "ISODate", "Date"].includes(
          name,
        )
      )
        fail(node);
      const value = visit(args[0]);
      if (name === "ObjectId") {
        if (typeof value !== "string" || !/^[a-f0-9]{24}$/i.test(value))
          fail(node);
        return value;
      }
      if (name === "NumberInt" || name === "NumberLong") {
        if (
          !["string", "number"].includes(typeof value) ||
          !/^-?\d+$/.test(String(value))
        )
          fail(node);
        const numeric = Number(value);
        if (
          name === "NumberInt" &&
          (!Number.isInteger(numeric) ||
            numeric < -2147483648 ||
            numeric > 2147483647)
        )
          fail(node);
        return Number.isSafeInteger(numeric) ? numeric : String(value);
      }
      if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
        fail(node);
      return new Date(value).toISOString();
    }
    return fail(node);
  };
  return normalize(visit(declaration[0].initializer!));
}
// A credential field may hold "${NAME}" instead of the credential, so document
// files can be committed without secrets. Only the whole value is a reference;
// every other string, including placeholder text, is used as written.
const credentialFields = ["apiKey", "apikey"] as const;
const credentialReference = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
/** Replaces "${NAME}" credential references in a document with env values. */
export function resolveCredentialReferences(
  row: Record<string, any>,
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, any> {
  const resolved = { ...row };
  for (const field of credentialFields) {
    const reference = credentialReference.exec(String(row[field] ?? ""));
    if (!reference) continue;
    // Name the variable only: the error must never carry a credential.
    if (!env[reference[1]])
      throw new Error(
        `${path}: ${field} refers to environment variable ${reference[1]}, which is not set or is empty`,
      );
    resolved[field] = env[reference[1]];
  }
  return resolved;
}
export async function readDocuments(path: string): Promise<any[]> {
  const value = parseDocumentText(await readFile(resolve(path), "utf8"), path);
  const rows = Array.isArray(value) ? value : [value];
  if (rows.some((r) => !r || typeof r !== "object" || Array.isArray(r)))
    throw new Error(
      `${path}: document files must contain an object or array of objects`,
    );
  return rows.map((row) => resolveCredentialReferences(row, path));
}
/** Minimal read-only Store surface used by the production configuration builder. */
export function documentStore(
  agent: any,
  model: any,
  mcps: any[] = [],
  skills: any[] = [],
): Store {
  if (!agent._id || !agent.modelProfileId)
    throw new Error("Agent document requires _id and modelProfileId");
  if (!model._id || String(model._id) !== String(agent.modelProfileId))
    throw new Error("Model document _id must match agent.modelProfileId");
  if (agent.enabled === false || model.enabled === false)
    throw new Error("Agent/model document is disabled");
  for (const mcp of mcps) {
    if (mcp.scope && !["tenant", "user"].includes(mcp.scope))
      throw new Error("MCP scope must be tenant or user");
    if (mcp.scope === "user" && !mcp.ownerId)
      throw new Error("User MCP document requires ownerId");
  }
  // Explicit files represent attached connectors when attachment fields are absent.
  const connectors = mcps.map((m) => ({
    ...m,
    scope: m.scope || "tenant",
    agentIds: m.agentIds ?? [String(agent._id)],
  }));
  const matches = (row: any, query: any) =>
    Object.entries(query).every(([key, wanted]: any) => {
      const actual = row[key];
      if (wanted && typeof wanted === "object" && "$ne" in wanted)
        return actual !== wanted.$ne;
      return Array.isArray(actual)
        ? actual.includes(wanted)
        : actual === wanted;
    });
  return {
    connect: async () => {},
    client: { close: async () => {} },
    resolveTenant: async (id: string) => ({
      id: tenantId(id),
      dbName: "document-input",
    }),
    withTenant: (tenant: any, fn: any) => tenantContext.run(tenant, fn),
    findAgent: async (id: string) => (String(agent._id) === id ? agent : null),
    findModel: async (id: any) =>
      String(model._id) === String(id) ? model : null,
    findSkills: async (ids: any[]) =>
      skills.filter(
        (s) =>
          s.enabled !== false && ids.some((id) => String(id) === String(s._id)),
      ),
    mcp: {
      find: (query: any) => {
        let rows = connectors.filter((row) => matches(row, query));
        const cursor = {
          sort: () => {
            rows = rows.sort((a, b) =>
              String(a.name).localeCompare(String(b.name)),
            );
            return cursor;
          },
          toArray: async () => rows,
        };
        return cursor;
      },
    },
  } as unknown as Store;
}
export function safeError(
  error: any,
  redactor: Redactor,
): { message: string; code?: string; status?: number; cause?: string } {
  const clean = (value: unknown) =>
    redactor
      .clean(String(value))
      .replace(/https?:\/\/[^\s"'<>]+/gi, "[URL REDACTED]")
      .slice(0, 1500);
  return {
    message: clean(error?.message || "Unknown failure"),
    ...(typeof error?.code === "string" ? { code: clean(error.code) } : {}),
    ...(typeof error?.status === "number" ? { status: error.status } : {}),
    ...(error?.cause
      ? { cause: clean(error.cause.message || error.cause) }
      : {}),
  };
}
