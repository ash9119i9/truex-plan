import { AsyncLocalStorage } from "node:async_hooks";
import { ApiError } from "./errors";
import {
  contextFailure,
  isAuthorizationContext,
  type Action,
  type AuthorizationContext,
  type ResourceRef,
} from "../../shared/authorization";

// Trusted callers must authenticate credentials before entering this scope.
// Carrying a valid context is an invariant, never an engine permission grant.
const storage = new AsyncLocalStorage<AuthorizationContext>();
const missing = () =>
  new ApiError(
    401,
    "Verified authorization context is required",
    "AUTHORIZATION_CONTEXT_REQUIRED",
  );
const expired = () =>
  new ApiError(
    401,
    "Your authorization credential has expired",
    "AUTHORIZATION_CREDENTIAL_EXPIRED",
  );
function freeze(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freeze(child);
  Object.freeze(value);
}
function validNow(context: unknown): asserts context is AuthorizationContext {
  if (!isAuthorizationContext(context)) throw missing();
  if (
    context.credential.expiresAtMs <= Date.now() ||
    context.credential.issuedAtMs > Date.now()
  )
    throw expired();
}
export function withAuthorizationContext<T>(
  context: AuthorizationContext,
  fn: () => T,
): T {
  validNow(context);
  const captured = structuredClone(context);
  freeze(captured);
  return storage.run(captured, fn);
}
export function currentAuthorizationContext() {
  return storage.getStore();
}
export function requireAuthorizationContext(): AuthorizationContext {
  const current = storage.getStore();
  validNow(current);
  return current;
}
/** Additional mechanical scope/tenant/purpose checks; live policy checks follow. */
export function requireActionContext(
  action: Action,
  resource: ResourceRef,
): AuthorizationContext {
  const context = requireAuthorizationContext();
  const reason = contextFailure(context, action, resource, Date.now());
  if (reason)
    throw new ApiError(
      403,
      "This credential does not allow the operation",
      "AUTHORIZATION_CONTEXT_DENIED",
    );
  return context;
}
