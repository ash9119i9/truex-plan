import { ApplicationError } from "../../shared/errors";
export class HttpError extends ApplicationError {}
/** A JSON-RPC error from the runtime. The message is user-safe; the runtime's
 * own code and text stay on rpcCode/rpcMessage (and the cause) for checks and logs. */
export class RpcError extends HttpError {
  constructor(
    status: number,
    message: string,
    code: string,
    readonly rpcCode: number,
    readonly rpcMessage: string,
    readonly rpcData?: unknown,
  ) {
    super(status, message, code, {
      cause: new Error(`JSON-RPC ${rpcCode}: ${rpcMessage}`),
    });
    this.name = "RpcError";
  }
}
/** The runtime's own error text, for internal checks only. */
export const rpcText = (e: unknown) =>
  e instanceof RpcError ? e.rpcMessage : e instanceof Error ? e.message : "";
