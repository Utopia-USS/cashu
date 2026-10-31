/**
 * The pydantic v2 models of `canonical.py` (`BudgetImportDocument`, `DocAccount`, `DocTransaction`,
 * `DocBalance`, all `extra="forbid"`) as a hand-written validator that reports errors in pydantic's
 * order: declared fields in order (a missing one, or its coercion error), then unknown keys in input
 * order; nested models and list items at their position. Pinned by `budget-canonical.jsonl`.
 */

import type { IsoDate } from "../../../dates.js";
import { Decimal, ONE } from "../../../decimal.js";
import {
  ACCOUNT_FIELDS,
  BALANCE_FIELDS,
  BUDGET_IMPORT_FORMAT,
  INSTITUTION_PATTERN,
  MAX_ACCOUNT_NAME,
  MAX_BALANCES,
  MAX_ID,
  MAX_TEXT,
  MAX_TRANSACTIONS,
  SOURCE_PATTERN,
  TOP_LEVEL_KEYS,
  TRANSACTION_FIELDS,
} from "./constants.js";
import {
  amount,
  type Coerced,
  currency,
  type FieldError,
  iban,
  isoDate,
  optionalAmount,
  optionalDate,
  patterned,
  text,
} from "./fields.js";
import type { JsonObject, JsonValue } from "./json.js";

export type Loc = readonly (string | number)[];
export interface PlacedError extends FieldError {
  readonly loc: Loc;
}

interface DocAccount {
  readonly currency: string;
  readonly iban: string | null;
  readonly name: string | null;
  readonly institution: string | null;
}
interface DocBalance {
  readonly date: IsoDate;
  readonly amount: Decimal;
}
interface DocTransaction {
  readonly booking_date: IsoDate;
  readonly amount: Decimal;
  readonly currency: string;
  readonly value_date: IsoDate | null;
  readonly counterparty_name: string | null;
  readonly counterparty_iban: string | null;
  readonly description: string | null;
  readonly reference: string | null;
  readonly transaction_id: string | null;
  readonly balance_after: Decimal | null;
}
export interface BudgetImportDocument {
  readonly format: string;
  readonly format_version: number;
  readonly account: DocAccount;
  readonly transactions: readonly DocTransaction[];
  readonly source: string | null;
  readonly balances: readonly DocBalance[];
}

type Result =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly errors: PlacedError[] };
type Validator = (value: JsonValue, loc: Loc) => Result;
interface FieldSpec {
  readonly validate: Validator;
  /** Absent = required (a missing key is pydantic's `missing`). */
  readonly default?: () => unknown;
}

const failAt = (loc: Loc, type: string, msg: string): Result => ({
  ok: false,
  errors: [{ type, msg, loc }],
});

function coerce(fn: (v: JsonValue) => Coerced<unknown>): Validator {
  return (value, loc) => {
    const r = fn(value);
    return r.ok ? { ok: true, value: r.value } : { ok: false, errors: [{ ...r.error, loc }] };
  };
}

function model(fields: Readonly<Record<string, FieldSpec>>, order: readonly string[]): Validator {
  return (input, loc) => {
    if (!(input instanceof Map))
      return failAt(loc, "model_type", "Input should be a valid dictionary");
    const obj = input as JsonObject;
    const errors: PlacedError[] = [];
    const out: Record<string, unknown> = {};
    for (const name of order) {
      const spec = fields[name] as FieldSpec;
      if (!obj.has(name)) {
        if (spec.default) out[name] = spec.default();
        else errors.push({ type: "missing", msg: "Field required", loc: [...loc, name] });
        continue;
      }
      const r = spec.validate(obj.get(name) as JsonValue, [...loc, name]);
      if (r.ok) out[name] = r.value;
      else errors.push(...r.errors);
    }
    for (const key of obj.keys()) {
      if (!Object.hasOwn(fields, key)) {
        errors.push({
          type: "extra_forbidden",
          msg: "Extra inputs are not permitted",
          loc: [...loc, key],
        });
      }
    }
    return errors.length ? { ok: false, errors } : { ok: true, value: out };
  };
}

function listOf(item: Validator, maxLength: number): Validator {
  return (input, loc) => {
    if (!Array.isArray(input)) return failAt(loc, "list_type", "Input should be a valid list");
    if (input.length > maxLength) {
      return {
        ok: false,
        errors: [{ type: "too_long", msg: "List too long", loc, ctx: { max_length: maxLength } }],
      };
    }
    const errors: PlacedError[] = [];
    const out: unknown[] = [];
    (input as readonly JsonValue[]).forEach((v, i) => {
      const r = item(v, [...loc, i]);
      if (r.ok) out.push(r.value);
      else errors.push(...r.errors);
    });
    return errors.length ? { ok: false, errors } : { ok: true, value: out };
  };
}

/** `Literal["cashu-budget-import"]`. */
const formatLiteral: Validator = (v, loc) =>
  v === BUDGET_IMPORT_FORMAT
    ? { ok: true, value: v }
    : failAt(loc, "literal_error", "Input should be the format");

/**
 * `Literal[1]` (lax): the int 1, or a JSON number with a fraction / exponent whose Decimal equals 1
 * (pydantic looks the value up by hash, and `Decimal("1.0") == 1`). A JSON `true` is turned into null
 * before validation.
 */
const versionLiteral: Validator = (v, loc) =>
  v === 1n || (v instanceof Decimal && v.eq(ONE))
    ? { ok: true, value: 1 }
    : failAt(loc, "literal_error", "Input should be 1");

const required = (validate: Validator): FieldSpec => ({ validate });
const optional = (validate: Validator, value: () => unknown = () => null): FieldSpec => ({
  validate,
  default: value,
});

const ACCOUNT = model(
  {
    currency: required(coerce(currency)),
    iban: optional(coerce(iban)),
    name: optional(coerce(text(MAX_ACCOUNT_NAME))),
    institution: optional(coerce(patterned(INSTITUTION_PATTERN))),
  },
  ACCOUNT_FIELDS,
);
const BALANCE = model(
  { date: required(coerce(isoDate)), amount: required(coerce(amount)) },
  BALANCE_FIELDS,
);
const TRANSACTION = model(
  {
    booking_date: required(coerce(isoDate)),
    amount: required(coerce(amount)),
    currency: required(coerce(currency)),
    value_date: optional(coerce(optionalDate)),
    counterparty_name: optional(coerce(text(MAX_TEXT))),
    counterparty_iban: optional(coerce(iban)),
    description: optional(coerce(text(MAX_TEXT))),
    reference: optional(coerce(text(MAX_ID))),
    transaction_id: optional(coerce(text(MAX_ID))),
    balance_after: optional(coerce(optionalAmount)),
  },
  TRANSACTION_FIELDS,
);
const DOCUMENT = model(
  {
    format: required(formatLiteral),
    format_version: required(versionLiteral),
    account: required(ACCOUNT),
    transactions: required(listOf(TRANSACTION, MAX_TRANSACTIONS)),
    source: optional(coerce(patterned(SOURCE_PATTERN))),
    balances: optional(listOf(BALANCE, MAX_BALANCES), () => []),
  },
  TOP_LEVEL_KEYS,
);

/** `BudgetImportDocument.model_validate(document)`: the typed document or pydantic's errors in order. */
export function validateModel(
  document: JsonObject,
):
  | { readonly ok: true; readonly doc: BudgetImportDocument }
  | { readonly ok: false; readonly errors: readonly PlacedError[] } {
  const r = DOCUMENT(document, []);
  // The validators above build exactly the BudgetImportDocument shape.
  return r.ok
    ? { ok: true, doc: r.value as BudgetImportDocument }
    : { ok: false, errors: r.errors };
}
