"""Writes the Office preview test fixtures into test/fixtures/office/.

The files are made the way the agent makes them, with the pinned sandbox
libraries (runtime-adapter/toolchain/requirements.in). From the repo root:

    npm run toolchain:setup   # once
    .runtime/toolchain/python/bin/python3 -I frontend/scripts/office-fixtures.py

The output is committed; rerun only to change the fixtures.
"""

import io
import sys
import zipfile
from datetime import date
from pathlib import Path

import docx
import openpyxl
import pptx
import pypdf
from PIL import Image
from pptx.util import Inches
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

OUT = Path(__file__).resolve().parent.parent / "test" / "fixtures" / "office"
# Past the 100 MB unzipped preview limit, yet small on disk.
BOMB_BYTES = 150 * 1024 * 1024


def png() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (64, 40), (37, 99, 235)).save(buf, "PNG")
    return buf.getvalue()


def report() -> None:
    doc = docx.Document()
    doc.add_heading("Quarterly report", level=1)
    doc.add_paragraph("Revenue grew in every region except EMEA.")
    doc.add_heading("Highlights", level=2)
    for line in ["APAC up 12%", "Americas up 4%", "EMEA down 3%"]:
        doc.add_paragraph(line, style="List Bullet")
    table = doc.add_table(rows=3, cols=2)
    for r, (region, total) in enumerate(
        [("Region", "Revenue"), ("APAC", "1,200"), ("EMEA", "800")]
    ):
        table.cell(r, 0).text = region
        table.cell(r, 1).text = total
    doc.add_picture(io.BytesIO(png()))
    doc.save(OUT / "report.docx")


def invoice() -> bytes:
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Invoice"
    ws.append(["Item", "Qty", "Price", "Total", "Due", "Paid", "Tax"])
    for row, (item, qty, price) in enumerate(
        [("Widget", 3, 2.5), ("Gadget", 1, 10), ("Bolt", 12, 0.25)], start=2
    ):
        ws.append([item, qty, price, f"=B{row}*C{row}"])
    ws.append(["Total", None, None, "=SUM(D2:D4)"])
    ws["E2"] = date(2026, 10, 30)
    ws["E2"].number_format = "yyyy-mm-dd"
    ws["F2"] = False
    ws["G2"] = 0.2
    ws["G2"].number_format = "0%"
    notes = wb.create_sheet("Notes")
    notes["A1"] = "Payment due in 30 days"
    notes["C3"] = 42
    buf = io.BytesIO()
    wb.save(buf)
    (OUT / "invoice.xlsx").write_bytes(buf.getvalue())
    return buf.getvalue()


def deck() -> None:
    prs = pptx.Presentation()
    title = prs.slides.add_slide(prs.slide_layouts[0])
    title.shapes.title.text = "Q3 review"
    title.placeholders[1].text = "Invoice desk"

    bullets = prs.slides.add_slide(prs.slide_layouts[1])
    bullets.shapes.title.text = "What changed"
    body = bullets.placeholders[1].text_frame
    body.text = "Revenue"
    for text, level in [("APAC up 12%", 1), ("EMEA down 3%", 1), ("Costs flat", 0)]:
        para = body.add_paragraph()
        para.text = text
        para.level = level

    table_slide = prs.slides.add_slide(prs.slide_layouts[5])
    table_slide.shapes.title.text = "By region"
    table = table_slide.shapes.add_table(
        3, 2, Inches(1), Inches(2), Inches(6), Inches(1.5)
    ).table
    for r, (region, total) in enumerate(
        [("Region", "Revenue"), ("APAC", "1,200"), ("EMEA", "800")]
    ):
        table.cell(r, 0).text = region
        table.cell(r, 1).text = total

    image_slide = prs.slides.add_slide(prs.slide_layouts[5])
    image_slide.shapes.title.text = "Trend"
    image_slide.shapes.add_picture(io.BytesIO(png()), Inches(1), Inches(2))

    for heading, points in [
        ("Risks", ["Currency", "Supply"]),
        ("Next steps", ["Hire two reps", "Review pricing"]),
    ]:
        slide = prs.slides.add_slide(prs.slide_layouts[1])
        slide.shapes.title.text = heading
        frame = slide.placeholders[1].text_frame
        frame.text = points[0]
        for point in points[1:]:
            frame.add_paragraph().text = point
    prs.save(OUT / "deck.pptx")


def brief() -> None:
    pdf = canvas.Canvas(str(OUT / "brief.pdf"), pagesize=A4)
    for page in range(1, 4):
        pdf.drawString(72, 770, f"Brief, page {page} of 3")
        pdf.showPage()
    pdf.save()


def broken(workbook: bytes) -> None:
    cut = workbook[: len(workbook) // 2]
    if b"PK\x05\x06" in cut:
        sys.exit("truncated.xlsx still has an end of central directory")
    (OUT / "truncated.xlsx").write_bytes(cut)
    (OUT / "notzip.docx").write_text("This is plain text, not a Word file.\n")
    # Written in chunks, so the 150 MB part never sits in memory.
    with zipfile.ZipFile(
        OUT / "bomb.xlsx", "w", zipfile.ZIP_DEFLATED, compresslevel=9
    ) as zf:
        zf.writestr("[Content_Types].xml", "<Types/>")
        with zf.open("xl/worksheets/sheet1.xml", "w") as part:
            part.write(b"<worksheet><sheetData>")
            chunk = b" " * (1024 * 1024)
            for _ in range(BOMB_BYTES // len(chunk)):
                part.write(chunk)
            part.write(b"</sheetData></worksheet>")


def check() -> None:
    """Reopens every good fixture with the library that wrote it."""
    assert len(docx.Document(OUT / "report.docx").tables) == 1
    assert openpyxl.load_workbook(OUT / "invoice.xlsx").sheetnames == [
        "Invoice",
        "Notes",
    ]
    assert len(pptx.Presentation(OUT / "deck.pptx").slides) == 6
    assert len(pypdf.PdfReader(OUT / "brief.pdf").pages) == 3


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    report()
    workbook = invoice()
    deck()
    brief()
    broken(workbook)
    check()
    for path in sorted(OUT.iterdir()):
        print(f"{path.stat().st_size:>8}  {path.name}")


if __name__ == "__main__":
    main()
