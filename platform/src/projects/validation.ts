import { ApiError } from "../core/errors";

const PROJECT_ID = /^proj_[0-9a-f-]{36}$/;

export function projectIdOf(id: unknown) {
  if (typeof id !== "string" || !PROJECT_ID.test(id))
    throw new ApiError(400, "Invalid project id", "INVALID_PROJECT");
  return id;
}

export function projectName(name: unknown) {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (!trimmed || trimmed.length > 80)
    throw new ApiError(
      400,
      "Project name must contain 1–80 characters",
      "INVALID_PROJECT",
    );
  return trimmed;
}
