import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { Harness, completed } from "../support/harness";
import type { Behavior } from "../support/model-fixture";

// The toolchains a coding run gets, on the real pinned Codex and inside its
// sandbox: Node from the adapter's prefix, and Python 3 with the pinned
// document libraries (toolchain/requirements.in) from RUNTIME_TOOLCHAIN_DIRS.
// Locally that is the environment `npm run toolchain:setup` creates; set
// RUNTIME_TEST_TOOLCHAIN_DIRS to test another one (the image's
// /opt/truex/python, say).

const DIRS = (
  process.env.RUNTIME_TEST_TOOLCHAIN_DIRS ??
  resolve(__dirname, "../../../.runtime/toolchain/python")
)
  .split(":")
  .filter(Boolean);
const PYTHON = DIRS.find((dir) => existsSync(join(dir, "bin", "python3")));

const exec = (cmd: string): Behavior => ({
  kind: "call",
  name: "exec_command",
  // Imports and test runners can outlast the default 10 s yield.
  args: { cmd, yield_time_ms: 60_000 },
});

const DOCUMENTS = `
import docx, openpyxl, pptx, pypdf
from reportlab.pdfgen import canvas

d = docx.Document(); d.add_paragraph("word ok"); d.save("a.docx")
wb = openpyxl.Workbook(); wb.active["A1"] = "excel ok"; wb.save("a.xlsx")
p = pptx.Presentation(); s = p.slides.add_slide(p.slide_layouts[5])
s.shapes.title.text = "slides ok"; p.save("a.pptx")
c = canvas.Canvas("a.pdf"); c.drawString(72, 720, "pdf ok"); c.save()

print(docx.Document("a.docx").paragraphs[0].text)
print(openpyxl.load_workbook("a.xlsx").active["A1"].value)
print(pptx.Presentation("a.pptx").slides[0].shapes.title.text)
print(pypdf.PdfReader("a.pdf").pages[0].extract_text().strip())
`;

describe("toolchains in the sandbox (real Codex)", () => {
  const h = new Harness({ coding: true, toolchainDirs: DIRS });
  before(async () => {
    assert.ok(
      PYTHON,
      `No python3 in ${DIRS.join(":")}: run npm run toolchain:setup first.`,
    );
    await h.start();
  });
  after(() => h.close());

  const workspace = () =>
    join(h.stateDir, "t", "tenant1", "c", "tc1", "workspace");

  // What the command printed, as Codex reported it back to the model.
  async function run(cmd: string): Promise<string> {
    h.model.script.push(exec(cmd), { kind: "reply", text: "ok" });
    const events = await h.run(h.body({ chatId: "tc1" }));
    assert.equal(completed(events).status, "completed");
    assert.ok(!events.some((e) => e.type === "approval.requested"), cmd);
    const input = h.model.lastRequest().body.input as Array<
      Record<string, unknown>
    >;
    return String(
      input.filter((item) => item.type === "function_call_output").at(-1)
        ?.output ?? "",
    );
  }

  test("python3 is the configured toolchain's", async () => {
    await mkdir(workspace(), { recursive: true });
    const output = await run(
      `python3 -c "import sys; print('prefix=' + sys.prefix)"`,
    );
    assert.match(output, /exited with code 0/, output);
    assert.ok(
      output.includes(`prefix=${realpathSync(PYTHON!)}`) ||
        output.includes(`prefix=${PYTHON}`),
      output,
    );
  });

  test("a Node test suite runs and passes", async () => {
    await writeFile(
      join(workspace(), "sum.test.js"),
      [
        "const test = require('node:test');",
        "const assert = require('node:assert');",
        "test('adds', () => assert.equal(1 + 2, 3));",
        "test('concatenates', () => assert.equal('a' + 'b', 'ab'));",
        "",
      ].join("\n"),
    );
    const output = await run("node --test sum.test.js");
    assert.match(output, /exited with code 0/, output);
    assert.match(output, /pass 2/, output);
    assert.match(output, /fail 0/, output);
  });

  test("a Python test suite runs and passes", async () => {
    await writeFile(
      join(workspace(), "test_sum.py"),
      [
        "import unittest",
        "",
        "class Sum(unittest.TestCase):",
        "    def test_adds(self):",
        "        self.assertEqual(1 + 2, 3)",
        "",
        "    def test_joins(self):",
        "        self.assertEqual('a' + 'b', 'ab')",
        "",
      ].join("\n"),
    );
    const output = await run("python3 -m unittest -v test_sum");
    assert.match(output, /exited with code 0/, output);
    assert.match(output, /Ran 2 tests[\s\S]*OK/, output);
  });

  test("the document libraries write and read Word, Excel, PowerPoint and PDF files", async () => {
    await writeFile(join(workspace(), "documents.py"), DOCUMENTS);
    const output = await run("python3 documents.py");
    assert.match(output, /exited with code 0/, output);
    assert.match(output, /word ok\s+excel ok\s+slides ok\s+pdf ok/, output);
    for (const file of ["a.docx", "a.xlsx", "a.pptx", "a.pdf"])
      assert.ok(existsSync(join(workspace(), file)), file);
  });
});
