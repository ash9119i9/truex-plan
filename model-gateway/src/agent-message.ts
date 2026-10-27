// Codex multi-agent V2 passes work between agents as `agent_message` input
// items: the task a lead gives a helper, and the helper's answer back to the
// lead. Chat-style APIs have no such item, so adapters send it as user text.
// It is never the receiving model's own output, and it can carry text a
// helper read from a connector, so it must not be sent as assistant text.
//
// The task part arrives as `encrypted_content`. Codex labels it that way for
// providers that decrypt it server-side; with this gateway it holds the
// lead's plain message (verified on the pin, runtime-adapter
// test/codex/subagents-probe.test.ts), so it is read as text.
export function agentMessageText(item: any): string {
  return (Array.isArray(item?.content) ? item.content : [])
    .map((part: any) =>
      part?.type === "input_text" && typeof part.text === "string"
        ? part.text
        : part?.type === "encrypted_content" &&
            typeof part.encrypted_content === "string"
          ? part.encrypted_content
          : "",
    )
    .join("")
    .trim();
}
