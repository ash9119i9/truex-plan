// What an Office preview may read before it gives up (tasks/office-preview-plan.md).
// Starting values; Task 9 sets the final ones from measurements.
export const OFFICE_LIMITS = {
  // The file as stored, matching the upload limit.
  fileBytes: 20 * 1024 * 1024,
  entries: 10_000,
  // Unzipped: one part, and every part read from one file.
  entryBytes: 64 * 1024 * 1024,
  totalBytes: 100 * 1024 * 1024,
  // Shown per workbook and per sheet; the rest is left for the download.
  // Rows and columns match the CSV preview's caps.
  sheets: 50,
  sheetRows: 500,
  sheetColumns: 50,
  // Slides shown per presentation; the rest are left for the download.
  slides: 100,
  // Images in a Word document or a presentation, each and all together,
  // shown as data: URLs.
  images: 50,
  imageBytes: 5 * 1024 * 1024,
  imagesTotalBytes: 20 * 1024 * 1024,
  // A Word document's HTML, not counting its images' data.
  docxHtmlChars: 5 * 1024 * 1024,
  // A preview still parsing after this is stopped.
  timeoutMs: 15_000,
};
export type OfficeLimits = typeof OFFICE_LIMITS;

// "too-large": over a limit. "corrupt": not a readable file of its type.
// "unsupported": readable, but in a form the preview doesn't handle
// (encrypted, zip64, an unknown compression method).
export type PreviewErrorCode = "corrupt" | "too-large" | "unsupported";

export class PreviewError extends Error {
  readonly code: PreviewErrorCode;
  // Bytes inflated from the part being read when it stopped.
  readonly inflated: number;
  constructor(code: PreviewErrorCode, message: string, inflated = 0) {
    super(message);
    this.name = "PreviewError";
    this.code = code;
    this.inflated = inflated;
  }
}
