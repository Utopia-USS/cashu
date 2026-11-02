/** Checked file bytes become structural descriptions, never original sample values. */
import {
  decodeReplace,
  decodeStrict,
  floatRepr,
  parsePyJson,
  pySplitlines,
  pyStrip,
  readCsv,
} from "@cashu/domain";
import { importFileExtension } from "@cashu/domain/investments/importing";
import * as L from "../privacy/labels.js";
import { type ToolArgs, type ToolContext, ToolError } from "../registry.js";
import type { NativeToolStore } from "../runtime/types.js";
import { describeExportTable, type ExportTable, safeExportLabel } from "./exportShape.js";
import { readExportXlsx } from "./exportXlsx.js";

function decode(bytes: Uint8Array): { text: string; encoding: string } {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    return { text: decodeReplace(bytes.subarray(3), "utf-8"), encoding: "utf-8-sig" };
  const utf8 = decodeStrict(bytes, "utf-8");
  return utf8.ok
    ? { text: utf8.text, encoding: "utf-8" }
    : { text: decodeReplace(bytes, "cp1250"), encoding: "windows-1250" };
}
function csv(text: string, delimiter: string): string[][] {
  const result = readCsv(text, { delimiter, maxRecords: 200001, maxColumns: 200 });
  if (!result.ok) throw new Error("the export file cannot be read");
  return result.rows;
}
function delimiter(text: string): string {
  const lines = pySplitlines(text)
    .slice(0, 300)
    .filter((ln) => pyStrip(ln));
  let best = ",",
    score = 0;
  for (const d of [";", ",", "\t", "|"]) {
    const counts = new Map<number, number>();
    const parsed = readCsv(lines.join("\n"), { delimiter: d, maxColumns: 0, collectWidths: true });
    if (!parsed.ok) throw new Error("the export file cannot be read");
    for (const w of parsed.rowWidths ?? []) {
      if (w > 1) counts.set(w, (counts.get(w) ?? 0) + 1);
    }
    const [width, freq] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? [0, 0];
    if (freq * 1000 + width > score) {
      best = d;
      score = freq * 1000 + width;
    }
  }
  return best;
}
class ExportFloat {
  readonly value: number;
  constructor(value: number) {
    this.value = value;
  }
}
function jsonType(value: unknown): string {
  return value === null
    ? "NoneType"
    : value instanceof ExportFloat || typeof value === "number"
      ? "float"
      : Array.isArray(value)
        ? "list"
        : value instanceof Map
          ? "dict"
          : typeof value === "boolean"
            ? "bool"
            : typeof value === "bigint"
              ? "int"
              : "str";
}
function jsonCell(value: unknown): string {
  return value === null || value === undefined
    ? ""
    : value instanceof ExportFloat
      ? floatRepr(value.value)
      : typeof value === "number"
        ? Number.isNaN(value)
          ? "nan"
          : value < 0
            ? "-inf"
            : "inf"
        : typeof value === "object"
          ? "<nested>"
          : typeof value === "boolean"
            ? value
              ? "True"
              : "False"
            : String(value);
}
export function inspectExportBytes(
  file: { readonly name: string; readonly bytes: Uint8Array },
  maxSamples = 5,
): L.LabelledTree {
  if (file.bytes.length > 20 * 1024 * 1024)
    throw new ToolError("file is too large (max 20 MB)", "invalid", { system: true });
  const extension = importFileExtension({ name: file.name, content: file.bytes });
  if (!["csv", "tsv", "txt", "json", "xlsx"].includes(extension))
    throw new ToolError("unsupported file type; allowed: csv, tsv, txt, json, xlsx");
  let encoding: string | null = null,
    sep: string | null = null,
    tables: readonly ExportTable[] = [];
  const structure: L.LabelledTree[] = [];
  if (extension === "xlsx") tables = readExportXlsx(file.bytes);
  else {
    const decoded = decode(file.bytes);
    encoding = decoded.encoding;
    if (extension !== "json") {
      sep = extension === "tsv" ? "\t" : delimiter(decoded.text);
      tables = [
        {
          name: "csv",
          rows: csv(decoded.text, sep)
            .slice(0, 200000)
            .map((r) => r.slice(0, 200).map(pyStrip)),
        },
      ];
    } else {
      let doc: unknown;
      try {
        doc = parsePyJson(
          decoded.text,
          (n, integer) => (integer ? BigInt(n) : new ExportFloat(Number(n))),
          (pairs) => new Map(pairs),
        );
      } catch {
        throw new ToolError("the JSON file cannot be parsed", "invalid_file");
      }
      const table = (name: string, items: unknown[]): ExportTable | null => {
        const rows = items
          .slice(0, 200000)
          .filter((v): v is Map<string, unknown> => v instanceof Map);
        if (!rows.length) return null;
        const cols: string[] = [];
        for (const row of rows)
          for (const key of row.keys())
            if (cols.length < 200 && !cols.includes(key)) cols.push(key);
        return { name, rows: [cols, ...rows.map((r) => cols.map((k) => jsonCell(r.get(k))))] };
      };
      const found: ExportTable[] = [];
      if (Array.isArray(doc)) {
        const t = table("records", doc);
        if (t !== null) found.push(t);
      } else if (doc instanceof Map)
        for (const [key, value] of doc) {
          if (Array.isArray(value)) {
            const t = table(key, value);
            if (t !== null) {
              found.push(t);
              continue;
            }
          }
          // Reuse safe-label inference for JSON keys through the same structural table path.
          structure.push({ key: L.text(safeExportLabel(key)), type: L.category(jsonType(value)) });
        }
      tables = found;
    }
  }
  return {
    file: {
      name: L.identifier(file.name),
      extension: L.category(extension),
      size_kb: L.count(Math.max(1, Math.floor(file.bytes.length / 1024))),
      encoding: L.category(encoding),
      delimiter: L.text(sep === "\t" ? "TAB" : sep === " " ? "SPACE" : sep),
    },
    sheets: tables.map((t) => describeExportTable(t, maxSamples)),
    structure,
    masking: L.fixedText(
      "numbers are shown as their format (N = digit, separators kept), dates as their pattern, identifiers as [identifier]; free text token by token: transaction-type words, currencies and booleans as they are, an e-mail as [email], a token with a digit as its shape (9 = digit, a run of 3+ letters <w>, a shorter one A, punctuation kept), any other word as <w>; only short code-like values of low-cardinality columns are shown; the same in both privacy levels",
    ),
  };
}
export function inspectExport(ctx: ToolContext<NativeToolStore>, args: ToolArgs): L.LabelledTree {
  const read = ctx.store.readInvestmentImportFile;
  if (read === undefined)
    throw new ToolError("local file inspection is unavailable", "unsupported");
  return inspectExportBytes(
    read(typeof args.path === "string" ? args.path : ""),
    typeof args.max_samples === "number" ? args.max_samples : 5,
  );
}
