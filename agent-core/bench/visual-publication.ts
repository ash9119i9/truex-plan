// Run: cd agent-core && npx tsx bench/visual-publication.ts
// Disposable local disk benchmark; no model or production capacity claim.
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir, platform, arch, cpus } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { ConversationFiles } from "../src/file-tools";
import { BusinessRuntime } from "../src/business-runtime";
import { ThreadManager } from "../src/manager";
import { DisabledScriptRunner } from "../src/script-runner";
import { DisabledHtmlPreviewRunner } from "../src/html-preview";

const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samples: values.length,
    medianMs: +sorted[Math.floor(sorted.length / 2)].toFixed(3),
    p95Ms: +sorted[Math.ceil(sorted.length * 0.95) - 1].toFixed(3),
    maxMs: +sorted.at(-1)!.toFixed(3),
  };
};
async function main() {
  const home = await mkdtemp(join(tmpdir(), "truex-visual-bench-"));
  try {
    const files = new ConversationFiles((id) => join(home, id));
    const rows: Record<string, unknown>[] = [];
    for (const size of [7000, 170000]) {
      const html = `<!doctype html><html><head><title>Capacity</title></head><body><main>${"S".repeat(size - 100)}</main></body></html>`;
      for (const kind of ["legacy", "document"] as const) {
        const id = `${kind}-${size}`,
          timings: number[] = [];
        const args = {
          title: "Capacity",
          description: "Measured fixture",
          html,
          ...(kind === "document" ? { height: 420 } : {}),
        };
        for (let call = 0; call < 40; call++) {
          const started = performance.now();
          await files.execute(
            id,
            kind === "document" ? "html_render" : "create_visualization",
            args,
            { turnId: "turn", callId: `call-${call}` },
          );
          timings.push(performance.now() - started);
        }
        const duplicates: number[] = [];
        if (kind === "document")
          for (let retry = 0; retry < 20; retry++) {
            const started = performance.now();
            await files.execute(id, "html_render", args, {
              turnId: "turn",
              callId: "call-0",
            });
            duplicates.push(performance.now() - started);
          }
        rows.push({
          kind,
          sourceBytes: Buffer.byteLength(html),
          conversationFiles: 40,
          publication: stats(timings),
          ...(duplicates.length ? { duplicateReplay: stats(duplicates) } : {}),
        });
      }
    }
    const threadId = "document-170000";
    await mkdir(join(home, "business-threads"), { recursive: true });
    await writeFile(
      join(home, "business-threads", `${threadId}.json`),
      JSON.stringify({
        cwd: join(home, threadId),
        documentTools: 1,
        visualReplies: 1,
      }),
    );
    const client = new BusinessRuntime(
      "unused-benchmark-binary",
      home,
      undefined,
      new DisabledScriptRunner(),
      new DisabledHtmlPreviewRunner(),
    );
    const manager = new ThreadManager(client, home);
    const started = performance.now();
    await manager.recoverPublications(threadId);
    const coldRecoveryMs = performance.now() - started;
    const hot: number[] = [];
    for (let i = 0; i < 100; i++) {
      const start = performance.now();
      await manager.recoverPublications(threadId);
      JSON.stringify(manager.snapshot(threadId));
      hot.push(performance.now() - start);
    }
    const snapshot = manager.snapshot(threadId);
    const result = {
      measuredAt: new Date().toISOString(),
      environment: {
        platform: platform(),
        arch: arch(),
        cpu: cpus()[0]?.model,
        node: process.version,
      },
      scope:
        "Disposable local files; validation, hashing, per-thread serialization and atomic source metadata commit. Cold recovery includes durable event spool writes. No external provider, network, Chromium or production-load measurement.",
      rows,
      recovery: {
        files: 40,
        coldRecoveryMs: +coldRecoveryMs.toFixed(3),
        hotSnapshot: stats(hot),
        attachmentCount: snapshot.visuals?.length,
        snapshotBytes: Buffer.byteLength(JSON.stringify(snapshot)),
      },
    };
    manager.close();
    client.stop();
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
void main();
