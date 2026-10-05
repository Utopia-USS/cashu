// CSV export cells (F7 FE16). A cell that a spreadsheet would read as a formula (it starts with = + - @, a tab
// or a CR; OWASP CSV injection) gets a leading apostrophe, so an agent-written alert title such as
// `=HYPERLINK(...)` stays text in Excel / Numbers / LibreOffice. A plain signed number ("-12,3 %", "+1,4 %",
// "-") cannot run anything and is left as it is. Every cell is quoted. Pure; tested in tests/csv.test.mjs.

const RISKY = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^[+-]?[\d\s .,]*(\s?(%|pp|zł))?$/;

export function csvCell(v: unknown): string {
  let s = v == null ? "" : String(v);
  if (RISKY.test(s) && !PLAIN_NUMBER.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

/** One CSV line (semicolon-separated, the Polish Excel default). */
export const csvLine = (cells: unknown[]): string => cells.map(csvCell).join(";");
