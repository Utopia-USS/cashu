/**
 * Configuration of the generic CSV importer: file format plus column and type mapping, loaded from YAML
 * (port of `importing/csv_mapping.py`).
 *
 * The shipped example (`generic_csv_example.yaml` next to this file) documents every key; its text is
 * not part of the domain code (reading it is the caller's job). Unknown keys are errors with a
 * did-you-mean hint and a 1-based line / column, so a typo never silently falls back to a default.
 * Expected failures are returned (`CsvMappingParse`), never thrown.
 */

import { type Currency, tryCurrency } from "../../money.js";
import { composeYaml, type YamlNode } from "../../pyYaml/index.js";
import { pyLen, pyLower, pyStrip } from "../../text.js";
import { isTxnType, TXN_TYPES, type TxnType, withDefaults } from "../domain/index.js";
import { type DecimalFormat, decimalFormat, parseDatePattern } from "./csvValues.js";
import { didYouMean } from "./didYouMean.js";
import { ImportTextEncoding, parseEncoding } from "./text.js";

/** Broker id (and alias namespace) of the generic CSV importer when a mapping sets no `broker_id`. */
export const GENERIC_CSV_BROKER_ID = "generic_csv";

export const MAPPING_VERSION = 1;
/** Largest mapping file accepted, in characters (a real one is a few kB). */
export const MAX_MAPPING_CHARS = 256_000;

/** Value of a `types:` entry that skips the row (with a non-blocking warning). */
export const IGNORE_TYPE = "ignore";

/** Target fields a CSV column can be mapped to (keys under `columns:`), in Python's order. */
export const CsvField = Object.freeze({
  EXTERNAL_REF: "external_ref",
  TRADE_DATE: "trade_date",
  SETTLE_DATE: "settle_date",
  TYPE: "type",
  SYMBOL: "symbol",
  ISIN: "isin",
  NAME: "name",
  EXCHANGE: "exchange",
  QUANTITY: "quantity",
  PRICE: "price",
  CURRENCY: "currency",
  GROSS_AMOUNT: "gross_amount",
  FEE: "fee",
  TAX: "tax",
  CASH_AMOUNT: "cash_amount",
  CASH_CURRENCY: "cash_currency",
  FX_RATE: "fx_rate",
  SPLIT_RATIO: "split_ratio",
  NOTE: "note",
} as const);
export type CsvField = (typeof CsvField)[keyof typeof CsvField];
export const CSV_FIELDS: readonly CsvField[] = Object.freeze(Object.values(CsvField));

/** How amount columns carry their direction. */
export const AmountSign = Object.freeze({
  /** `cash_amount` is signed as the broker wrote it: negative = money leaves the account. */
  SIGNED: "signed",
  /** Every amount is positive; the sign of `cash_amount` comes from the transaction type. */
  ABSOLUTE: "absolute",
} as const);
export type AmountSign = (typeof AmountSign)[keyof typeof AmountSign];
const AMOUNT_SIGNS: readonly AmountSign[] = Object.freeze(Object.values(AmountSign));

/** What happens to a row that cannot be parsed (bad number, unknown type...). */
export const RowErrorPolicy = Object.freeze({
  /** The row becomes a blocking warning: the import cannot be committed until fixed. */
  BLOCK: "block",
  /** The row is skipped with a non-blocking warning. */
  SKIP: "skip",
} as const);
export type RowErrorPolicy = (typeof RowErrorPolicy)[keyof typeof RowErrorPolicy];
const ROW_ERROR_POLICIES: readonly RowErrorPolicy[] = Object.freeze(Object.values(RowErrorPolicy));

export const DEFAULT_DATE_FORMATS: readonly string[] = Object.freeze(["yyyy-MM-dd"]);
export const DEFAULT_EXTENSIONS: readonly string[] = Object.freeze(["csv", "txt", "tsv"]);

/**
 * Configuration of `GenericCsvImporter`. Header names and type values match trimmed and
 * case-insensitively. Build it with `csvMappingFromYaml` (validated) or `csvMapping` in code.
 */
export interface CsvMapping {
  /** Target field -> header text in the file, in mapping order. */
  readonly columns: ReadonlyMap<CsvField, string>;
  /** Alias namespace of the file's symbols and the broker stored on the import batch. */
  readonly brokerId: string;
  readonly displayName: string;
  readonly encoding: ImportTextEncoding;
  readonly delimiter: string;
  readonly quote: string;
  readonly numberFormat: DecimalFormat;
  /** Date patterns tried in order (see `csvValues.datePattern`). */
  readonly dateFormats: readonly string[];
  /** 0-based index of the CSV record holding the column headers; records before it are skipped. */
  readonly headerRow: number;
  /** Broker type string -> transaction type. Unlisted values fall back to the type wire names. */
  readonly types: ReadonlyMap<string, TxnType>;
  /** Broker type strings whose rows are skipped with a non-blocking warning. */
  readonly ignoredTypes: ReadonlySet<string>;
  readonly amountSign: AmountSign;
  /** Currency for rows without a currency cell value. */
  readonly defaultCurrency: Currency | null;
  readonly onRowError: RowErrorPolicy;
  /** File extensions (lower-case, no dot) the importer accepts. */
  readonly extensions: readonly string[];
}

export type CsvMappingInit = Partial<Omit<CsvMapping, "columns">> & {
  readonly columns: ReadonlyMap<CsvField, string>;
};

/** `CsvMapping(...)`: Python's keyword defaults, frozen. */
export function csvMapping(init: CsvMappingInit): CsvMapping {
  return withDefaults<CsvMapping>(
    {
      brokerId: GENERIC_CSV_BROKER_ID,
      displayName: "Generic CSV",
      encoding: ImportTextEncoding.UTF8,
      delimiter: ",",
      quote: '"',
      numberFormat: decimalFormat(),
      dateFormats: DEFAULT_DATE_FORMATS,
      headerRow: 0,
      types: new Map<string, TxnType>(),
      ignoredTypes: new Set<string>(),
      amountSign: AmountSign.SIGNED,
      defaultCurrency: null,
      onRowError: RowErrorPolicy.BLOCK,
      extensions: DEFAULT_EXTENSIONS,
    },
    init,
  );
}

/** One problem in a mapping file. `line` and `column` are 1-based when known. */
export interface CsvMappingIssue {
  /** YAML path, e.g. `columns.trade_dat`. */
  readonly path: string;
  readonly message: string;
  readonly line: number | null;
  readonly column: number | null;
}

/** `str(CsvMappingIssue)`: `line 2:1: decimal_seperator: Unknown key`. */
export function csvMappingIssueText(issue: CsvMappingIssue): string {
  const location = issue.line === null ? "" : `line ${issue.line}:${issue.column || 0}: `;
  const path = issue.path ? `${issue.path}: ` : "";
  return `${location}${path}${issue.message}`;
}

/** `str(CsvMappingError(issues))`: the text the Python app shows for an invalid mapping. */
export function csvMappingErrorText(issues: readonly CsvMappingIssue[]): string {
  return `Invalid CSV mapping:\n${issues.map((issue) => `  ${csvMappingIssueText(issue)}`).join("\n")}`;
}

/** `CsvMapping.from_yaml`: the mapping, or every problem found (Python raises `CsvMappingError`). */
export type CsvMappingParse =
  | { readonly ok: true; readonly mapping: CsvMapping }
  | { readonly ok: false; readonly issues: readonly CsvMappingIssue[] };

/** Top-level keys of a mapping file. */
export const KNOWN_KEYS: readonly string[] = Object.freeze([
  "version",
  "name",
  "broker_id",
  "encoding",
  "delimiter",
  "quote",
  "decimal_separator",
  "thousands_separator",
  "date_formats",
  "header_row",
  "default_currency",
  "amount_sign",
  "on_row_error",
  "extensions",
  "columns",
  "types",
]);

const BROKER_ID = /^[a-z][a-z0-9_]*$/u;
const NULL_TAG = "tag:yaml.org,2002:null";
const INT_TAG = "tag:yaml.org,2002:int";
const THOUSANDS_KEYWORDS: ReadonlyMap<string, string> = new Map([
  ["none", ""],
  ["space", " "],
]);

/** Parse and validate a mapping file. */
export function csvMappingFromYaml(text: string): CsvMappingParse {
  if (pyLen(text) > MAX_MAPPING_CHARS) {
    return failed([
      issue("", `Mapping is too large (${pyLen(text)} characters, max ${MAX_MAPPING_CHARS})`),
    ]);
  }
  const composed = composeYaml(text);
  if (!composed.ok) {
    const error = composed.error;
    if (error.kind === "reader") return failed([issue("", `Invalid YAML: ${error.text}`)]);
    const mark = error.problemMark ?? error.contextMark;
    const problem = error.problem || error.context || "syntax error";
    return failed([
      {
        path: "",
        message: `Invalid YAML: ${problem}`,
        line: mark === null ? null : mark.line + 1,
        column: mark === null ? null : mark.column + 1,
      },
    ]);
  }
  return new MappingParser().parse(composed.node);
}

function failed(issues: readonly CsvMappingIssue[]): CsvMappingParse {
  return { ok: false, issues: Object.freeze([...issues]) };
}

function issue(path: string, message: string): CsvMappingIssue {
  return Object.freeze({ path, message, line: null, column: null });
}

function nodeIssue(node: YamlNode, path: string, message: string): CsvMappingIssue {
  const mark = node.startMark;
  return Object.freeze({ path, message, line: mark.line + 1, column: mark.column + 1 });
}

function isNull(node: YamlNode): boolean {
  return node.kind === "scalar" && node.tag === NULL_TAG;
}

function keyText(node: YamlNode): string {
  return node.kind === "scalar" ? node.value : "?";
}

/** Python `int(text.replace("_", ""), 10)` of an int-tagged scalar, or null when it raises. */
function pyInt(text: string): number | null {
  const digits = text.replaceAll("_", "");
  return /^[+-]?[0-9]+$/u.test(digits) ? Number(BigInt(digits)) : null;
}

function intValue(node: YamlNode): number | null {
  return node.kind === "scalar" && node.tag === INT_TAG ? pyInt(node.value) : null;
}

class MappingParser {
  private readonly issues: CsvMappingIssue[] = [];

  parse(root: YamlNode | null): CsvMappingParse {
    if (root === null || root.kind !== "mapping") {
      return failed([
        root === null
          ? issue("", "The mapping must be a YAML map")
          : nodeIssue(root, "", "The mapping must be a YAML map"),
      ]);
    }

    const entries = new Map<string, YamlNode>();
    for (const [keyNode, valueNode] of root.value) {
      const key = keyText(keyNode);
      if (!KNOWN_KEYS.includes(key)) {
        this.error(keyNode, key, `Unknown key${didYouMean(key, KNOWN_KEYS)}`);
        continue;
      }
      if (entries.has(key)) {
        this.error(keyNode, key, "Duplicate key");
        continue;
      }
      entries.set(key, valueNode);
    }

    const version = entries.get("version");
    if (version === undefined || isNull(version)) {
      this.error(root, "version", `Missing required key (use version: ${MAPPING_VERSION})`);
    } else if (intValue(version) !== MAPPING_VERSION) {
      const value = version.kind === "scalar" ? version.value : "?";
      this.error(
        version,
        "version",
        `Unsupported mapping version ${value} (expected ${MAPPING_VERSION})`,
      );
    }

    const brokerNode = entries.get("broker_id");
    const brokerId = this.string(brokerNode, "broker_id") || GENERIC_CSV_BROKER_ID;
    if (!BROKER_ID.test(brokerId)) {
      this.error(
        brokerNode ?? root,
        "broker_id",
        'Use lower-case letters, digits and "_" (e.g. mbank)',
      );
    }
    const displayName = this.string(entries.get("name"), "name") || "Generic CSV";
    const encoding = this.encoding(entries.get("encoding"));
    const delimiter = this.delimiter(entries.get("delimiter"));
    const quoteNode = entries.get("quote");
    let quote = this.string(quoteNode, "quote", false);
    if (quote === null) {
      quote = '"';
    } else if (pyLen(quote) !== 1 || quote === "\r" || quote === "\n") {
      this.error(quoteNode ?? root, "quote", "Must be exactly one character");
      quote = '"';
    }
    if (quote === delimiter) {
      this.error(quoteNode ?? root, "quote", "Must differ from the delimiter");
    }
    const numberFormat = this.numberFormat(
      entries.get("decimal_separator"),
      entries.get("thousands_separator"),
      root,
    );
    const dateFormats = this.dateFormats(entries.get("date_formats"));
    const headerRow = this.headerRow(entries.get("header_row"));
    const defaultCurrency = this.currency(entries.get("default_currency"));
    const amountSign = this.choice(entries.get("amount_sign"), "amount_sign", AMOUNT_SIGNS);
    const onRowError = this.choice(entries.get("on_row_error"), "on_row_error", ROW_ERROR_POLICIES);
    const extensions = this.extensions(entries.get("extensions"));
    const columns = this.columns(entries.get("columns"), root);
    const [types, ignored] = this.types(entries.get("types"));

    const columnsNode = entries.get("columns");
    if (
      columns !== null &&
      !columns.has(CsvField.CURRENCY) &&
      defaultCurrency === null &&
      columnsNode !== undefined
    ) {
      this.error(columnsNode, "columns", "Map a currency column or set default_currency");
    }

    if (this.issues.length > 0 || columns === null) return failed(this.issues);
    return {
      ok: true,
      mapping: csvMapping({
        columns,
        brokerId,
        displayName,
        encoding,
        delimiter,
        quote,
        numberFormat,
        dateFormats,
        headerRow,
        types,
        ignoredTypes: ignored,
        amountSign: amountSign ?? AmountSign.SIGNED,
        defaultCurrency,
        onRowError: onRowError ?? RowErrorPolicy.BLOCK,
        extensions,
      }),
    };
  }

  // --- values ------------------------------------------------------------------------------------

  private encoding(node: YamlNode | undefined): ImportTextEncoding {
    const text = this.string(node, "encoding");
    if (text === null || node === undefined) return ImportTextEncoding.UTF8;
    const encoding = parseEncoding(text);
    if (encoding === null) {
      this.error(node, "encoding", `Unknown encoding "${text}" (use utf-8, windows-1250 or auto)`);
      return ImportTextEncoding.UTF8;
    }
    return encoding;
  }

  private delimiter(node: YamlNode | undefined): string {
    const text = this.string(node, "delimiter", false);
    if (text === null || node === undefined) return ",";
    const delimiter = text === "tab" || text === "\\t" ? "\t" : text;
    if (pyLen(delimiter) !== 1 || delimiter === "\r" || delimiter === "\n") {
      this.error(node, "delimiter", 'Must be one character (e.g. ",", ";", "tab")');
      return ",";
    }
    return delimiter;
  }

  private numberFormat(
    decimalNode: YamlNode | undefined,
    thousandsNode: YamlNode | undefined,
    root: YamlNode,
  ): DecimalFormat {
    const decimal = this.string(decimalNode, "decimal_separator", false) ?? ".";
    if (decimal !== "." && decimal !== ",") {
      this.optionalError(decimalNode, "decimal_separator", 'Use "." or ","');
      return decimalFormat();
    }
    const raw = this.string(thousandsNode, "thousands_separator", false);
    const thousands = raw === null ? "" : (THOUSANDS_KEYWORDS.get(raw) ?? raw);
    if (!["", " ", ".", ",", "'"].includes(thousands)) {
      this.optionalError(
        thousandsNode,
        "thousands_separator",
        `Use "" (none), " " (or space), ".", "," or "'"`,
      );
      return decimalFormat(decimal);
    }
    if (thousands === decimal) {
      this.error(
        thousandsNode ?? root,
        "thousands_separator",
        "Must differ from decimal_separator",
      );
      return decimalFormat(decimal);
    }
    return decimalFormat(decimal, thousands);
  }

  private dateFormats(node: YamlNode | undefined): readonly string[] {
    if (node === undefined || isNull(node)) return DEFAULT_DATE_FORMATS;
    let items: readonly YamlNode[];
    if (node.kind === "sequence") {
      items = node.value;
    } else if (node.kind === "scalar") {
      items = [node];
    } else {
      this.error(node, "date_formats", "Must be a list of date patterns");
      return DEFAULT_DATE_FORMATS;
    }
    if (items.length === 0) this.error(node, "date_formats", "List at least one date pattern");
    const formats: string[] = [];
    items.forEach((item, index) => {
      const path = `date_formats[${index}]`;
      const pattern = this.string(item, path);
      if (pattern === null) return;
      const parsed = parseDatePattern(pattern);
      if (!parsed.ok) {
        this.error(item, path, parsed.message);
        return;
      }
      formats.push(pattern);
    });
    return formats.length > 0 ? Object.freeze(formats) : DEFAULT_DATE_FORMATS;
  }

  private headerRow(node: YamlNode | undefined): number {
    if (node === undefined || isNull(node)) return 0;
    const value = intValue(node);
    if (value === null || value < 0) {
      this.error(node, "header_row", "Must be a non-negative integer (0 = first record)");
      return 0;
    }
    return value;
  }

  private currency(node: YamlNode | undefined): Currency | null {
    const text = this.string(node, "default_currency");
    if (text === null || node === undefined) return null;
    const currency = tryCurrency(text);
    if (currency === null)
      this.error(node, "default_currency", `"${text}" is not an ISO 4217 code`);
    return currency;
  }

  private choice<V extends string>(
    node: YamlNode | undefined,
    path: string,
    values: readonly V[],
  ): V | null {
    const text = this.string(node, path);
    if (text === null || node === undefined) return null;
    const wanted = pyLower(text);
    const found = values.find((value) => value === wanted);
    if (found === undefined) {
      this.error(node, path, `Unknown value "${text}" (use ${values.join(", ")})`);
      return null;
    }
    return found;
  }

  private extensions(node: YamlNode | undefined): readonly string[] {
    if (node === undefined || isNull(node)) return DEFAULT_EXTENSIONS;
    if (node.kind !== "sequence" || node.value.length === 0) {
      this.error(node, "extensions", "Must be a non-empty list (e.g. [csv, txt])");
      return DEFAULT_EXTENSIONS;
    }
    const extensions: string[] = [];
    node.value.forEach((item, index) => {
      const text = this.string(item, `extensions[${index}]`);
      if (text) {
        const lower = pyLower(text);
        extensions.push(lower.startsWith(".") ? lower.slice(1) : lower);
      }
    });
    return extensions.length > 0 ? Object.freeze(extensions) : DEFAULT_EXTENSIONS;
  }

  private columns(node: YamlNode | undefined, root: YamlNode): Map<CsvField, string> | null {
    if (node === undefined || isNull(node)) {
      this.error(
        root,
        "columns",
        "Missing required key (map at least trade_date, type and an amount)",
      );
      return null;
    }
    if (node.kind !== "mapping") {
      this.error(node, "columns", 'Must be a map of field: "Header text"');
      return null;
    }
    const columns = new Map<CsvField, string>();
    for (const [keyNode, valueNode] of node.value) {
      const key = keyText(keyNode);
      const path = `columns.${key}`;
      const target = CSV_FIELDS.find((field) => field === key);
      if (target === undefined) {
        this.error(keyNode, path, `Unknown field${didYouMean(key, CSV_FIELDS)}`);
        continue;
      }
      if (columns.has(target)) {
        this.error(keyNode, path, "Duplicate field");
        continue;
      }
      const header = this.string(valueNode, path);
      if (!header) {
        this.error(valueNode, path, "Header text must not be empty");
        continue;
      }
      columns.set(target, header);
    }
    for (const required of [CsvField.TRADE_DATE, CsvField.TYPE]) {
      if (!columns.has(required)) this.error(node, "columns", `Missing required field ${required}`);
    }
    const hasAmount =
      columns.has(CsvField.CASH_AMOUNT) ||
      columns.has(CsvField.GROSS_AMOUNT) ||
      (columns.has(CsvField.QUANTITY) && columns.has(CsvField.PRICE));
    if (!hasAmount) {
      this.error(node, "columns", "Map cash_amount, gross_amount, or quantity and price");
    }
    return columns;
  }

  private types(node: YamlNode | undefined): [Map<string, TxnType>, Set<string>] {
    const types = new Map<string, TxnType>();
    const ignored = new Set<string>();
    if (node === undefined || isNull(node)) return [types, ignored];
    if (node.kind !== "mapping") {
      this.error(node, "types", 'Must be a map of "Broker type": txn_type');
      return [types, ignored];
    }
    const names = [...TXN_TYPES, IGNORE_TYPE];
    const seen = new Set<string>();
    for (const [keyNode, valueNode] of node.value) {
      const key = pyStrip(keyText(keyNode));
      const path = `types.${key}`;
      if (!key) {
        this.error(keyNode, "types", "Broker type must not be empty");
        continue;
      }
      if (seen.has(pyLower(key))) {
        this.error(keyNode, path, "Duplicate broker type");
        continue;
      }
      seen.add(pyLower(key));
      const value = this.string(valueNode, path);
      if (value === null) {
        this.error(valueNode, path, `Missing transaction type (use ${names.join(", ")})`);
        continue;
      }
      const lower = pyLower(value);
      if (lower === IGNORE_TYPE) {
        ignored.add(key);
        continue;
      }
      if (isTxnType(lower)) {
        types.set(key, lower);
      } else {
        this.error(
          valueNode,
          path,
          `Unknown transaction type "${value}"${didYouMean(value, names)}`,
        );
      }
    }
    return [types, ignored];
  }

  // --- helpers -----------------------------------------------------------------------------------

  /**
   * The scalar text of `node` (as written: numbers stay their digits), or null when absent or null
   * (`key:` with no value).
   */
  private string(node: YamlNode | undefined, path: string, trim = true): string | null {
    if (node === undefined || isNull(node)) return null;
    if (node.kind !== "scalar") {
      this.error(node, path, "Must be a single value");
      return null;
    }
    return trim ? pyStrip(node.value) : node.value;
  }

  private error(node: YamlNode, path: string, message: string): void {
    this.issues.push(nodeIssue(node, path, message));
  }

  /** `_error` with a node that may be absent (then the issue has no position). */
  private optionalError(node: YamlNode | undefined, path: string, message: string): void {
    this.issues.push(node === undefined ? issue(path, message) : nodeIssue(node, path, message));
  }
}
