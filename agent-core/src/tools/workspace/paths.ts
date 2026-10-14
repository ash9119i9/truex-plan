import { HttpError } from "../../errors";
import { workspaceLimits as L } from "./specs";

export const PARTIAL = ".truex-partial-";

export function segments(value: unknown, allowRoot = false): string[] {
  if (typeof value !== "string" || (!value && !allowRoot))
    throw new HttpError(400, "Supply a relative workspace path");
  if (value.length > L.pathLength)
    throw new HttpError(
      400,
      `Workspace paths are limited to ${L.pathLength} characters`,
    );
  if (/[\x00-\x1f\\]/.test(value))
    throw new HttpError(
      400,
      "Workspace paths cannot contain backslashes or control characters",
    );
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value))
    throw new HttpError(
      400,
      "Use a path relative to the workspace, not an absolute path",
    );
  const parts = value.split("/").filter((p) => p && p !== ".");
  if (parts.includes(".."))
    throw new HttpError(400, "Workspace paths cannot contain '..'");
  if (parts.some((p) => p.startsWith(PARTIAL) || Buffer.byteLength(p) > 255))
    throw new HttpError(400, "Invalid workspace file name");
  if (!parts.length && !allowRoot)
    throw new HttpError(400, "This operation needs a file path, not the root");
  return parts;
}
export function code(error: unknown) {
  return (error as NodeJS.ErrnoException)?.code;
}
/** Turns raw file system errors (which carry absolute paths) into tool errors. */
export function toolError(error: unknown): never {
  if (["EACCES", "EPERM"].includes(code(error)!))
    throw new HttpError(
      403,
      "Permission denied in the workspace (a script may have changed file permissions)",
    );
  if (code(error) === "ENAMETOOLONG")
    throw new HttpError(400, "Workspace path is too long for the file system");
  throw error;
}
