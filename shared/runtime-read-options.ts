// Additive runtime read capabilities; defaults retain the legacy responses.
export interface RuntimeReadOptions {
  window?: boolean;
  sync?: "v1";
}

export function runtimeWindowOption(
  method: string,
  path: string,
  value: unknown,
): boolean | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "boolean" ||
    method !== "GET" ||
    !/^\/threads\/[A-Za-z0-9_-]+\/(?:snapshot|events)$/.test(path)
  )
    throw new TypeError("Invalid runtime snapshot window");
  return value;
}

export function runtimeWindowQuery(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (value !== "1") throw new TypeError("Invalid runtime snapshot window");
  return true;
}

export function runtimeSyncOption(
  method: string,
  path: string,
  value: unknown,
): "v1" | undefined {
  if (value === undefined) return undefined;
  if (
    value !== "v1" ||
    method !== "GET" ||
    !/^\/threads\/[A-Za-z0-9_-]+\/events$/.test(path)
  )
    throw new TypeError("Invalid runtime synchronization mode");
  return value;
}
