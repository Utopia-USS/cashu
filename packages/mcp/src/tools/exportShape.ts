/** Python exports.py structural inference. Raw cells never become output labels directly. */
import { pyIsDigit, pyLen, pySplit, pyStrip, pyStripChars, pyUpper } from "@cashu/domain";
import * as L from "../privacy/labels.js";
import { fold, looksLikePerson } from "../privacy/names.js";
import { isinValid } from "../privacy/scrub.js";
export interface ExportTable {
  readonly name: string;
  readonly rows: readonly (readonly string[])[];
  readonly kinds?: readonly (readonly string[])[];
}
const CURRENCIES = new Set(
  "PLN EUR USD GBP CHF JPY NOK SEK DKK HUF CZK CAD AUD HKD CNY SGD NZD TRY RON BGN ILS ZAR MXN BRL INR KRW".split(
    " ",
  ),
);
const BOOL = new Set("TRUE FALSE TAK NIE YES NO".split(" "));
const VOCAB =
  "KUPNO SPRZEDAZ WPLATA WYPLATA DYWIDEND ODSETK PROWIZJ OPLATA PODATEK PRZELEW ZAKUP SPRZEDANO KUPIONO ZLECENIE WYMIANA KONWERSJA KOREKTA BUY SELL DEPOSIT WITHDRAW DIVIDEND INTEREST FEE COMMISSION TAX TRANSFER SPLIT EXCHANGE CONVERSION ADJUSTMENT CASH STOCK ETF BOND KAUF VERKAUF EINZAHLUNG AUSZAHLUNG GEBUEHR STEUER ZINS OPEN CLOSE LONG SHORT CREDIT DEBIT IN OUT YES NO TAK NIE TRUE FALSE".split(
    " ",
  );
const ENDINGS = new Set("A I Y E U O OM OW ACH AMI EM IE OWI S ES ED".split(" "));
const EDGE = "\"'()[]{}<>,;:!?.";
const NAMEISH =
  /name|nazw|imi|owner|wlasc|właśc|klient|client|holder|opis|descr|title|tytu|comment|komentarz|note|uwag|adres|address|odbior|nadaw|payee|counterpart|kontrahent|iban|account|rachun|konto|number|numer|nr\b|pesel|nip|email|phone|telefon/iu;
const DATE_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/^\p{Nd}{4}-\p{Nd}{2}-\p{Nd}{2}$/u, "YYYY-MM-DD"],
  [/^\p{Nd}{4}-\p{Nd}{2}-\p{Nd}{2}[T ]\p{Nd}{2}:\p{Nd}{2}(:\p{Nd}{2})?/u, "YYYY-MM-DD HH:MM[:SS]"],
  [/^\p{Nd}{2}\.\p{Nd}{2}\.\p{Nd}{4}$/u, "DD.MM.YYYY"],
  [/^\p{Nd}{2}\.\p{Nd}{2}\.\p{Nd}{4} \p{Nd}{2}:\p{Nd}{2}(:\p{Nd}{2})?$/u, "DD.MM.YYYY HH:MM[:SS]"],
  [/^\p{Nd}{2}\/\p{Nd}{2}\/\p{Nd}{4}$/u, "DD/MM/YYYY or MM/DD/YYYY"],
  [/^\p{Nd}{2}-\p{Nd}{2}-\p{Nd}{4}$/u, "DD-MM-YYYY"],
  [/^\p{Nd}{4}\/\p{Nd}{2}\/\p{Nd}{2}$/u, "YYYY/MM/DD"],
  [/^\p{Nd}{4}\.\p{Nd}{2}\.\p{Nd}{2}$/u, "YYYY.MM.DD"],
  [/^\p{Nd}{8}$/u, "YYYYMMDD?"],
];
const ISIN = /^[A-Z]{2}[A-Z0-9]{9}\p{Nd}$/u;
const DATA = new Set(["date", "integer", "decimal", "identifier", "isin"]);
const digitCount = (s: string) => [...s].filter((c) => /\p{Nd}/u.test(c)).length;
const alpha = (s: string) => s !== "" && /^\p{L}+$/u.test(s);
function datePattern(value: string): string | null {
  return DATE_PATTERNS.find(([r]) => r.test(value))?.[1] ?? null;
}
function numberFormat(value: string): readonly [string | null, string | null, number] | null {
  const m = /^[-+−]?(?:\p{Nd}{1,3}(?:([   '.,])\p{Nd}{3})*|\p{Nd}+)(?:([.,])(\p{Nd}+))?$/u.exec(
    value,
  );
  if (m === null || (m[1] && m[1] === m[2])) return null;
  return [m[1] ?? null, m[2] ?? null, pyLen(m[3] ?? "")];
}
function identifier(value: string): boolean {
  const compact = value.replaceAll(" ", "").replaceAll("-", "");
  return (
    (/^[A-Z]{2}\p{Nd}{2}[A-Z0-9 ]{11,40}$/u.test(value.replaceAll(" ", "")) &&
      pyLen(compact) >= 15 &&
      !ISIN.test(compact)) ||
    (digitCount(value) >= 9 && datePattern(value) === null && !ISIN.test(compact))
  );
}
function cellKind(value: string, hint: string): string {
  if (!value) return "empty";
  if (hint === "date") return "date";
  if (hint === "bool" || BOOL.has(pyUpper(value))) return "boolean";
  if (hint === "number")
    return value.includes(".") || value.toLowerCase().includes("e") ? "decimal" : "integer";
  if (datePattern(value) !== null) return "date";
  const fmt = numberFormat(value);
  if (fmt !== null) {
    if (identifier(value) && !fmt[1]) return "identifier";
    return fmt[1] ? "decimal" : "integer";
  }
  if (identifier(value)) return "identifier";
  if (isinValid(value)) return "isin";
  if (CURRENCIES.has(value)) return "currency_code";
  return /^[A-Z0-9][A-Z0-9.\-:]{0,11}$/u.test(value) ? "code" : "text";
}
function showable(value: string): boolean {
  const words = pySplit(pyStrip(fold(value)));
  if (words.length === 0 || pyLen(value) > 24 || words.length > 3) return false;
  if (isinValid(value) || CURRENCIES.has(value) || BOOL.has(pyUpper(value))) return true;
  if (words.every((w) => VOCAB.some((v) => w.startsWith(v)))) return true;
  return (
    words.length === 1 &&
    pyUpper(value) === value &&
    /\p{Lu}/u.test(value) &&
    pyLen(value) <= 6 &&
    !looksLikePerson(value)
  );
}
function shape(token: string): string {
  return token
    .split(/([\p{L}\p{Nl}\p{No}]{3,})/u)
    .map((part, i) =>
      i % 2
        ? "<w>"
        : [...part]
            .map((c) => (alpha(c) ? "A" : pyIsDigit(c.codePointAt(0) ?? 0) ? "9" : c))
            .join(""),
    )
    .join("");
}
function exportTextShape(value: string): string {
  const tokens = pySplit(value),
    out: string[] = [];
  for (let i = 0; i < Math.min(tokens.length, 40); i++) {
    const token = tokens[i] ?? "",
      core = pyStripChars(token, EDGE);
    if (!core) {
      out.push([...token].slice(0, 8).join(""));
      continue;
    }
    if (identifier(core)) {
      out.push("[identifier]");
      continue;
    }
    if (core.includes("@") && /\p{L}/u.test(core)) {
      out.push("[email]");
      continue;
    }
    const up = pyUpper(fold(core));
    if (VOCAB.includes(up) || BOOL.has(up) || CURRENCIES.has(up)) {
      out.push(token);
      continue;
    }
    if (
      alpha(up) &&
      VOCAB.some((v) => v.length >= 6 && up.startsWith(v) && ENDINGS.has(up.slice(v.length)))
    ) {
      const neighbours = [i - 1, i + 1]
        .filter((j) => j >= 0 && j < tokens.length)
        .map((j) => pyStripChars(tokens[j] ?? "", EDGE))
        .filter(alpha);
      if (
        !neighbours.some((n) => looksLikePerson(`${n} ${core}`) || looksLikePerson(`${core} ${n}`))
      ) {
        out.push(token);
        continue;
      }
    }
    if ([...core].some((c) => pyIsDigit(c.codePointAt(0) ?? 0))) {
      out.push(shape(token));
      continue;
    }
    out.push(/\p{L}/u.test(core) ? "<w>" : [...token].slice(0, 8).join(""));
  }
  if (tokens.length > 40) out.push(`<+${tokens.length - 40} words>`);
  return out.join(" ");
}
interface Column {
  readonly kind: string;
  readonly thousands: string | null;
  readonly shown: ReadonlySet<string>;
}
function mask(value: string, kind: string, column: Column): string {
  if (!value) return "";
  if (kind === "integer" || kind === "decimal") {
    const fmt = numberFormat(value) ?? [null, null, 0],
      sign = /^[-−]/u.test(pyStrip(value)) ? "-" : "";
    return (
      sign +
      "N" +
      (column.thousands ? `${column.thousands}NNN` : "") +
      (fmt[1] ? fmt[1] + "N".repeat(Math.min(fmt[2], 8)) : "")
    );
  }
  if (kind === "date") return datePattern(value) ?? "<date>";
  if (kind === "boolean") return pyUpper(value);
  if (["isin", "currency_code", "code"].includes(kind) && column.shown.has(value)) return value;
  return kind === "identifier" ? "[identifier]" : exportTextShape(value);
}
const EMPTY: Column = { kind: "text", thousands: null, shown: new Set() };
export function safeExportLabel(value: string): string {
  return looksLikePerson(value) ||
    digitCount(value) >= 4 ||
    pyLen(value) > 48 ||
    pySplit(value).length > 5 ||
    (pyStrip(value) !== "" && DATA.has(cellKind(pyStrip(value), "")))
    ? mask(value, "text", EMPTY)
    : value;
}
function counts(values: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const v of values) out.set(v, (out.get(v) ?? 0) + 1);
  return out;
}
function common(values: readonly string[]): string | null {
  return [...counts(values)].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}
function isData(row: readonly string[], width: number): boolean {
  const filled = row.filter(Boolean);
  return filled.length >= Math.max(2, width - 1) && filled.some((c) => DATA.has(cellKind(c, "")));
}
function headerRow(rows: ExportTable["rows"]): number {
  const width = Number(
    common(
      rows
        .slice(0, 200)
        .filter((r) => r.some(Boolean))
        .map((r) => String(r.filter(Boolean).length)),
    ) ?? 0,
  );
  let best = -1,
    bestKey: readonly number[] = [];
  for (let i = 0; i < Math.min(30, rows.length); i++) {
    const filled = (rows[i] ?? []).filter(Boolean),
      kinds = filled.map((c) => cellKind(c, ""));
    if (
      !filled.length ||
      kinds.filter((k) => ["text", "code", "currency_code"].includes(k)).length <
        Math.max(1, filled.length * 0.6) ||
      kinds.some((k) => DATA.has(k))
    )
      continue;
    const following = rows.slice(i + 1, i + 30).find((r) => r.some(Boolean));
    const followed = following !== undefined && isData(following, filled.length);
    if (!followed && filled.length < Math.max(1, width - 1)) continue;
    let run = 0;
    for (const r of rows.slice(i + 1, i + 51)) {
      if (!r.some(Boolean) || !isData(r, filled.length)) break;
      run++;
    }
    const key = [Number(followed), Number(run >= 2), run, filled.length, -i];
    if (
      best < 0 ||
      key.some(
        (v, j) =>
          v !== (bestKey[j] ?? 0) &&
          key.slice(0, j).every((n, k) => n === bestKey[k]) &&
          v > (bestKey[j] ?? 0),
      )
    ) {
      best = i;
      bestKey = key;
    }
  }
  return best;
}
export function describeExportTable(table: ExportTable, maxSamples: number): L.LabelledTree {
  const rows = table.rows;
  if (!rows.length)
    return {
      name: L.text(safeExportLabel(table.name)),
      rows: L.count(0),
      columns: [],
      samples: [],
    };
  const at = headerRow(rows),
    header = at >= 0 ? (rows[at] ?? []) : [],
    body = rows.slice(at + 1),
    hints = table.kinds?.slice(at + 1) ?? body.map(() => []);
  const width = Math.max(header.length, ...body.slice(0, 2000).map((r) => r.length));
  const columns: Column[] = [],
    outputs: L.LabelledTree[] = [];
  for (let idx = 0; idx < width; idx++) {
    const values = body.map((r) => r[idx] ?? ""),
      cellHints = hints.map((r) => r[idx] ?? ""),
      kinds = counts(values.map((v, i) => cellKind(v, cellHints[i] ?? ""))),
      filled = values.length - (kinds.get("empty") ?? 0);
    kinds.delete("empty");
    let kind = [...kinds].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "empty";
    if (kinds.has("identifier")) kind = "identifier";
    else if (kinds.has("text") && ["code", "currency_code", "isin"].includes(kind)) kind = "text";
    const name = header[idx] ?? (at < 0 ? `column ${idx + 1}` : ""),
      distinct = new Set(values.filter(Boolean));
    let thousands: string | null = null,
      format: string | null = null;
    if (["integer", "decimal"].includes(kind)) {
      const formats = values.filter(Boolean).map(numberFormat),
        thous = new Set(formats.flatMap((f) => f?.[0] ?? [])),
        decimals = new Set(formats.flatMap((f) => f?.[1] ?? []));
      thousands = thous.size === 1 ? ([...thous][0] ?? null) : null;
      format = `decimal separator '${[...decimals][0] ?? "none"}', thousands separator '${thousands ?? "none"}'`;
    } else if (kind === "date")
      format = [
        ...counts(
          values.flatMap((v, i) =>
            v ? [datePattern(v) ?? (cellHints[i] === "date" ? "ISO (from Excel)" : "?")] : [],
          ),
        ),
      ]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([p]) => p)
        .join(", ");
    const shown =
      ["code", "currency_code", "isin", "text", "boolean"].includes(kind) &&
      !NAMEISH.test(name) &&
      distinct.size > 0 &&
      distinct.size <= 12 &&
      filled >= 2 * distinct.size
        ? [...distinct].filter(showable).sort()
        : [];
    if (kind === "text" && shown.length) kind = "code";
    const col = { kind, thousands, shown: new Set(shown) };
    columns.push(col);
    outputs.push({
      index: L.count(idx + 1),
      header: L.text(safeExportLabel(name)),
      type: L.category(kind),
      format: L.fixedText(format),
      empty_share: L.share(values.length - filled, values.length),
      distinct: L.count(distinct.size),
      negatives: L.flag(
        ["integer", "decimal"].includes(kind) ? values.some((v) => /^[-−]/u.test(v)) : null,
      ),
      values: shown.map((v) => (ISIN.test(v) ? L.symbol(v) : L.text(v))),
    });
  }
  const samples = body.slice(0, maxSamples).map((r, j) =>
    columns.map((col, i) => {
      const value = r[i] ?? "",
        kind = col.kind === "code" ? "code" : cellKind(value, hints[j]?.[i] ?? ""),
        masked = mask(value, kind, col);
      return ISIN.test(masked) ? L.symbol(masked) : L.text(masked);
    }),
  );
  return {
    name: L.text(safeExportLabel(table.name)),
    rows: L.count(body.length),
    header_row: L.count(at >= 0 ? at + 1 : null),
    preamble_rows: L.count(Math.max(at, 0)),
    preamble: rows
      .slice(0, Math.max(at, 0))
      .map((r) => r.map((c) => L.text(mask(c, "text", EMPTY)))),
    columns: outputs,
    samples,
  };
}
