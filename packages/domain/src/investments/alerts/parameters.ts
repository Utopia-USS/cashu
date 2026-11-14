/** Python dictionary access and scalar conversion at the stored-alert evaluation boundary. */
import { D, type Decimal, DecimalError, floatRepr } from "../../decimal.js";
import { pyReprStr } from "../../pyRepr.js";
import { pyStrip, unicodeDecimal } from "../../text.js";
import type { AlertDefinition } from "./types.js";

function failure(name: string, message: string): never {
  const error = new Error(message);
  error.name = name;
  throw error;
}
export function parameter(
  alert: AlertDefinition,
  key: string,
  ...fallback: readonly unknown[]
): unknown {
  if (Object.hasOwn(alert.params, key)) return alert.params[key];
  if (fallback.length) return fallback[0];
  return failure("KeyError", pyReprStr(key));
}
export function parameterText(value: unknown): string {
  if (value == null) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  return typeof value === "number"
    ? Number.isInteger(value)
      ? String(value)
      : floatRepr(value)
    : String(value);
}
export function integerParameter(value: unknown): number {
  if (value == null)
    return failure(
      "TypeError",
      "int() argument must be a string, a bytes-like object or a real number, not 'NoneType'",
    );
  if (typeof value === "number") {
    if (Number.isNaN(value)) return failure("ValueError", "cannot convert float NaN to integer");
    if (!Number.isFinite(value))
      return failure("OverflowError", "cannot convert float infinity to integer");
    return Math.trunc(value);
  }
  if (typeof value === "bigint" || typeof value === "boolean") return Number(value);
  if (typeof value === "string" && /^[+-]?\d+$/.test(value.trim())) return Number(value);
  return failure(
    "ValueError",
    `invalid literal for int() with base 10: ${pyReprStr(parameterText(value))}`,
  );
}
export function floatParameter(value: unknown): number {
  if (value == null)
    return failure(
      "TypeError",
      "float() argument must be a string or a real number, not 'NoneType'",
    );
  if (typeof value === "string") {
    const text = Array.from(pyStrip(value), (char) => {
      const digit = unicodeDecimal(char.codePointAt(0) ?? 0);
      return digit < 0 ? char : String(digit);
    }).join("");
    const digits = "[0-9](?:_?[0-9])*";
    const literal = new RegExp(
      `^[+-]?(?:(?:${digits}(?:\\.(?:${digits})?)?|\\.${digits})(?:e[+-]?${digits})?|inf(?:inity)?|nan)$`,
      "i",
    );
    if (!literal.test(text))
      return failure("ValueError", `could not convert string to float: ${pyReprStr(value)}`);
    const normalized = text.replaceAll("_", "").toLowerCase();
    if (/^[+-]?nan$/.test(normalized)) return NaN;
    if (/^[+-]?inf(?:inity)?$/.test(normalized))
      return normalized.startsWith("-") ? -Infinity : Infinity;
    return Number(normalized);
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint")
    return Number(value);
  return failure(
    "TypeError",
    `float() argument must be a string or a real number, not '${Array.isArray(value) ? "list" : "dict"}'`,
  );
}
export function decimalParameter(value: unknown): Decimal {
  try {
    return D(parameterText(value));
  } catch (error) {
    if (error instanceof DecimalError)
      return failure("InvalidOperation", "[<class 'decimal.ConversionSyntax'>]");
    throw error;
  }
}
