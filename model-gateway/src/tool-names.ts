import { createHash } from "node:crypto";

// Codex groups some tools (MCP servers, collaboration) under a namespace and
// expects calls back with `name` and `namespace` separately. Chat-style APIs
// only accept flat names matching ^[a-zA-Z0-9_-]{1,64}$, so names are
// flattened on the way out and restored on the way back.

export interface ToolRef {
  name: string;
  namespace?: string;
  // A Responses custom (freeform) tool offered to the provider as a function
  // taking one string, `input`. Its calls go back to Codex as
  // custom_tool_call items carrying that string.
  custom?: boolean;
}

const MAX_NAME = 64;

// A namespace description is where Codex puts an MCP server's own instructions.
// Chat-style APIs have no namespace, so the text moves to the system prompt
// instead of being dropped.
export function systemPrompt(input: any): string[] {
  const notes: string[] = [];
  for (const tool of input.tools ?? []) {
    const description =
      tool?.type === "namespace" && typeof tool.description === "string"
        ? tool.description.trim()
        : "";
    if (description)
      notes.push(
        `Instructions for the tools named ${String(tool.name).replace(/_+$/, "")}__*:\n${description}`,
      );
  }
  return [...(input.instructions ? [input.instructions] : []), ...notes];
}

// Codex offers apply_patch as a custom tool: the model writes the patch text
// directly, constrained by a Lark grammar. Only OpenAI's Responses API has
// custom tools, so other providers get a function with one string argument
// and the grammar in its description. Codex parses and verifies the patch
// itself, so a malformed one is reported back to the model, not applied.
export function customToolAsFunction(tool: any): any {
  const grammar =
    typeof tool?.format?.definition === "string" ? tool.format.definition : "";
  return {
    type: "function",
    name: tool.name,
    description: [
      `The \`${tool.name}\` tool. Pass the complete tool input as the \`input\` string.`,
      ...(grammar
        ? [`\`input\` must match this grammar (Lark syntax):\n${grammar}`]
        : []),
    ].join("\n\n"),
    parameters: {
      type: "object",
      properties: { input: { type: "string" } },
      required: ["input"],
      additionalProperties: false,
    },
  };
}

export class ToolNames {
  private readonly flat = new Map<string, ToolRef>();

  toProvider(ref: ToolRef): string {
    const raw = ref.namespace
      ? `${ref.namespace.replace(/_+$/, "")}__${ref.name.replace(/^_+/, "")}`
      : ref.name;
    let name = raw.replace(/[^a-zA-Z0-9_-]/g, "_");
    if (name.length > MAX_NAME || this.taken(name, ref))
      name = name.slice(0, MAX_NAME - 9) + "_" + digest(raw);
    // A history call carries no `custom` flag; keep the one the tool list
    // registered.
    const known = this.flat.get(name);
    this.flat.set(name, known?.custom ? { ...ref, custom: true } : ref);
    return name;
  }

  fromProvider(name: string): ToolRef {
    return this.flat.get(name) ?? { name };
  }

  private taken(name: string, ref: ToolRef) {
    const existing = this.flat.get(name);
    return (
      !!existing &&
      (existing.name !== ref.name || existing.namespace !== ref.namespace)
    );
  }
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}
