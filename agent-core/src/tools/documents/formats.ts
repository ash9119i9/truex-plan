import { Document, Packer, Paragraph, HeadingLevel } from "docx";
import ExcelJS from "exceljs";
import PptxGenJS from "pptxgenjs";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { unzipSync, strFromU8 } from "fflate";
import { extname } from "node:path";
import { HttpError } from "../../errors";
import { MAX_FILE, text } from "./specs";

export const media: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  json: "application/json",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  sql: "application/sql",
  md: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  js: "text/javascript",
  ...Object.fromEntries(
    ["abap", "cds", "ts", "txt", "html", "properties", "java", "py", "sh"].map(
      (e) => [e, "text/plain"],
    ),
  ),
};
const textFile = (name: string) =>
  /^(text\/|application\/(json|xml|yaml|sql)$)/.test(
    media[extname(name).slice(1).toLowerCase()] || "",
  );
function officeParts(data: Buffer) {
  let total = 0,
    count = 0;
  return unzipSync(data, {
    filter(entry) {
      total += entry.originalSize;
      if (++count > 3000 || total > 20 * MAX_FILE)
        throw new HttpError(400, "Document expands beyond the supported size");
      return /\.xml$/.test(entry.name);
    },
  });
}
function xmlText(xml: string): string {
  return (xml.match(/<(?:w|a):t(?:\s[^>]*)?>[\s\S]*?<\/(?:w|a):t>/g) || [])
    .map((x) =>
      x
        .replace(/<[^>]+>/g, "")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&"),
    )
    .join("\n");
}

export async function readDocument(
  file: { name: string; data: Buffer },
  extension: string,
): Promise<string> {
  let content: string;
  if (textFile(file.name)) {
    if (file.data.includes(0))
      throw new HttpError(400, "This text file contains binary data");
    content = new TextDecoder("utf-8", { fatal: true }).decode(file.data);
  } else if (extension === "pdf") {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({
      data: file.data,
      isEvalSupported: false,
    });
    try {
      content = (await parser.getText({ first: 100 })).text;
    } finally {
      await parser.destroy();
    }
  } else if (["docx", "pptx", "xlsx"].includes(extension)) {
    const parts = officeParts(file.data);
    if (extension === "xlsx") {
      const book = new ExcelJS.Workbook();
      await book.xlsx.load(file.data as any);
      const sheets: unknown[] = [];
      book.eachSheet((sheet) => {
        const rows: unknown[] = [];
        sheet.eachRow((row) => {
          if (rows.length < 2000)
            rows.push((row.values as ExcelJS.CellValue[]).slice(1));
        });
        sheets.push({ name: sheet.name, rows });
      });
      content = JSON.stringify(sheets);
    } else {
      const names = Object.keys(parts)
        .filter((n) =>
          extension === "docx"
            ? n === "word/document.xml"
            : /^ppt\/slides\/slide\d+\.xml$/.test(n),
        )
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      content = names.map((n) => xmlText(strFromU8(parts[n]))).join("\n\n");
    }
  } else {
    if (file.data.includes(0))
      throw new HttpError(400, "This binary file type cannot be read as text");
    content = new TextDecoder("utf-8", { fatal: true }).decode(file.data);
  }
  return content;
}

export async function renderDocument(
  args: any,
  title: string,
  format: string,
): Promise<Buffer> {
  let data: Buffer;
  if (format === "docx" || format === "pdf") {
    if (!Array.isArray(args.paragraphs) || !args.paragraphs.length)
      throw new HttpError(400, "Supply document paragraphs");
    const paragraphs: string[] = args.paragraphs.map((p: unknown) => text(p));
    if (format === "docx") {
      data = await Packer.toBuffer(
        new Document({
          sections: [
            {
              children: [
                new Paragraph({ text: title, heading: HeadingLevel.TITLE }),
                ...paragraphs.map((p) => new Paragraph(p)),
              ],
            },
          ],
        }),
      );
    } else {
      const pdf = await PDFDocument.create(),
        font = await pdf.embedFont(StandardFonts.Helvetica);
      let page = pdf.addPage(),
        y = page.getHeight() - 55;
      for (const paragraph of [title, ...paragraphs]) {
        let line = "";
        const draw = () => {
          if (y < 55) {
            page = pdf.addPage();
            y = page.getHeight() - 55;
          }
          page.drawText(line, { x: 50, y, size: 11, font });
          y -= 16;
          line = "";
        };
        for (const character of paragraph.replace(/\t/g, "    ")) {
          if (character === "\n") {
            draw();
            continue;
          }
          if (
            font.widthOfTextAtSize(line + character, 11) >
            page.getWidth() - 100
          )
            draw();
          line += character;
        }
        draw();
        y -= 10;
      }
      data = Buffer.from(await pdf.save());
    }
  } else if (format === "xlsx") {
    if (!Array.isArray(args.sheets) || !args.sheets.length)
      throw new HttpError(400, "Supply workbook sheets");
    const book = new ExcelJS.Workbook();
    for (const sheet of args.sheets) {
      const tab = book.addWorksheet(sheet.name);
      tab.addRows(sheet.rows);
      tab.getRow(1).font = { bold: true };
      tab.columns.forEach((column) => {
        column.width = 24;
      });
    }
    data = Buffer.from(await book.xlsx.writeBuffer());
  } else if (format === "pptx") {
    if (!Array.isArray(args.slides) || !args.slides.length)
      throw new HttpError(400, "Supply presentation slides");
    const deck = new PptxGenJS();
    deck.layout = "LAYOUT_WIDE";
    deck.title = title;
    for (const s of args.slides) {
      if (s.title.length > 120 || s.bullets.some((b: string) => b.length > 250))
        throw new HttpError(
          400,
          "Keep slide titles under 120 characters and bullets under 250 characters",
        );
      const slide = deck.addSlide();
      slide.addText(s.title, {
        x: 0.6,
        y: 0.4,
        w: 12,
        h: 0.8,
        fontSize: 28,
        bold: true,
        color: "183153",
        breakLine: false,
      });
      slide.addText(
        s.bullets.map((b: string) => ({
          text: b,
          options: { bullet: true, breakLine: true },
        })),
        {
          x: 0.7,
          y: 1.5,
          w: 11.9,
          h: 5.2,
          fontSize: 20,
          paraSpaceAfter: 14,
          fit: "shrink",
          valign: "top",
        },
      );
    }
    data = (await deck.write({ outputType: "nodebuffer" })) as Buffer;
  } else throw new HttpError(400, "Unsupported document format");
  return data;
}
