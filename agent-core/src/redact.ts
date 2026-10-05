const sensitive =
  /(apikey|api_key|experimental_bearer_token|access_token|refresh_token|authorization|token$|secret|password|[-_]key$|^http_headers$|^env_http_headers$)/i;

const replacement = "[REDACTED]";
type SecretPattern = { value: string; prefixes: number[] };

function pattern(value: string): SecretPattern {
  const prefixes = new Array<number>(value.length).fill(0);
  for (let index = 1, length = 0; index < value.length; index++) {
    while (length && value[index] !== value[length])
      length = prefixes[length - 1];
    if (value[index] === value[length]) length++;
    prefixes[index] = length;
  }
  return { value, prefixes };
}

// Only a proper prefix can require another chunk. KMP failure links avoid
// repeatedly comparing a long credential against repetitive attacker input.
function suffixLength(text: string, secret: SecretPattern): number {
  const { value, prefixes } = secret;
  let length = 0;
  for (
    let index = Math.max(0, text.length - value.length + 1);
    index < text.length;
    index++
  ) {
    while (length && text[index] !== value[length])
      length = prefixes[length - 1];
    if (text[index] === value[length]) length++;
  }
  return length;
}

// Full messages and streamed deltas use the same leftmost, longest matcher.
// Work on UTF-16 units so a credential can also match across a split surrogate.
function scan(text: string, secrets: SecretPattern[], final: boolean) {
  const matches = secrets.map((secret) => ({
    secret,
    index: text.indexOf(secret.value),
    suffix: final ? 0 : suffixLength(text, secret),
  }));
  const output: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    let next: (typeof matches)[number] | undefined;
    let hold = text.length;
    for (const match of matches) {
      while (match.suffix > text.length - cursor)
        match.suffix = match.secret.prefixes[match.suffix - 1];
      hold = Math.min(hold, text.length - match.suffix);
      if (match.index !== -1 && match.index < cursor)
        match.index = text.indexOf(match.secret.value, cursor);
      if (
        match.index !== -1 &&
        (!next ||
          match.index < next.index ||
          (match.index === next.index &&
            match.secret.value.length > next.secret.value.length))
      )
        next = match;
    }
    if (!next || next.index >= hold) {
      output.push(text.slice(cursor, hold));
      return { text: output.join(""), pending: text.slice(hold) };
    }
    output.push(text.slice(cursor, next.index), replacement);
    cursor = next.index + next.secret.value.length;
  }
  return { text: output.join(""), pending: "" };
}

/** One instance per thread/turn/item/channel. Never share it across streams. */
export class RedactionStream {
  private pending = "";
  constructor(private readonly getSecrets: () => SecretPattern[]) {}

  push(delta: string): string {
    const result = scan(this.pending + delta, this.getSecrets(), false);
    this.pending = result.pending;
    return result.text;
  }

  /** Flush before publishing a successfully completed item. */
  finish(): string {
    const result = scan(this.pending, this.getSecrets(), true).text;
    this.pending = "";
    return result;
  }

  /** On interruption/error, mask a possibly truncated credential prefix. */
  abort(): string {
    const result = this.pending ? replacement : "";
    this.pending = "";
    return result;
  }

  /** Drop retained text when the owning thread is unloaded or discarded. */
  clear(): void {
    this.pending = "";
  }

  get bufferedLength(): number {
    return this.pending.length;
  }
}

export class Redactor {
  private secrets = new Set<string>();
  private patterns: SecretPattern[] = [];
  private indexedSecrets = 0;

  private secretIndex(): SecretPattern[] {
    if (this.indexedSecrets !== this.secrets.size) {
      this.patterns = Array.from(this.secrets, pattern);
      this.indexedSecrets = this.secrets.size;
    }
    return this.patterns;
  }

  createStream(): RedactionStream {
    return new RedactionStream(() => this.secretIndex());
  }

  private rememberSecret(value: string): void {
    if (value.length <= 4) return;
    this.secrets.add(value);
    // A provider can echo a header's token without its authentication scheme.
    const credential = value.match(/^(?:Bearer|Basic)\s+(.+)$/i)?.[1];
    if (credential && credential.length > 4) this.secrets.add(credential);
  }

  remember(value: any) {
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (sensitive.test(key) && typeof item === "string" && item.length > 4)
        this.rememberSecret(item);
      else if (
        (key === "http_headers" || key === "env") &&
        item &&
        typeof item === "object"
      ) {
        for (const value of Object.values(item))
          if (typeof value === "string" && value.length > 4)
            this.rememberSecret(value);
      } else this.remember(item);
    }
  }
  clean(value: any): any {
    if (typeof value === "string") {
      return scan(value, this.secretIndex(), true).text;
    }
    if (Array.isArray(value)) return value.map((item) => this.clean(item));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          // Flags such as isSecret carry no secret; only values that can hold one are hidden.
          sensitive.test(key) &&
          item !== null &&
          ["string", "object"].includes(typeof item)
            ? "[REDACTED]"
            : this.clean(item),
        ]),
      );
    return value;
  }
}
