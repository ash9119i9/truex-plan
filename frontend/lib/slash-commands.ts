export const slashCommands = [
  {
    name: "/goal",
    description: "View goal, or use /goal <objective> or /goal clear",
  },
  { name: "/fork", description: "Create a new conversation branch" },
  { name: "/compact", description: "Summarize this conversation context" },
  { name: "/model", description: "Change model: /model <model name>" },
  { name: "/effort", description: "Change reasoning: /effort <level>" },
  { name: "/archive", description: "Archive this conversation" },
  { name: "/unarchive", description: "Restore this conversation" },
  { name: "/help", description: "Show available chat commands" },
];

export function suggestCommands(text: string) {
  // Once arguments or a second line start, editing keys belong to the draft.
  return /^\/[a-z]*$/i.test(text)
    ? slashCommands.filter((command) =>
        command.name.startsWith(text.toLowerCase()),
      )
    : [];
}

type ParsedInput =
  | { kind: "message"; text: string }
  | { kind: "invalid"; message: string }
  | { kind: "help" }
  | {
      kind: "command";
      method: string;
      params: Record<string, unknown>;
      success: string;
    };

export function parseChatInput(text: string): ParsedInput {
  const trimmed = text.trim();
  // Escape a literal command with //; ordinary paths and slash text stay messages.
  if (trimmed.startsWith("//"))
    return { kind: "message", text: text.replace("//", "/") };
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  const name = match ? `/${match[1].toLowerCase()}` : "";
  if (!slashCommands.some((command) => command.name === name))
    return { kind: "message", text };
  const argument = (match?.[2] || "").trim();
  const command = (
    method: string,
    success: string,
    params: Record<string, unknown> = {},
  ): ParsedInput => ({ kind: "command", method, params, success });
  if (name === "/goal") {
    if (!argument || argument.toLowerCase() === "show")
      return command("thread/goal/get", "");
    if (argument.toLowerCase() === "clear")
      return command("thread/goal/clear", "Goal cleared.");
    return command("thread/goal/set", "Goal updated.", { objective: argument });
  }
  if (name === "/model") {
    if (!argument || /\s/.test(argument))
      return { kind: "invalid", message: "Usage: /model <model identifier>" };
    return command("thread/settings/update", `Model changed to ${argument}.`, {
      model: argument,
    });
  }
  if (name === "/effort") {
    const effort = argument.toLowerCase();
    if (
      !["none", "minimal", "low", "medium", "high", "xhigh", "ultra"].includes(
        effort,
      )
    )
      return {
        kind: "invalid",
        message: "Usage: /effort <none|minimal|low|medium|high|xhigh|ultra>",
      };
    return command(
      "thread/settings/update",
      `Reasoning effort changed to ${effort}.`,
      { effort },
    );
  }
  if (argument)
    return {
      kind: "invalid",
      message: `${name} takes no arguments. Use /help for command syntax, or prefix with // to send it as a question.`,
    };
  switch (name) {
    case "/help":
      return { kind: "help" };
    case "/fork":
      return command("thread/fork", "Created a conversation branch.");
    case "/compact":
      return command("thread/compact/start", "Context compaction requested.");
    case "/archive":
      return command("thread/archive", "Conversation archived.");
    default:
      return command("thread/unarchive", "Conversation restored.");
  }
}
