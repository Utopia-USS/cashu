/**
 * The privacy layer between tool handlers and the agent (port of `core/mcp/redaction.py`).
 *
 * `new Redactor({ privacy, guard }).apply(tree)` turns a handler's labelled tree into plain JSON:
 *
 * - `identifier` -> the key is dropped (both modes);
 * - `amount` -> dropped in `strict`, a number in `amounts`;
 * - `merchant` -> sent, private-person payees as an opaque `payee:` reference (`NameGuard`);
 * - `text` / `category` / `account` / `symbol` -> scrubbed (`scrubText`; in strict a symbol without a
 *   letter is scrubbed as text);
 * - `percent` / `level` / `count` / `ref` / `flag` / `date` -> type-checked and sent.
 *
 * A raw (unlabelled) leaf throws `UnlabelledValue`: the call fails closed. After redaction,
 * `leakCheck` scans the result once more (identifier-like strings and 10+ digit numbers in any mode;
 * in `strict` also any number under a money-like key) and throws `LeakDetected` instead of sending.
 */

import { Decimal, formatDateTime, PY_D, PY_END, PY_WS, pyLen, toUtc, uRegex } from "@cashu/domain";
import {
  Labelled,
  type LabelledTree,
  marketOk,
  NO_SUMMARIES,
  pyFloat,
  type SummaryCheck,
} from "./labels.js";
import type { NameGuard } from "./names.js";
import { type JsonValue, pyDumps } from "./pyJson.js";
import { isDateTime, pyIsDigit, pyStr } from "./pyText.js";
import { identifierIn, isinValid, scrubText } from "./scrub.js";

export type Privacy = "strict" | "amounts";
export const STRICT: Privacy = "strict";
export const AMOUNTS: Privacy = "amounts";

/** A tool returned a value without a valid sensitivity label (a bug; nothing is sent). */
export class UnlabelledValue extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "UnlabelledValue";
  }
}

/** The final check found something that must not leave the machine (nothing is sent). */
export class LeakDetected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeakDetected";
  }
}

const DROP = Symbol("drop");
/** Numbers these labels carry are never money: a money-like key does not refuse them (D6, N7). */
const NON_MONEY_LABELS: ReadonlySet<string> = new Set(["count", "percent", "ref"]);
type Walked = JsonValue | typeof DROP;

const KEY = uRegex(`^[a-z_][a-z0-9_]{0,63}${PY_END}`);
const SYMBOL = uRegex(`^[A-Z0-9][A-Z0-9.\\-:=^_/]{0,19}${PY_END}`);
const REF = uRegex(`^(?:${PY_D}{1,12}|[a-z][a-z0-9_]*:[0-9a-z]{6,64})${PY_END}`);
/** A date label: a year, a quarter, a month, a day or an ISO timestamp (fraction of at most 9 digits). */
const DATE_STR = uRegex(
  `^${PY_D}{4}(?:-Q[1-4]|-${PY_D}{2}(?:-${PY_D}{2}(?:[T ]${PY_D}{2}:${PY_D}{2}(?::${PY_D}{2}(?:\\.${PY_D}{1,9})?)?` +
    `(?:Z|[+\\-]${PY_D}{2}:?${PY_D}{2})?)?)?)?${PY_END}`,
);
const HAS_LETTER = /[A-Z]/;

function typeName(value: unknown): string {
  if (value instanceof Decimal) return "Decimal";
  if (isDateTime(value)) return "datetime";
  if (Array.isArray(value)) return "list";
  if (typeof value === "bigint") return "int";
  if (typeof value === "number") return "float";
  if (typeof value === "string") return "str";
  if (typeof value === "boolean") return "bool";
  return typeof value;
}

function number(value: unknown, path: string): number | bigint | null {
  if (value === null) return null;
  if (typeof value === "boolean") throw new UnlabelledValue(`${path}: a boolean is not a number`);
  if (typeof value === "bigint" || typeof value === "number") return value;
  if (value instanceof Decimal) return pyFloat(value);
  throw new UnlabelledValue(`${path}: expected a number, got ${typeName(value)}`);
}

/** `str(value)` or fail closed (Python would send an object's repr; nothing here may hold one). */
function str(value: unknown, path: string): string {
  const s = pyStr(value);
  if (s === null) throw new UnlabelledValue(`${path}: unlabelled ${typeName(value)}`);
  return s;
}

function isPlainObject(node: unknown): node is { readonly [key: string]: LabelledTree } {
  if (typeof node !== "object" || node === null) return false;
  const proto = Object.getPrototypeOf(node);
  return proto === Object.prototype || proto === null;
}

export interface RedactorOptions {
  readonly privacy: string;
  readonly guard?: NameGuard | null;
  /** The macro summary check for `market` text (investments); without it only labels and numbers pass. */
  readonly summaryOk?: SummaryCheck;
}

export class Redactor {
  readonly privacy: Privacy;
  readonly strict: boolean;
  readonly guard: NameGuard | null;
  /** The ISINs symbol fields carried: the only ISIN-shaped digit runs the leak check lets through. */
  readonly isins = new Set<string>();
  /** Paths (in the redacted answer) of count-, percent- and ref-labelled numbers: never money (D6, N7). */
  readonly nonMoney = new Set<string>();
  private readonly summaryOk: SummaryCheck;

  constructor({ privacy, guard = null, summaryOk = NO_SUMMARIES }: RedactorOptions) {
    this.privacy = privacy === AMOUNTS ? AMOUNTS : STRICT;
    this.strict = this.privacy === STRICT;
    this.guard = guard;
    this.summaryOk = summaryOk;
  }

  text(value: string): string {
    return scrubText(value, { strict: this.strict, guard: this.guard });
  }

  apply(tree: LabelledTree): JsonValue {
    const out = this.walk(tree, "$", "$");
    return out === DROP ? null : out;
  }

  private walk(node: unknown, path: string, outPath: string): Walked {
    if (node === null) return null;
    if (node instanceof Labelled) {
      if (NON_MONEY_LABELS.has(node.label) && node.value !== null) this.nonMoney.add(outPath);
      return this.leaf(node, path);
    }
    if (Array.isArray(node)) {
      const kept: JsonValue[] = [];
      node.forEach((v, i) => {
        const item = this.walk(v, `${path}[${i}]`, `${outPath}[${kept.length}]`);
        if (item !== DROP) kept.push(item);
      });
      return kept;
    }
    if (isPlainObject(node)) {
      const out: { [key: string]: JsonValue } = Object.create(null);
      for (const key of Object.keys(node)) {
        if (!KEY.test(key)) {
          // Keys are chosen by code (snake_case); data never becomes a key.
          throw new UnlabelledValue(`${path}: dict keys must be snake_case names`);
        }
        const item = this.walk(node[key], `${path}.${key}`, `${outPath}.${key}`);
        if (item !== DROP) out[key] = item;
      }
      return out;
    }
    throw new UnlabelledValue(`${path}: unlabelled ${typeName(node)}`);
  }

  private leaf(node: Labelled, path: string): Walked {
    const { label, value } = node;
    if (label === "identifier") return DROP;
    if (label === "amount") return this.strict ? DROP : number(value, path);
    if (value === null) return null;
    switch (label) {
      case "percent":
      case "level":
        return number(value, path);
      case "count":
        if (typeof value !== "bigint")
          throw new UnlabelledValue(`${path}: a count must be an integer`);
        return value;
      case "flag":
        if (typeof value !== "boolean")
          throw new UnlabelledValue(`${path}: a flag must be a boolean`);
        return value;
      case "date":
        if (isDateTime(value)) return formatDateTime(toUtc(value)); // naive = UTC (SQLite), never sent naive
        if (typeof value === "string" && DATE_STR.test(value)) return value;
        throw new UnlabelledValue(`${path}: not a date`);
      case "ref": {
        const ref = str(value, path);
        if (!REF.test(ref)) throw new UnlabelledValue(`${path}: not a reference`);
        return typeof value === "bigint" ? value : ref;
      }
      case "merchant": {
        let merchant = str(value, path);
        if (this.guard !== null) merchant = this.guard.merchant(merchant) as string;
        return merchant.startsWith("payee:") ? merchant : this.text(merchant);
      }
      case "symbol": {
        const sym = str(value, path);
        if (isinValid(sym)) {
          this.isins.add(sym); // the leak check lets exactly these through
          return sym;
        }
        if (this.guard?.symbols.has(sym)) {
          // a digit-only ticker of one of the profile's instruments (S37fix R5)
          return scrubText(sym, { strict: false, guard: this.guard });
        }
        if (
          SYMBOL.test(sym) &&
          !(pyIsDigit(sym) && pyLen(sym) >= 5) &&
          (!this.strict || HAS_LETTER.test(sym))
        ) {
          // a ticker-like token: identifiers and known names are still scrubbed (in strict a
          // symbol without a letter is a number and goes through the strict scrub, F8)
          return scrubText(sym, { strict: false, guard: this.guard });
        }
        return this.text(sym);
      }
      case "text":
      case "category":
      case "account":
        return this.text(str(value, path));
      case "authored": {
        let authored = str(value, path);
        if (this.strict && this.guard !== null) authored = this.guard.swapAliases(authored);
        return scrubText(authored, { strict: false, guard: this.guard });
      }
      case "market":
        if (!marketOk(value, this.summaryOk)) throw new UnlabelledValue(`${path}: not market text`);
        return scrubText(value as string, { strict: false, guard: this.guard });
      default:
        throw new UnlabelledValue(`${path}: unknown label ${String(label)}`);
    }
  }
}

// --------------------------------------------------------------------------- final check

/**
 * Keys whose numbers are money or quantities: in strict mode none may carry a number. Besides these
 * names, a key is a money key when its normalized form (lower case, separators removed) contains a
 * money word, or one of its parts is "sum" / "net" or a currency code (S37fix D6, N7). Nothing
 * overrides a money word; numbers the tool labelled as counts, percentages or refs are exempt by their
 * path (`Redactor.nonMoney`), not by their key.
 */
export const MONEY_KEYS: ReadonlySet<string> = new Set([
  "amount",
  "amounts",
  "value",
  "values",
  "total",
  "totals",
  "cost",
  "price",
  "quantity",
  "balance",
  "income",
  "expense",
  "expenses",
  "net",
  "outstanding",
  "principal",
  "payment",
  "monthly_payment",
  "cash",
  "market_value",
  "gross",
  "gross_amount",
  "cash_amount",
  "fee",
  "tax",
  "installment",
  "typical_amount",
  "assets",
  "liabilities",
  "realized",
  "unrealized",
  "to_target",
  "monthly_amount",
  "min_trade_value",
  "unit_value",
]);
const MONEY_KEY_WORDS: readonly string[] = [
  "amount",
  "kwota",
  "balance",
  "saldo",
  "value",
  "wartosc",
  "price",
  "cena",
  "cost",
  "koszt",
  "total",
  "suma",
  "cash",
  "income",
  "przychod",
  "expense",
  "fee",
  "tax",
  "payment",
  "platnosc",
  "principal",
  "outstanding",
  "quantity",
  "gross",
  "installment",
  "rata",
  "kredyt",
  "loan",
  "worth",
  "spend",
  "deposit",
  "withdrawal",
  "proceeds",
  "pnl",
  "profit",
  "gain",
  "saving",
  "debt",
  "salary",
  "capital",
  "equity",
  "budget",
];
const MONEY_KEY_PARTS: ReadonlySet<string> = new Set(
  "sum sums net pln eur usd chf gbp jpy czk huf sek nok".split(" "),
);
/**
 * An alert's last public price level or ratio ("last_value": the only level-labelled number under a
 * money word; an owner-named instrument's price is amount-labelled and dropped).
 */
const NOT_MONEY_KEYS: ReadonlySet<string> = new Set(["last_value"]);
const KEY_SEPARATORS = uRegex(`[_\\-${PY_WS}]+`, "g");

/** True when a number under `key` would be money or a quantity (strict mode refuses it). */
export function isMoneyKey(key: string): boolean {
  if (MONEY_KEYS.has(key)) return true;
  if (NOT_MONEY_KEYS.has(key)) return false;
  const lowered = key.toLowerCase();
  const joined = lowered.replace(KEY_SEPARATORS, "");
  if (MONEY_KEY_WORDS.some((w) => joined.includes(w))) return true;
  return lowered.split(KEY_SEPARATORS).some((part) => MONEY_KEY_PARTS.has(part));
}

/** A number of 10+ digits in its JSON text (an account number stored as a number). */
const LONG_DIGITS = uRegex(`(?<!${PY_D})${PY_D}(?:[ \\u00a0/_\\-]{0,2}${PY_D}){9,}(?!${PY_D})`);

export interface LeakCheckOptions {
  readonly strict: boolean;
  /** The ISINs symbol fields carried (`Redactor.isins`). */
  readonly isins?: ReadonlySet<string>;
  /** Paths of count-, percent- and ref-labelled numbers (`Redactor.nonMoney`): never refused by key. */
  readonly nonMoney?: ReadonlySet<string>;
}

/**
 * Throw `LeakDetected` when the redacted `result` still holds an identifier-like string (any key
 * or string value, normalized like the scrub), a number of 10+ digits, or (strict) a number under a
 * money key.
 */
export function leakCheck(
  result: JsonValue,
  { strict, isins = new Set(), nonMoney = new Set() }: LeakCheckOptions,
): void {
  checkIdentifiers(result, isins);
  if (strict) checkMoneyKeys(result, "$", nonMoney);
}

function checkIdentifiers(node: JsonValue, isins: ReadonlySet<string>): void {
  if (Array.isArray(node)) {
    for (const value of node) checkIdentifiers(value, isins);
  } else if (typeof node === "string") {
    if (identifierIn(node, isins)) throw new LeakDetected("identifier-like value in the response");
  } else if (typeof node === "number" || typeof node === "bigint") {
    if (LONG_DIGITS.test(pyDumps(node))) {
      throw new LeakDetected("identifier-like value in the response");
    }
  } else if (typeof node === "object" && node !== null) {
    const obj = node as { readonly [key: string]: JsonValue };
    for (const key of Object.keys(obj)) {
      checkIdentifiers(key, isins);
      checkIdentifiers(obj[key] as JsonValue, isins);
    }
  }
}

function checkMoneyKeys(node: JsonValue, path: string, nonMoney: ReadonlySet<string>): void {
  if (Array.isArray(node)) {
    for (const [i, value] of node.entries()) checkMoneyKeys(value, `${path}[${i}]`, nonMoney);
  } else if (typeof node === "object" && node !== null) {
    const obj = node as { readonly [key: string]: JsonValue };
    for (const key of Object.keys(obj)) {
      const value = obj[key] as JsonValue;
      const where = `${path}.${key}`;
      if (
        isMoneyKey(key) &&
        (typeof value === "number" || typeof value === "bigint") &&
        !nonMoney.has(where)
      ) {
        throw new LeakDetected(`number under the money key ${where} in strict mode`);
      }
      checkMoneyKeys(value, where, nonMoney);
    }
  }
}
