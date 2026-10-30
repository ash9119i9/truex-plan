import { PreviewError, type PreviewErrorCode } from "./limits.ts";
import { parseXlsx, type Workbook } from "./xlsx.ts";

// One preview request, as the worker runs it. Kept apart from the worker's
// wiring so Node tests can run it directly.

export type OfficeKind = "sheet" | "docx";
export type PreviewRequest = { kind: OfficeKind; bytes: ArrayBuffer };
export type PreviewResult =
  | { kind: "sheet"; workbook: Workbook }
  // HTML for sandboxedDocx's frame only, never the page.
  | { kind: "docx"; html: string };
export type PreviewResponse =
  | { ok: true; result: PreviewResult }
  | { ok: false; code: PreviewErrorCode; message: string };

export async function runPreview({
  kind,
  bytes,
}: PreviewRequest): Promise<PreviewResponse> {
  try {
    const data = new Uint8Array(bytes);
    switch (kind) {
      case "sheet":
        return { ok: true, result: { kind, workbook: parseXlsx(data) } };
      case "docx": {
        // mammoth is loaded only when a Word file opens.
        const { parseDocx } = await import("./docx.ts");
        return { ok: true, result: { kind, html: await parseDocx(data) } };
      }
      default:
        throw new PreviewError(
          "unsupported",
          "This file type can't be previewed.",
        );
    }
  } catch (error) {
    if (error instanceof PreviewError)
      return { ok: false, code: error.code, message: error.message };
    // A parser bug or an exhausted stack: still only "can't preview".
    return { ok: false, code: "corrupt", message: "Not a readable file." };
  }
}
