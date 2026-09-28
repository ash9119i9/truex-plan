import type { Runtime } from "./client";
import { HttpError, RpcError, rpcText } from "./errors";
export async function readItems(
  runtime: Runtime,
  threadId: string,
  cursor?: string,
) {
  if (cursor?.startsWith("fallback:"))
    return fallback(runtime, threadId, Number(cursor.slice(9)));
  try {
    return await runtime.request("thread/items/list", {
      threadId,
      limit: 100,
      cursor: cursor || null,
      sortDirection: "asc",
    });
  } catch (e) {
    if (!(e instanceof RpcError) || e.rpcCode !== -32601) throw e;
    return fallback(runtime, threadId, 0);
  }
}
async function fallback(runtime: Runtime, threadId: string, offset: number) {
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new HttpError(400, "Invalid history cursor");
  let result: any;
  try {
    result = await runtime.request("thread/read", {
      threadId,
      includeTurns: true,
    });
  } catch (e) {
    if (rpcText(e).includes("not materialized yet"))
      return { data: [], nextCursor: null, backwardsCursor: null };
    throw e;
  }
  const items = result.thread.turns.flatMap((turn: any) =>
    turn.items.map((item: any) => ({ turnId: turn.id, item })),
  );
  return {
    data: items.slice(offset, offset + 100),
    nextCursor: offset + 100 < items.length ? `fallback:${offset + 100}` : null,
    backwardsCursor: null,
  };
}
