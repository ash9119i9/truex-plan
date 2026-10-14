import type { Writable } from "node:stream";
import type { PublicEventStream } from "./event-stream";
// A full socket buffer is normal after a large frame (an MCP tool result, a
// long replay); wait for the client to drain instead of dropping the stream.
export async function relay(
  body: AsyncIterable<Uint8Array>,
  res: Writable,
  stream: PublicEventStream,
) {
  for await (const chunk of body) {
    const output = stream.push(chunk);
    if (output && !res.write(output))
      await new Promise<void>((resolve) => {
        const done = () => {
          res.off("drain", done);
          res.off("close", done);
          resolve();
        };
        res.on("drain", done);
        res.on("close", done);
      });
    if (res.destroyed) return;
  }
}
