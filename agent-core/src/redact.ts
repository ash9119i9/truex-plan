const sensitive =
  /(apikey|api_key|experimental_bearer_token|access_token|refresh_token|authorization|token$|secret|password|[-_]key$|^http_headers$|^env_http_headers$)/i;
export class Redactor {
  private secrets = new Set<string>();
  remember(value: any) {
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (sensitive.test(key) && typeof item === "string" && item.length > 4)
        this.secrets.add(item);
      else if (
        (key === "http_headers" || key === "env") &&
        item &&
        typeof item === "object"
      ) {
        for (const value of Object.values(item))
          if (typeof value === "string" && value.length > 4)
            this.secrets.add(value);
      } else this.remember(item);
    }
  }
  clean(value: any): any {
    if (typeof value === "string") {
      for (const secret of this.secrets)
        value = value.split(secret).join("[REDACTED]");
      return value;
    }
    if (Array.isArray(value)) return value.map((item) => this.clean(item));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          sensitive.test(key) ? "[REDACTED]" : this.clean(item),
        ]),
      );
    return value;
  }
}
