// Reproducible local filesystem/parser microbenchmarks, not a production load
// test. Run: npm --prefix agent-core run bench:cache
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Document, Packer, Paragraph } from "docx";
import ExcelJS from "exceljs";
import { BusinessRuntime } from "../src/business-runtime";
import { ConversationFiles } from "../src/file-tools";
import { DisabledScriptRunner } from "../src/script-runner";

async function sample(
  operation: () => unknown | Promise<unknown>,
  count: number,
) {
  // Exclude first-use library/import work, warm the filesystem in both modes.
  for (let i = 0; i < 3; i++) await operation();
  const times: number[] = [];
  for (let i = 0; i < count; i++) {
    const start = performance.now();
    await operation();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return {
    samples: count,
    p50Ms: Number(times[Math.ceil(count * 0.5) - 1].toFixed(3)),
    p95Ms: Number(times[Math.ceil(count * 0.95) - 1].toFixed(3)),
  };
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), "truex-runtime-cache-bench-"));
  const previous = process.env.CACHE_RUNTIME_METADATA;
  try {
    const files = new ConversationFiles((id) => join(root, id));
    const document = await Packer.toBuffer(
      new Document({
        sections: [
          {
            children: Array.from(
              { length: 500 },
              (_, i) =>
                new Paragraph(
                  `Section ${i}: ` + "Measured document content. ".repeat(20),
                ),
            ),
          },
        ],
      }),
    );
    const book = new ExcelJS.Workbook(),
      sheet = book.addWorksheet("Records");
    for (let i = 0; i < 2000; i++)
      sheet.addRow([
        i,
        "region-" + (i % 20),
        i * 1.25,
        "Measured spreadsheet text",
      ]);
    const spreadsheet = Buffer.from(await book.xlsx.writeBuffer());
    const doc = await files.upload(
      "documents",
      "benchmark.docx",
      document.toString("base64"),
    );
    const xlsx = await files.upload(
      "documents",
      "benchmark.xlsx",
      spreadsheet.toString("base64"),
    );
    for (let i = 0; i < 50; i++)
      await files.publish(
        "catalog",
        `record-${i}.txt`,
        Buffer.from("Measured file"),
      );
    const home = join(root, "runtime"),
      workspace = join(root, "workspace");
    await mkdir(join(home, "business-threads"), { recursive: true });
    await writeFile(
      join(home, "business-threads", "thread_1.json"),
      JSON.stringify({
        cwd: workspace,
        tenantId: "benchmark",
        documentTools: 1,
        skills: Array.from({ length: 10 }, (_, i) => ({
          name: `skill-${i}`,
          description: "Measured skill",
          body: "Instructions. ".repeat(1000),
          version: 1,
        })),
      }),
    );
    const runtime = new BusinessRuntime(
      "unused",
      home,
      undefined,
      new DisabledScriptRunner(),
    );
    const modes: Record<string, unknown> = {};
    for (const flag of ["off", "on"]) {
      process.env.CACHE_RUNTIME_METADATA = flag;
      files.invalidate();
      modes[flag === "on" ? "enabled" : "disabled"] = {
        marker: await sample(
          () => assert.equal(runtime.tenant("thread_1"), "benchmark"),
          300,
        ),
        fileList50: await sample(
          async () => assert.equal((await files.list("catalog")).length, 50),
          50,
        ),
        docxExtraction: await sample(
          async () =>
            assert.match(
              (await files.read("documents", doc.id)).text,
              /Section 0/,
            ),
          30,
        ),
        xlsxExtraction: await sample(
          async () =>
            assert.match(
              (await files.read("documents", xlsx.id)).text,
              /region-0/,
            ),
          20,
        ),
      };
    }
    console.log(
      JSON.stringify(
        {
          scope:
            "Local warmed filesystem, sequential requests; no AWS, network, model, or production scalability claim",
          node: process.version,
          platform: process.platform,
          arch: process.arch,
          payloadBytes: { docx: document.length, xlsx: spreadsheet.length },
          fixture: {
            markerSkills: 10,
            documentParagraphs: 500,
            spreadsheetRows: 2000,
            listFiles: 50,
          },
          modes,
        },
        null,
        2,
      ),
    );
  } finally {
    if (previous === undefined) delete process.env.CACHE_RUNTIME_METADATA;
    else process.env.CACHE_RUNTIME_METADATA = previous;
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
