// inspect_export: what the agent learns about a raw export file (column types, formats and masked
// shapes, never a cell value), and the hardening of the XLSX reader against hostile archives.
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { pyDumps } from "../privacy/pyJson.js";
import { leakCheck, Redactor } from "../privacy/redactor.js";
import { ToolError } from "../registry.js";
import { inspectExportBytes } from "./exports.js";
import { boundedXlsxEntries, readExportXlsx } from "./exportXlsx.js";

type Privacy = "strict" | "amounts";
const enc = (text: string) => new TextEncoder().encode(text);

/** inspect_export's answer for one file, through the redactor and the final leak check. */
function inspect(name: string, bytes: Uint8Array, privacy: Privacy, maxSamples = 5) {
  const redactor = new Redactor({ privacy });
  const data = redactor.apply(inspectExportBytes({ name, bytes }, maxSamples));
  leakCheck(data, { strict: redactor.strict, isins: redactor.isins, nonMoney: redactor.nonMoney });
  return JSON.parse(pyDumps(data));
}

const OPERATIONS =
  "Preamble;private owner\nDate;Type;Symbol;Name;Amount\n" +
  "2026-01-02;BUY;ZXQ;Anna2000;-1 234,50\n2026-01-03;SELL;ZXQ;Łódź99;12,00\n";
/** A minimal workbook: a shared-string header, an inline-string header, a date style, a formula. */
const XLSX = zipSync({
  "xl/workbook.xml": strToU8(
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Operations" sheetId="1" r:id="r1"/></sheets></workbook>',
  ),
  "xl/_rels/workbook.xml.rels": strToU8(
    '<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>',
  ),
  "xl/styles.xml": strToU8(
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>',
  ),
  "xl/sharedStrings.xml": strToU8(
    '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Date</t></si><si><t>Amount</t></si><si><r><t>Anna</t></r><r><t>2000</t></r></si></sst>',
  ),
  "xl/worksheets/sheet1.xml": strToU8(
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:XFD1048576"/><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><t>Person</t></is></c></row><row r="1048576"><c r="A1048576" s="1"><v>46000.9</v></c><c r="B2"><f>1+1</f><v>2</v></c><c r="C2" t="s"><v>2</v></c><c r="XFD2"><v>999</v></c></row></sheetData></worksheet>',
  ),
});
const FILES: [string, Uint8Array][] = [
  ["operations.csv", enc(OPERATIONS)],
  [
    "no-header.tsv",
    enc("2026-01-02\t12345678901\tJan Kowalski\n2026-01-03\t98765432109\tanna@example.invalid\n"),
  ],
  [
    "names.csv",
    enc(
      "TYPE;Name;ISIN;Ticker;Currency\nBUY;JAN KOWALSKI;US0378331005;ZXQ;PLN\nBUY;ANNA NOWAK;US0378331005;ZXQ;PLN\n",
    ),
  ],
  [
    "preamble.csv",
    enc(
      "Name;Account;Currency;Balance\nAnna Nowak;12345678901;PLN;200\n\nDate;Type;Value\n2026-01-02;BUY;1.00\n2026-01-03;SELL;2.00\n",
    ),
  ],
  [
    "unicode.txt",
    enc(
      "kind|description|amount\nBUY|PRZELEWSKI ŁÓDŹ9999|1.00\nSELL|OPEN BUY Anna2000 1 @ 12.30|2.50\n",
    ),
  ],
  [
    "records.json",
    enc(
      '[{"2":1,"1":1.0,"2":2,"__proto__":"Anna2000","kind":"BUY"},{"2":3,"1":2e2,"kind":"SELL"}]',
    ),
  ],
  ["structure.json", enc('{"Jan Kowalski":1.0,"123456":null,"foo":[1,2],"bar":{},"nan":NaN}')],
  ["operations.xlsx", XLSX],
];
const SECRETS = [
  "Anna",
  "ANNA",
  "Kowalski",
  "KOWALSKI",
  "NOWAK",
  "12345678901",
  "98765432109",
  "anna@",
  "1 234,50",
  "Łódź",
  "ŁÓDŹ",
  "PRZELEWSKI",
  "private owner",
  "12.30",
];

describe("an export reaches the agent only as shapes, in both modes", () => {
  it.each(FILES)("%s", (name, bytes) => {
    for (const privacy of ["strict", "amounts"] as const)
      for (const samples of [0, 5]) {
        const text = JSON.stringify(inspect(name, bytes, privacy, samples));
        for (const secret of SECRETS) expect(text, `${privacy}/${samples}`).not.toContain(secret);
      }
  });
});

it("describes columns by type and format, with a preamble and masked samples", () => {
  const out = inspect("operations.csv", enc(OPERATIONS), "strict");
  expect(out.file).toEqual({ delimiter: ";", encoding: "utf-8", extension: "csv", size_kb: 1 });
  const sheet = out.sheets[0];
  expect(sheet.header_row).toBe(2);
  expect(sheet.preamble).toEqual([["<w>", "<w> <w>"]]);
  expect(
    sheet.columns.map((c: Record<string, unknown>) => [c.header, c.type, c.format, c.values]),
  ).toEqual([
    ["Date", "date", "YYYY-MM-DD", []],
    ["Type", "code", null, []],
    ["Symbol", "code", null, ["ZXQ"]],
    ["Name", "text", null, []],
    ["Amount", "decimal", "decimal separator ',', thousands separator ' '", []],
  ]);
  expect(sheet.columns[4].negatives).toBe(true);
  expect(sheet.samples).toEqual([
    ["YYYY-MM-DD", "BUY", "ZXQ", "<w>[amount]", "-N NNN,NN"],
    ["YYYY-MM-DD", "SELL", "ZXQ", "<w>[amount]", "N NNN,NN"],
  ]);
  // amounts mode shows a digit run inside a word as its shape, strict as an amount
  expect(inspect("operations.csv", enc(OPERATIONS), "amounts").sheets[0].samples[0][3]).toBe(
    "<w>9999",
  );
  expect(inspect("operations.csv", enc(OPERATIONS), "strict", 0).sheets[0].samples).toEqual([]);
});

it("shows low-cardinality codes, ISINs and currencies, and masks identifiers and e-mails", () => {
  const names = inspect("names.csv", FILES[2]?.[1] as Uint8Array, "strict").sheets[0];
  expect(names.columns.map((c: Record<string, unknown>) => [c.type, c.values])).toEqual([
    ["code", ["BUY"]],
    ["text", []],
    ["isin", ["US0378331005"]],
    ["code", ["ZXQ"]],
    ["currency_code", ["PLN"]],
  ]);
  const plain = inspect("no-header.tsv", FILES[1]?.[1] as Uint8Array, "strict").sheets[0];
  expect(plain.header_row).toBeNull();
  expect(plain.samples).toEqual([
    ["YYYY-MM-DD", "[identifier]", "<w> <w>"],
    ["YYYY-MM-DD", "[identifier]", "[email]"],
  ]);
});

it("masks data-derived JSON keys and reads a workbook through its shared strings and styles", () => {
  const structure = FILES[6]?.[1] as Uint8Array;
  expect(inspect("structure.json", structure, "strict").structure).toEqual([
    { key: "<w> <w>", type: "float" },
    { key: "[amount]", type: "NoneType" },
    { key: "foo", type: "list" },
    { key: "bar", type: "dict" },
    { key: "nan", type: "float" },
  ]);
  expect(inspect("structure.json", structure, "amounts").structure[1].key).toBe("999999");
  const sheet = inspect("operations.xlsx", XLSX, "strict").sheets[0];
  expect(sheet.name).toBe("Operations");
  expect(sheet.columns.map((c: Record<string, unknown>) => [c.header, c.type])).toEqual([
    ["Date", "date"],
    ["Amount", "integer"],
    ["Person", "text"],
  ]);
  expect(sheet.samples).toEqual([["YYYY-MM-DD", "N", "<w>[amount]"]]);
});

it("reports an empty file as empty and fails a malformed one as an internal error", () => {
  expect(inspect("empty.csv", enc(""), "strict").sheets).toEqual([
    { columns: [], name: "csv", rows: 0, samples: [] },
  ]);
  let error: unknown;
  try {
    inspectExportBytes({ name: "malformed.csv", bytes: enc("header\nfoo\rbar") }, 5);
  } catch (failure) {
    error = failure;
  }
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(ToolError);
});
it("enforces declared and actual decompression budgets before retaining oversized output", () => {
  const compressed = zipSync({ "xl/test.xml": strToU8("A".repeat(30000)) });
  expect(() => boundedXlsxEntries(compressed, 1024)).toThrow("too large when unpacked");
  const forged = compressed.slice(),
    view = new DataView(forged.buffer);
  for (let i = 0; i + 46 < forged.length; i++)
    if (view.getUint32(i, true) === 0x02014b50) view.setUint32(i + 24, 1, true);
  expect(() => boundedXlsxEntries(forged, 1024)).toThrow("too large when unpacked");
});
it("verifies CRC and rejects malformed archives, duplicate/traversal names and external XML declarations", () => {
  const plain = zipSync({ "xl/test.xml": strToU8("<x>SAFE</x>") }, { level: 0 });
  const corrupted = plain.slice();
  const at = Buffer.from(corrupted).indexOf("SAFE");
  expect(at).toBeGreaterThan(0);
  corrupted[at] = 88;
  expect(() => boundedXlsxEntries(corrupted)).toThrow("cannot be read");
  expect(() => boundedXlsxEntries(plain.subarray(0, plain.length - 1))).toThrow("cannot be opened");
  expect(() => boundedXlsxEntries(zipSync({ "../x": strToU8("x") }))).toThrow("cannot be read");
  expect(() =>
    readExportXlsx(
      zipSync({ "xl/workbook.xml": strToU8('<!DOCTYPE x [<!ENTITY e "private">]><x>&e;</x>') }),
    ),
  ).toThrow("cannot be read");
});
it("limits XLSX members and rejects duplicate central names without relying on extraction paths", () => {
  const archive = zipSync({ "xl/a": strToU8("a"), "xl/b": strToU8("b") }, { level: 0 }),
    duplicate = archive.slice();
  const token = Buffer.from(duplicate);
  let at = token.indexOf("xl/b");
  while (at >= 0) {
    duplicate[at + 3] = 97;
    at = token.indexOf("xl/b", at + 4);
  }
  expect(() => boundedXlsxEntries(duplicate)).toThrow("cannot be read");
  const count = archive.slice(),
    view = new DataView(count.buffer),
    end = count.length - 22;
  view.setUint16(end + 8, 10001, true);
  view.setUint16(end + 10, 10001, true);
  expect(() => boundedXlsxEntries(count)).toThrow("cannot be read");
});
