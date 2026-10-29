import Ajv, { type ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020";
import type { Collection } from "mongodb";
import { toolHash } from "./tool-hash";

// Checks a tools/call's arguments against the input schema of the tool
// definition a person reviewed (policy.ts offers a tool only while its live
// definition hashes to the reviewed one). The gateway keeps each definition
// it listed, keyed by that hash, in a shared collection, so any instance can
// check a call that follows a tools/list another instance served. A stored
// definition is used only if it still hashes to its key.
//
// Schemas are compiled with ajv: draft-07 when the schema says so, else
// 2020-12 (the MCP spec's default). Unknown keywords are allowed, since
// providers add their own; a schema ajv can't compile refuses the call.

const DEFAULT_MAX_ARGUMENT_BYTES = 64 * 1024;
// Compiled validators kept in memory, by definition hash.
const MAX_CACHED = 1000;

export interface StoredDefinition {
  _id: string;
  definition: Record<string, unknown>;
  storedAt: Date;
}

export type ArgumentVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason:
        | "too_large"
        | "not_object"
        | "unknown_tool"
        | "invalid"
        | "schema_unusable";
      // Readable by the model; never carries argument values.
      readonly message: string;
    };

export interface ArgumentCheckerOptions {
  readonly definitions?: Collection<StoredDefinition>;
  readonly maxArgumentBytes?: number;
  readonly log?: (event: string, fields: Record<string, unknown>) => void;
}

export interface ArgumentChecker {
  // Called for each tool a tools/list offered.
  remember(hash: string, definition: Record<string, unknown>): Promise<void>;
  check(tool: string, hash: string, args: unknown): Promise<ArgumentVerdict>;
}

type Compiled =
  { readonly validate: ValidateFunction } | { readonly error: true };

export function createArgumentChecker(
  options: ArgumentCheckerOptions = {},
): ArgumentChecker {
  const maxBytes = options.maxArgumentBytes ?? DEFAULT_MAX_ARGUMENT_BYTES;
  const log = options.log ?? (() => {});
  const ajv2020 = new Ajv2020({ strict: false, allErrors: false });
  const ajv07 = new Ajv({ strict: false, allErrors: false });
  const compiled = new Map<string, Compiled>();

  function compile(hash: string, definition: Record<string, unknown>) {
    const hit = compiled.get(hash);
    if (hit) return hit;
    const schema = definition.inputSchema;
    let entry: Compiled;
    try {
      if (
        typeof schema !== "object" ||
        schema === null ||
        Array.isArray(schema)
      )
        throw new Error("inputSchema is not an object");
      const dialect = (schema as { $schema?: unknown }).$schema;
      const ajv =
        typeof dialect === "string" && dialect.includes("draft-07")
          ? ajv07
          : ajv2020;
      entry = { validate: ajv.compile(schema) };
    } catch {
      entry = { error: true };
    }
    if (compiled.size >= MAX_CACHED)
      compiled.delete(compiled.keys().next().value!);
    compiled.set(hash, entry);
    return entry;
  }

  async function definitionFor(
    hash: string,
  ): Promise<Record<string, unknown> | undefined> {
    const stored = await options.definitions?.findOne({ _id: hash });
    if (!stored) return undefined;
    try {
      if (toolHash(stored.definition) === hash) return stored.definition;
    } catch {
      // Unhashable: treated as missing.
    }
    log("tool_definition_mismatch", { hash: hash.slice(0, 12) });
    return undefined;
  }

  return {
    async remember(hash, definition) {
      // Already compiled here means already stored: repeated tools/list
      // calls cost no database writes.
      if (compiled.has(hash)) return;
      compile(hash, definition);
      await options.definitions?.updateOne(
        { _id: hash },
        { $setOnInsert: { definition, storedAt: new Date() } },
        { upsert: true },
      );
    },

    async check(tool, hash, args) {
      const value = args === undefined ? {} : args;
      if (typeof value !== "object" || value === null || Array.isArray(value))
        return refuse(
          "not_object",
          `${tool} needs its arguments as an object.`,
        );
      if (Buffer.byteLength(JSON.stringify(value)) > maxBytes)
        return refuse(
          "too_large",
          `${tool}'s arguments are larger than the ${Math.round(maxBytes / 1024)} KB the Truex gateway accepts.`,
        );
      let entry = compiled.get(hash);
      if (!entry) {
        const definition = await definitionFor(hash);
        if (!definition)
          return refuse(
            "unknown_tool",
            `${tool} hasn't been listed in this chat yet. List the tools, then call it again.`,
          );
        entry = compile(hash, definition);
      }
      if ("error" in entry)
        return refuse(
          "schema_unusable",
          `${tool}'s input schema can't be checked, so the Truex gateway doesn't run it.`,
        );
      if (entry.validate(value)) return { ok: true };
      const first = entry.validate.errors?.[0];
      const where = first?.instancePath || "(the arguments)";
      return refuse(
        "invalid",
        `${tool}'s arguments don't match its schema: ${where} ${first?.message ?? "is invalid"}.`,
      );
    },
  };
}

function refuse(
  reason: Exclude<ArgumentVerdict, { ok: true }>["reason"],
  message: string,
): ArgumentVerdict {
  return { ok: false, reason, message };
}
