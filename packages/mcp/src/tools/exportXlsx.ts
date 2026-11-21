/** Minimal XLSX reader: cached cell values only, no evaluation, I/O or external relationships. */
import { addDays, pyStrip } from "@cashu/domain";
import { DOMParser, type Element } from "@xmldom/xmldom";
import { Unzip, UnzipInflate } from "fflate";
import { ToolError } from "../registry.js";
import type { ExportTable } from "./exportShape.js";

const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const XLSX_UNCOMPRESSED_LIMIT = 200 * 1024 * 1024;
const XLSX_ENTRY_LIMIT = 10000;
const invalid = () => new ToolError("the XLSX file cannot be read", "invalid_file");
const tooLarge = () => new ToolError("the XLSX file is too large when unpacked");
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let i = 0; i < 8; i++) crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
/** Validate central sizes before inflate, then count actual streaming output before retaining it. */
export function boundedXlsxEntries(
  data: Uint8Array,
  limit = XLSX_UNCOMPRESSED_LIMIT,
): ReadonlyMap<string, Uint8Array> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let eocd = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--)
    if (
      view.getUint32(i, true) === 0x06054b50 &&
      i + 22 + view.getUint16(i + 20, true) === data.length
    ) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new ToolError("the XLSX file cannot be opened", "invalid_file");
  const total = view.getUint16(eocd + 10, true),
    size = view.getUint32(eocd + 12, true),
    offset = view.getUint32(eocd + 16, true);
  if (
    view.getUint16(eocd + 4, true) !== 0 ||
    view.getUint16(eocd + 6, true) !== 0 ||
    view.getUint16(eocd + 8, true) !== total ||
    total === 0xffff ||
    size === 0xffffffff ||
    offset === 0xffffffff ||
    offset + size !== eocd ||
    total > XLSX_ENTRY_LIMIT
  )
    throw invalid();
  const declared = new Map<string, { size: number; crc: number }>();
  let cursor = offset,
    sum = 0;
  for (let i = 0; i < total; i++) {
    if (cursor + 46 > eocd || view.getUint32(cursor, true) !== 0x02014b50) throw invalid();
    const flags = view.getUint16(cursor + 8, true),
      method = view.getUint16(cursor + 10, true),
      unpacked = view.getUint32(cursor + 24, true),
      nameLen = view.getUint16(cursor + 28, true),
      extra = view.getUint16(cursor + 30, true),
      comment = view.getUint16(cursor + 32, true);
    if (
      cursor + 46 + nameLen + extra + comment > eocd ||
      flags & 1 ||
      ![0, 8].includes(method) ||
      unpacked === 0xffffffff
    )
      throw invalid();
    const nameBytes = data.subarray(cursor + 46, cursor + 46 + nameLen);
    if ([...nameBytes].some((c) => c < 32 || c > 126)) throw invalid();
    const name = new TextDecoder().decode(nameBytes);
    if (
      !name ||
      name.startsWith("/") ||
      name.includes("\\") ||
      name.split("/").some((p) => p === ".." || p === ".") ||
      declared.has(name)
    )
      throw invalid();
    declared.set(name, { size: unpacked, crc: view.getUint32(cursor + 16, true) });
    sum += unpacked;
    if (sum > limit || unpacked > limit) throw tooLarge();
    cursor += 46 + nameLen + extra + comment;
  }
  if (cursor !== eocd) throw invalid();
  const entries = new Map<string, Uint8Array>(),
    seen = new Set<string>();
  let actual = 0,
    refusal: ToolError | undefined;
  const unzip = new Unzip((file) => {
    const expected = declared.get(file.name);
    if (expected === undefined || seen.has(file.name)) throw invalid();
    seen.add(file.name);
    const chunks: Uint8Array[] = [];
    let bytes = 0,
      crc = 0xffffffff;
    file.ondata = (error, chunk, final) => {
      if (error) throw refusal ?? invalid();
      bytes += chunk.length;
      actual += chunk.length;
      if (bytes > limit || actual > limit || bytes > expected.size) {
        refusal = tooLarge();
        file.terminate();
        return;
      }
      for (const byte of chunk) crc = (CRC_TABLE[(crc ^ byte) & 255] ?? 0) ^ (crc >>> 8);
      chunks.push(chunk);
      if (final) {
        if (bytes !== expected.size || (crc ^ 0xffffffff) >>> 0 !== expected.crc) throw invalid();
        const output = new Uint8Array(bytes);
        let at = 0;
        for (const part of chunks) {
          output.set(part, at);
          at += part.length;
        }
        entries.set(file.name, output);
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  try {
    for (let at = 0; at < data.length; at += 512) {
      unzip.push(data.subarray(at, at + 512), at + 512 >= data.length);
      if (refusal !== undefined) throw refusal;
    }
  } catch (error) {
    if (refusal !== undefined) throw refusal;
    if (error instanceof ToolError) throw error;
    throw invalid();
  }
  if (entries.size !== declared.size || actual !== sum) throw invalid();
  return entries;
}
const elements = (root: Element, name: string): Element[] =>
  Array.from(root.getElementsByTagNameNS(NS, name));
function xml(entries: ReadonlyMap<string, Uint8Array>, name: string): Element {
  const bytes = entries.get(name);
  if (bytes === undefined) throw invalid();
  let encoding = "utf-8";
  if (
    (bytes[0] === 0xff && bytes[1] === 0xfe) ||
    (bytes[0] === 0x3c && bytes[1] === 0 && bytes[2] === 0x3f && bytes[3] === 0)
  )
    encoding = "utf-16le";
  else if (
    (bytes[0] === 0xfe && bytes[1] === 0xff) ||
    (bytes[0] === 0 && bytes[1] === 0x3c && bytes[2] === 0 && bytes[3] === 0x3f)
  )
    encoding = "utf-16be";
  const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  if (/<!\s*(?:DOCTYPE|ENTITY)/iu.test(text)) throw invalid();
  const document = new DOMParser({
    onError: () => {
      throw invalid();
    },
  }).parseFromString(text, "application/xml");
  if (document.documentElement === null) throw invalid();
  return document.documentElement;
}
function direct(root: Element, name: string, namespace = NS): Element[] {
  return Array.from(root.childNodes).filter(
    (n): n is Element => n.nodeType === 1 && n.namespaceURI === namespace && n.localName === name,
  );
}
export function readExportXlsx(data: Uint8Array): readonly ExportTable[] {
  const entries = boundedXlsxEntries(data);
  try {
    const shared = entries.has("xl/sharedStrings.xml")
      ? elements(xml(entries, "xl/sharedStrings.xml"), "si").map((si) =>
          elements(si, "t")
            .map((t) => t.textContent ?? "")
            .join(""),
        )
      : [];
    const dateStyles = new Set<number>();
    if (entries.has("xl/styles.xml")) {
      const styles = xml(entries, "xl/styles.xml"),
        custom = new Map(
          elements(styles, "numFmt").map((n) => [
            Number(n.getAttribute("numFmtId")),
            (n.getAttribute("formatCode") ?? "").toLowerCase(),
          ]),
        );
      const cellXfs = direct(styles, "cellXfs")[0];
      for (const [i, xf] of (cellXfs === undefined ? [] : direct(cellXfs, "xf")).entries()) {
        const fid = Number(xf.getAttribute("numFmtId") || 0),
          code = (custom.get(fid) ?? "").replace(/"[^"]*"|\[[^\]]*\]/gu, "");
        if (
          (fid >= 14 && fid <= 22) ||
          [45, 46, 47].includes(fid) ||
          (code && /[dy]|m{1,2}(?![^;]*0)/u.test(code) && !/0[.,]0/u.test(code))
        )
          dateStyles.add(i);
      }
    }
    const workbook = xml(entries, "xl/workbook.xml"),
      rels = xml(entries, "xl/_rels/workbook.xml.rels"),
      targets = new Map<string, string>();
    for (const node of Array.from(rels.childNodes))
      if (node.nodeType === 1) {
        const r = node as Element;
        if (r.getAttribute("TargetMode") === "External") throw invalid();
        targets.set(r.getAttribute("Id") ?? "", r.getAttribute("Target") ?? "");
      }
    const tables: ExportTable[] = [];
    for (const sheet of elements(workbook, "sheet")) {
      let target = (targets.get(sheet.getAttributeNS(REL, "id") ?? "") ?? "").replace(/^\/+/, "");
      target = target.startsWith("xl/") ? target : `xl/${target}`;
      if (target.includes(":") || target.split("/").includes("..")) throw invalid();
      if (!entries.has(target)) continue;
      const rows: string[][] = [],
        kinds: string[][] = [];
      for (const row of elements(xml(entries, target), "row")) {
        if (rows.length >= 200000) break;
        const values = new Map<number, readonly [string, string]>();
        for (const cell of direct(row, "c")) {
          const letters = /^[A-Z]+/u.exec(cell.getAttribute("r") ?? "")?.[0] ?? "A";
          // Stop before the huge sparse reference could overflow or allocate a large array.
          let idx = 0;
          for (const letter of letters) {
            idx = idx * 26 + letter.charCodeAt(0) - 64;
            if (idx > 200) break;
          }
          idx--;
          if (idx >= 200) continue;
          const type = cell.getAttribute("t") || "n",
            raw = direct(cell, "v")[0]?.textContent ?? "";
          if (type === "s")
            values.set(idx, [/^\d+$/u.test(raw) ? (shared[Number(raw)] ?? "") : "", ""]);
          else if (type === "inlineStr")
            values.set(idx, [
              elements(cell, "t")
                .map((t) => t.textContent ?? "")
                .join(""),
              "",
            ]);
          else if (type === "b") values.set(idx, [raw === "1" ? "TRUE" : "FALSE", "bool"]);
          else if (type === "str" || type === "e") values.set(idx, [raw, ""]);
          else if (raw) {
            let value = raw,
              kind = "number";
            if (dateStyles.has(Number(cell.getAttribute("s") || 0))) {
              try {
                value = addDays("1899-12-30", Math.floor(Number(raw)));
                kind = "date";
              } catch {
                value = raw;
              }
            }
            values.set(idx, [value, kind]);
          }
        }
        const width = values.size === 0 ? 0 : Math.max(...values.keys()) + 1;
        rows.push(Array.from({ length: width }, (_, i) => pyStrip(values.get(i)?.[0] ?? "")));
        kinds.push(Array.from({ length: width }, (_, i) => values.get(i)?.[1] ?? ""));
      }
      tables.push({ name: sheet.getAttribute("name") || "sheet", rows, kinds });
    }
    return tables;
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw invalid();
  }
}
