"use client";
import { useId, useState } from "react";
import { Tabs, tabId } from "@/components/tx/tabs";
import type { Sheet, Workbook } from "@/lib/office/xlsx";

// A workbook in the file viewer: one tab per sheet, cells under Excel's column
// letters and row numbers. A formula saved without its result shows the
// formula, marked, because the browser doesn't calculate it.

export function SheetView({ workbook }: { workbook: Workbook }) {
  const idBase = useId();
  const [picked, setPicked] = useState(0);
  const { sheets } = workbook;
  if (!sheets.length)
    return <p className="fv-note">This workbook has no sheets to show.</p>;
  const index = Math.min(picked, sheets.length - 1);
  const panelId = `${idBase}-sheet`;
  const many = sheets.length > 1;
  return (
    <div className="fv-sheet">
      {many && (
        <Tabs
          label="Sheets"
          idBase={idBase}
          panelId={panelId}
          items={sheets.map((sheet, i) => ({
            id: String(i),
            label: sheet.hidden ? `${sheet.name} (hidden)` : sheet.name,
          }))}
          selected={String(index)}
          onSelect={(id) => setPicked(Number(id))}
        />
      )}
      <div
        {...(many
          ? {
              role: "tabpanel",
              id: panelId,
              "aria-labelledby": tabId(idBase, String(index)),
            }
          : {})}
      >
        <SheetGrid key={index} sheet={sheets[index]} />
      </div>
      {workbook.truncated && (
        <p className="fv-note">
          Showing the first {sheets.length} sheets. Download for the whole file.
        </p>
      )}
    </div>
  );
}

function SheetGrid({ sheet }: { sheet: Sheet }) {
  const noteId = useId();
  if (!sheet.rows.length)
    return <p className="fv-note">This sheet is empty.</p>;
  const width = sheet.rows[0].length;
  const formulas = new Set(
    sheet.formulas.map(([row, column]) => `${row}:${column}`),
  );
  const count = formulas.size;
  return (
    <>
      {count > 0 && (
        <p className="fv-note" id={noteId}>
          {count === 1
            ? "1 cell shows its formula instead of a value. Excel calculates it when the file is opened."
            : `${count} cells show their formula instead of a value. Excel calculates them when the file is opened.`}
        </p>
      )}
      <div
        className="fv-grid-wrap"
        role="region"
        aria-label={`${sheet.name} cells`}
        tabIndex={0}
      >
        <table className="fv-grid">
          <thead>
            <tr>
              <th aria-hidden="true" />
              {Array.from({ length: width }, (_, column) => (
                <th key={column} scope="col">
                  {columnName(column)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sheet.rows.map((cells, row) => (
              <tr key={row}>
                <th scope="row">{row + 1}</th>
                {cells.map((cell, column) =>
                  formulas.has(`${row}:${column}`) ? (
                    <td
                      key={column}
                      className="fv-formula"
                      title="Formula. Excel calculates it when the file is opened."
                      aria-describedby={noteId}
                    >
                      {cell}
                    </td>
                  ) : (
                    <td key={column}>{cell}</td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sheet.truncated && (
        <p className="fv-note">
          Showing the first rows and columns. Download for the whole file.
        </p>
      )}
    </>
  );
}

// 0 → "A", 25 → "Z", 26 → "AA".
export function columnName(index: number): string {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26))
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}
