/** Pure catalog validation with ordered issues and Python ParamReader/compiled-expression semantics. */
import type { PyPlain, PyPlainMap } from "../../pyYaml/plain.js";
import { pyStr } from "../../pyYaml/plain.js";
import { pyLen, pySplit, pyStrip } from "../../text.js";
import { didYouMean, expr, ParamErrors, ParamReader } from "../rules/index.js";
import { CATALOG } from "./catalog.js";
import {
  type AlertKind,
  AlertScope,
  BREAKOUT_RANGE,
  BREAKOUT_WINDOW,
  KINDS,
  MAX_CHANGE_THRESHOLD,
  MAX_EXPRESSION_LENGTH,
  MAX_NOTE_LENGTH,
  MAX_TAG_LENGTH,
  MAX_TITLE_LENGTH,
  MAX_WINDOW_DAYS,
  PRICE_KINDS,
  VOLUME_MULTIPLE,
  VOLUME_WINDOW,
} from "./types.js";

export type AlertIssue = [field: string, message: string];
export class AlertValidationError extends Error {
  readonly issues: readonly AlertIssue[];
  constructor(issues: readonly AlertIssue[]) {
    super(issues.map(([key, message]) => (key ? `${key}: ${message}` : message)).join("; "));
    this.name = "AlertValidationError";
    this.issues = [...issues];
  }
}
export interface ValidatedAlert {
  readonly kind: AlertKind;
  readonly scope: AlertScope;
  readonly params: Readonly<Record<string, unknown>>;
  readonly bucketRefs: readonly string[];
}

/** Map inputs preserve Python int/float types; JSON records use the native integer-number convention. */
function plain(value: unknown, json: boolean): PyPlain {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  )
    return value;
  if (typeof value === "number") return json && Number.isSafeInteger(value) ? BigInt(value) : value;
  if (value instanceof Map)
    return new Map([...value].map(([k, v]) => [String(k), plain(v, false)]));
  if (Array.isArray(value)) return value.map((v) => plain(v, json));
  if (
    value !== null &&
    typeof value === "object" &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  )
    return new Map(Object.entries(value).map(([k, v]) => [k, plain(v, json)]));
  throw new AlertValidationError([["params", "unsupported parameter value"]]);
}
function display(value: unknown): string {
  return pyStr(plain(value, true));
}
export function parseAlertKind(kind: unknown): AlertKind {
  if (typeof kind !== "string" || !pyStrip(kind))
    throw new AlertValidationError([["kind", `kind is required; known: ${KINDS.join(", ")}`]]);
  const name = pyStrip(kind);
  const found = KINDS.find((k) => k === name);
  if (found === undefined)
    throw new AlertValidationError([
      [
        "kind",
        `Unknown alert kind "${name}"${didYouMean(name, KINDS)}; known: ${KINDS.join(", ")}`,
      ],
    ]);
  return found;
}
function chooseScope(
  kind: AlertKind,
  raw: unknown,
  hasInstrument: boolean,
  hasBucket: boolean,
  issues: AlertIssue[],
): AlertScope {
  const info = CATALOG.get(kind);
  if (info === undefined) throw new Error("missing catalog kind");
  const first = info.scopes[0];
  if (first === undefined) throw new Error("catalog kind has no scope");
  const allowed = info.scopes.join(", ");
  let chosen: AlertScope;
  if (raw == null || raw === "")
    chosen = hasInstrument
      ? AlertScope.INSTRUMENT
      : hasBucket
        ? AlertScope.BUCKET
        : info.scopes.includes(AlertScope.PORTFOLIO)
          ? AlertScope.PORTFOLIO
          : first;
  else {
    const known = Object.values(AlertScope).find((s) => s === raw);
    if (known === undefined) {
      issues.push([
        "scope",
        `Unknown scope "${display(raw)}"${didYouMean(display(raw), Object.values(AlertScope))}; allowed: ${allowed}`,
      ]);
      return first;
    }
    chosen = known;
  }
  if (!info.scopes.includes(chosen)) {
    issues.push(["scope", `${kind} alerts apply to scope ${allowed}, not ${chosen}`]);
    return chosen;
  }
  if (chosen === "instrument" && !hasInstrument)
    issues.push([
      "instrument",
      `${kind} alerts need an instrument${PRICE_KINDS.includes(kind) ? " (add it to the watchlist first if it is not held)" : ""}`,
    ]);
  if (chosen !== "instrument" && hasInstrument)
    issues.push(["instrument", `scope ${chosen} takes no instrument`]);
  if (chosen === "bucket" && !hasBucket)
    issues.push(["params.bucket", "scope bucket needs params.bucket (a strategy bucket id)"]);
  if (chosen !== "bucket" && hasBucket)
    issues.push(["params.bucket", "bucket only applies to scope bucket"]);
  return chosen;
}
function choice(
  reader: ParamReader,
  key: string,
  allowed: readonly string[],
  fallback: string | null,
): string {
  const value = reader.optionalString(key);
  if (value === null) {
    if (fallback === null && !reader.has(key))
      reader.errors.error(key, `${key} is required: ${allowed.join(" or ")}`);
    return fallback ?? allowed[0] ?? "";
  }
  const clean = pyStrip(value).toLowerCase();
  if (!allowed.includes(clean)) {
    reader.errors.error(
      key,
      `Unknown ${key} "${clean}"${didYouMean(clean, allowed)}; allowed: ${allowed.join(", ")}`,
    );
    return fallback ?? allowed[0] ?? "";
  }
  return clean;
}
export function validateAlert(
  kind: unknown,
  params: unknown,
  options: { readonly scope?: unknown; readonly hasInstrument: boolean },
): ValidatedAlert {
  const alertKind = parseAlertKind(kind);
  const converted = plain(params ?? {}, !(params instanceof Map));
  if (!(converted instanceof Map))
    throw new AlertValidationError([["params", "params must be an object"]]);
  const issues: AlertIssue[] = [],
    errors = new ParamErrors();
  const reader = new ParamReader(converted as PyPlainMap, errors);
  const hasBucket = reader.has("bucket");
  const scope = chooseScope(alertKind, options.scope, options.hasInstrument, hasBucket, issues);
  const out: Record<string, unknown> = {},
    refs: string[] = [];
  switch (alertKind) {
    case "price_above":
    case "price_below":
      out.level = reader.number("level", { minimum: 0, exclusiveMin: true });
      break;
    case "change_pct":
      out.window_days = reader.integer("window_days", { minimum: 1, maximum: MAX_WINDOW_DAYS });
      out.threshold = reader.number("threshold", {
        minimum: 0,
        maximum: MAX_CHANGE_THRESHOLD,
        exclusiveMin: true,
      });
      out.direction = choice(reader, "direction", ["up", "down", "any"], "any");
      break;
    case "drawdown_from_high":
      out.window_days = reader.integer("window_days", {
        fallback: 252,
        minimum: 2,
        maximum: MAX_WINDOW_DAYS,
      });
      out.threshold = reader.number("threshold", {
        minimum: 0,
        maximum: 1,
        exclusiveMin: true,
        exclusiveMax: true,
      });
      break;
    case "new_high":
      out.window_days = reader.integer("window_days", {
        fallback: 252,
        minimum: 2,
        maximum: MAX_WINDOW_DAYS,
      });
      break;
    case "sma_cross":
      out.window_days = reader.integer("window_days", {
        fallback: 200,
        minimum: 2,
        maximum: MAX_WINDOW_DAYS,
      });
      out.direction = choice(reader, "direction", ["above", "below"], null);
      break;
    case "weight_above":
    case "weight_below":
      out.threshold = reader.number("threshold", { minimum: 0, maximum: 1, exclusiveMin: true });
      break;
    case "range_breakout":
      out.window_days = reader.integer("window_days", {
        fallback: BREAKOUT_WINDOW[2],
        minimum: BREAKOUT_WINDOW[0],
        maximum: BREAKOUT_WINDOW[1],
      });
      out.max_range_pct = reader.number("max_range_pct", {
        fallback: BREAKOUT_RANGE[2],
        minimum: BREAKOUT_RANGE[0],
        maximum: BREAKOUT_RANGE[1],
      });
      out.direction = choice(reader, "direction", ["up", "down", "any"], "any");
      break;
    case "volume_spike":
      out.window_days = reader.integer("window_days", {
        fallback: VOLUME_WINDOW[2],
        minimum: VOLUME_WINDOW[0],
        maximum: VOLUME_WINDOW[1],
      });
      out.multiple = reader.number("multiple", {
        fallback: VOLUME_MULTIPLE[2],
        minimum: VOLUME_MULTIPLE[0],
        maximum: VOLUME_MULTIPLE[1],
      });
      break;
    case "custom": {
      const expression = reader.optionalString("expression");
      if (expression === null || !pyStrip(expression)) {
        if (!errors.hasErrors)
          errors.error("expression", 'expression is required: e.g. "weight > 10%"');
      } else if (pyLen(expression) > MAX_EXPRESSION_LENGTH)
        errors.error(
          "expression",
          `expression is too long (max ${MAX_EXPRESSION_LENGTH} characters)`,
        );
      else
        try {
          const compiled = expr.compileExpression(expression, scope);
          out.expression = expr.normalized(compiled);
          refs.push(...expr.bucketReferences(compiled).map(([id]) => id));
        } catch (error) {
          if (!(error instanceof expr.ExpressionError)) throw error;
          errors.error("expression", `${error.message} (column ${error.column} of the expression)`);
        }
    }
  }
  if (hasBucket) {
    const bucket = reader.optionalString("bucket");
    if (bucket !== null && pyStrip(bucket)) {
      out.bucket = pyStrip(bucket);
      refs.unshift(pyStrip(bucket));
    } else if (bucket !== null) errors.error("bucket", "bucket must not be empty");
  }
  reader.finish();
  for (const issue of errors.issues)
    issues.push([
      issue.key ? `params.${issue.key}` : "params",
      issue.message.replace("; it is ignored", ""),
    ]);
  if (issues.length) throw new AlertValidationError(issues);
  return { kind: alertKind, scope, params: out, bucketRefs: [...new Set(refs)] };
}
export function validateText(
  title: unknown,
  note: unknown,
  issues?: AlertIssue[],
): readonly [string, string | null] {
  const found = issues ?? [],
    cleanTitle = typeof title === "string" ? pyStrip(title) : "";
  if (!cleanTitle) found.push(["title", 'title is required (a short name, e.g. "VWCE below 100")']);
  else if (pyLen(cleanTitle) > MAX_TITLE_LENGTH || cleanTitle.includes("\n"))
    found.push(["title", `title must be one line of at most ${MAX_TITLE_LENGTH} characters`]);
  let cleanNote: string | null = null;
  if (note != null) {
    if (typeof note !== "string") found.push(["note", "note must be text"]);
    else if (pyLen(note) > MAX_NOTE_LENGTH)
      found.push(["note", `note is too long (max ${MAX_NOTE_LENGTH} characters)`]);
    else cleanNote = pyStrip(note) || null;
  }
  if (issues === undefined && found.length) throw new AlertValidationError(found);
  return [cleanTitle, cleanNote];
}
export function validateTag(tag: unknown, issues?: AlertIssue[]): string | null {
  const found = issues ?? [];
  let clean: string | null = null;
  if (tag != null) {
    if (typeof tag !== "string") found.push(["tag", "tag must be text"]);
    else {
      clean = pySplit(tag).join(" ").toLowerCase() || null;
      if (clean !== null && pyLen(clean) > MAX_TAG_LENGTH) {
        found.push(["tag", `tag must be at most ${MAX_TAG_LENGTH} characters`]);
        clean = null;
      } else if (clean !== null && !/^[\p{L}0-9 -]+$/u.test(clean)) {
        found.push(["tag", 'tag may hold only letters, digits, spaces and hyphens (e.g. "cena")']);
        clean = null;
      }
    }
  }
  if (issues === undefined && found.length) throw new AlertValidationError(found);
  return clean;
}
