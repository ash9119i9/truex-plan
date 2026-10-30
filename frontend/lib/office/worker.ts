// The Office preview worker: parses untrusted file bytes off the page's thread,
// so a slow or hostile file stalls only this worker. lib/office/client.ts
// starts one per file and stops it when it answers, times out or is no longer
// wanted.
import { runPreview, type PreviewRequest } from "./run.ts";

onmessage = async (event: MessageEvent<PreviewRequest>) => {
  postMessage(await runPreview(event.data));
};
