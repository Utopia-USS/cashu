/**
 * The budget settings the month close reads (`modules/budget/settings.py`): the cushion (emergency fund)
 * top-up rule. Keep `target` money in the cushion accounts; while their level is below it, the month
 * close sets aside `min(missing, surplus, monthly_max)` of the surplus in the cushion currency before
 * suggesting a transfer to investments. The target is a fixed amount or N months of average spending.
 *
 * The store keeps the record in its `budget_settings` view (account gids); Python keeps it in
 * `profiles/<slug>/budget.json` (account ids). `parseBudgetSettings` is the port of `settings.parse`
 * for that file and its API body: the same validation, the same English messages.
 */

import { D, type Decimal, DecimalError, floatRepr } from "../../decimal.js";
import { pyStrip, pyUpper } from "../../text.js";

/** `MAX_TARGET_MONTHS`. */
export const MAX_TARGET_MONTHS = 36;

/** `CushionSettings`; `Id` is the caller's account id space (store gids, Python ints). */
export interface CushionSettings<Id = string> {
  readonly enabled: boolean;
  /** The currency the cushion is kept in; null = the profile's base currency. */
  readonly currency: string | null;
  /** Quantized to 0.01. */
  readonly targetAmount: Decimal | null;
  /** Months of average spending (used when `targetAmount` is not set). */
  readonly targetMonths: number | null;
  /** Accounts holding the cushion (first occurrence kept); empty = the savings accounts in the currency. */
  readonly accountIds: readonly Id[];
  /** Upper limit of one month's top-up, quantized to 0.01; null = no limit. */
  readonly monthlyMax: Decimal | null;
}

export interface BudgetSettings<Id = string> {
  readonly cushion: CushionSettings<Id>;
}

/** The defaults (`BudgetSettings()`): cushion off. */
export function defaultBudgetSettings<Id = string>(): BudgetSettings<Id> {
  return {
    cushion: {
      enabled: false,
      currency: null,
      targetAmount: null,
      targetMonths: null,
      accountIds: [],
      monthlyMax: null,
    },
  };
}

export type SettingsParse =
  | { readonly ok: true; readonly settings: BudgetSettings<number> }
  | { readonly ok: false; readonly error: string };

class SettingsError extends Error {}

const CURRENCY = /^[A-Z]{3}$/;
const CENT = D("0.01");

function isObject(v: unknown): v is Readonly<Record<string, unknown>> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Python `value in ("", None)` (a missing key reads as None). */
function isBlank(v: unknown): boolean {
  return v === "" || v === null || v === undefined;
}

/** Python truthiness of a JSON value (`x or default`). */
function isFalsy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  return isObject(v) && Object.keys(v).length === 0;
}

/** `_positive`: a positive finite number (JSON number or text), quantized to 0.01; blank = null. */
function positive(value: unknown, name: string): Decimal | null {
  if (isBlank(value)) return null;
  const bad = () => new SettingsError(`${name} must be a positive number`);
  // Python `Decimal(str(value))`: a JSON float renders as its repr.
  let text: string;
  if (typeof value === "number") text = Number.isInteger(value) ? intRepr(value) : floatRepr(value);
  else if (typeof value === "string") text = value;
  else throw bad();
  let number: Decimal;
  try {
    number = D(text);
  } catch (e) {
    if (e instanceof DecimalError) throw bad();
    throw e;
  }
  if (number.isZero() || number.isSigned()) throw bad();
  return number.quantize(CENT);
}

/**
 * A JSON integer as Python reads it: `json.loads("30000")` is an int, `str()` gives "30000"; JSON text
 * with a fraction or exponent is a float (callers that kept the source text should pass it as text).
 */
function intRepr(value: number): string {
  return Number.isSafeInteger(value) ? String(value) : floatRepr(value);
}

function targetMonths(value: unknown): number | null {
  if (isBlank(value)) return null;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_TARGET_MONTHS
  ) {
    throw new SettingsError(
      `cushion.target_months must be a whole number from 1 to ${MAX_TARGET_MONTHS}`,
    );
  }
  return value;
}

function accountIds(value: unknown): number[] {
  const ids = isFalsy(value) ? [] : value;
  if (
    !Array.isArray(ids) ||
    !ids.every((i) => typeof i === "number" && Number.isSafeInteger(i) && i > 0)
  ) {
    throw new SettingsError("cushion.account_ids must be a list of account ids");
  }
  return [...new Set(ids as number[])];
}

function currencyOf(value: unknown): string | null {
  if (isBlank(value)) return null;
  const bad = () => new SettingsError("cushion.currency must be a three-letter currency code");
  if (typeof value !== "string") throw bad();
  const code = pyUpper(pyStrip(value));
  if (!CURRENCY.test(code)) throw bad();
  return code;
}

function parseOrThrow(raw: unknown): BudgetSettings<number> {
  if (raw === null || raw === undefined) return defaultBudgetSettings();
  if (!isObject(raw)) throw new SettingsError("settings must be an object");
  const cushion = raw.cushion;
  if (cushion === null || cushion === undefined) return defaultBudgetSettings();
  if (!isObject(cushion)) throw new SettingsError("cushion must be an object");
  // Python `cushion.get("enabled", False)`: only a missing key defaults; null is not a bool.
  const enabled = "enabled" in cushion ? cushion.enabled : false;
  if (typeof enabled !== "boolean")
    throw new SettingsError("cushion.enabled must be true or false");
  const currency = currencyOf(cushion.currency);
  const targetAmount = positive(cushion.target_amount, "cushion.target_amount");
  const monthlyMax = positive(cushion.monthly_max, "cushion.monthly_max");
  const months = targetMonths(cushion.target_months);
  const ids = accountIds(cushion.account_ids);
  if (enabled && targetAmount === null && months === null) {
    throw new SettingsError("an enabled cushion needs target_amount or target_months");
  }
  return {
    cushion: { enabled, currency, targetAmount, targetMonths: months, accountIds: ids, monthlyMax },
  };
}

/** `settings.parse` of a decoded JSON value (unknown keys ignored). */
export function parseBudgetSettings(raw: unknown): SettingsParse {
  try {
    return { ok: true, settings: parseOrThrow(raw) };
  } catch (e) {
    if (e instanceof SettingsError) return { ok: false, error: e.message };
    throw e;
  }
}

/**
 * `settings.load` of the file's bytes: the parsed settings, the defaults when the file is missing
 * (null), not UTF-8 / JSON, or invalid.
 */
export function loadBudgetSettings(bytes: Uint8Array | null): BudgetSettings<number> {
  if (bytes === null) return defaultBudgetSettings();
  let raw: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    // PARITY: Python's `json.loads` also takes NaN / Infinity literals (an invalid value anyway).
    raw = JSON.parse(text);
  } catch {
    return defaultBudgetSettings();
  }
  const parsed = parseBudgetSettings(raw);
  return parsed.ok ? parsed.settings : defaultBudgetSettings();
}

/** An account the cushion check reads (the profile's own, in storage order). */
export interface CushionAccountRef {
  readonly id: string;
  readonly name: string;
  readonly currency: string;
}

/** What the cushion account check found wrong (value-free codes live in the callers). */
export type CushionAccountsProblem =
  | { readonly kind: "unknown_account"; readonly ids: readonly string[] }
  | {
      readonly kind: "wrong_currency";
      readonly currency: string;
      readonly names: readonly string[];
    };

/**
 * The account check of `PUT /budget/settings` (budget api.py): every chosen account must be one of the
 * profile's (`accounts`), in the cushion currency (`currency`, else the base currency). Unknown ids
 * come first, then accounts in another currency; null when the choice is fine or empty.
 */
export function checkCushionAccounts(
  cushion: CushionSettings,
  accounts: readonly CushionAccountRef[],
  baseCurrency: string,
): CushionAccountsProblem | null {
  if (cushion.accountIds.length === 0) return null;
  const currency = cushion.currency || baseCurrency;
  const chosen = new Set(cushion.accountIds);
  const found = accounts.filter((a) => chosen.has(a.id));
  const known = new Set(found.map((a) => a.id));
  const missing = cushion.accountIds.filter((id) => !known.has(id));
  if (missing.length > 0) return { kind: "unknown_account", ids: missing };
  const wrong = found.filter((a) => a.currency !== currency).map((a) => a.name);
  return wrong.length > 0 ? { kind: "wrong_currency", currency, names: wrong } : null;
}

/** `checkCushionAccounts` as the English message Python words it (`PUT /budget/settings` detail). */
export function cushionAccountsError(
  cushion: CushionSettings,
  accounts: readonly CushionAccountRef[],
  baseCurrency: string,
): string | null {
  const problem = checkCushionAccounts(cushion, accounts, baseCurrency);
  if (problem === null) return null;
  return problem.kind === "unknown_account"
    ? `unknown account id(s): ${problem.ids.join(", ")}`
    : `cushion accounts must be in ${problem.currency}: ${problem.names.join(", ")}`;
}
