// Model-profile settings, read by the gateway. Opt-in for Chat-compatible
// endpoints: supporting the Chat API does not imply support for cache options.
export type PromptCachePolicy =
  | {
      type: "chat";
      keyScope?: "session" | "prefix";
      retention?: "in_memory" | "24h";
    }
  | {
      type: "anthropic";
      enabled?: boolean;
      ttl?: "5m" | "1h";
      conversationBreakpoint?: boolean;
    };
