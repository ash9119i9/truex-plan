import { AsyncLocalStorage } from "node:async_hooks";

// One instance shared by handlers and runtime calls.
export const requestContext = new AsyncLocalStorage<{ requestId: string }>();
export const currentRequestId = () => requestContext.getStore()?.requestId;
