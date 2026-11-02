/** The legacy wire boundary: native Decimal DTOs and canonical refs to Python API JSON. */
import { Decimal, investments as inv } from "@cashu/domain";
import type { PythonDb } from "../../sources/pythonDb.ts";
import { type OutValue, pyFloat } from "../output.ts";
import type { VaultRun } from "../store/genesisRun.ts";
import { GidKeys } from "../store/gidKeys.ts";
import { canonicalSignalValue } from "./signals.ts";

export interface ViewWireOptions {
  /** Explicit selectors from the pure projector contract; '*' is one dictionary/list component. */
  readonly floatPaths: readonly (string | readonly string[])[];
  readonly bareIdTable?: string;
  /** Owner-authored identifiers are text even when they happen to equal a canonical entity gid. */
  readonly literalIdPaths?: readonly (string | readonly string[])[];
  /** Only declared reference-keyed maps rewrite their keys; other dictionary keys are authored. */
  readonly keyedRefPaths?: readonly (string | readonly string[])[];
}

const matches = (path: readonly string[], pattern: string | readonly string[]): boolean => {
  const components = typeof pattern === "string" ? pattern.split(".") : pattern;
  return (
    path.length === components.length &&
    path.every((part, i) => components[i] === "*" || components[i] === part)
  );
};
const isId = (field: string) => field === "id" || field.endsWith("_id") || field.endsWith("_ids");
// Actual event v1 identities: keyed UUIDv8 or ULID. A 32-hex strategy rule name is ordinary text.
const GID =
  "[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[0-9A-HJKMNP-TV-Z]{26}";
const ALERT_KEY = new RegExp(`^alert:(${GID})$`);
const KEY_PART = new RegExp(`^(i|a):(${GID})$`);

/** Never rewrite arbitrary user-authored text: embedded refs exist only in these key fields. */
function sourceKey(value: string, field: string, keys: GidKeys): string {
  const part = (table: string, gid: string): string => {
    const source = keys.source(gid);
    if (source === undefined || source.table !== table)
      throw new Error("view embedded reference has no copied-source identity");
    return source.localId;
  };
  const alert = ALERT_KEY.exec(value);
  if (alert !== null) return `alert:${part("alerts", alert[1] as string)}`;
  if (field === "rule_id") return value;
  return value
    .split("|")
    .map((component) => {
      const match = KEY_PART.exec(component);
      return match === null
        ? component
        : `${match[1]}:${part(match[1] === "i" ? "inv_instruments" : "accounts", match[2] as string)}`;
    })
    .join("|");
}

export function viewOutput(
  value: unknown,
  db: Pick<PythonDb, "keys">,
  vault: Pick<VaultRun, "det" | "sources">,
  options: ViewWireOptions,
): OutValue {
  const keys = new GidKeys(vault, db.keys);
  const visit = (
    item: unknown,
    path: readonly string[],
    field: string,
    parent: string,
  ): OutValue => {
    if (item === null) return null;
    if (Array.isArray(item))
      return item.map((entry, i) => visit(entry, [...path, String(i)], field, parent));
    if (item instanceof Decimal)
      return options.floatPaths.some((pattern) => matches(path, pattern))
        ? pyFloat(item.toFloat())
        : item.toString();
    if (item instanceof inv.plan.Freshness) {
      return visit(
        {
          state: item.state,
          reasons: item.reasons.map((reason) => ({
            code: reason.code,
            at: reason.at === null ? null : inv.research.formatInstant(reason.at),
            ...(reason.noteId === undefined ? {} : { note_id: reason.noteId }),
            ...(reason.signalId === undefined ? {} : { signal_id: reason.signalId }),
            ...(reason.alertId === undefined ? {} : { alert_id: reason.alertId }),
            ...(reason.kind === undefined ? {} : { kind: reason.kind }),
            ...(reason.relation === undefined ? {} : { relation: reason.relation }),
            ...(reason.count === undefined ? {} : { count: reason.count }),
          })),
        },
        path,
        field,
        parent,
      );
    }
    if (typeof item === "string") {
      if (options.literalIdPaths?.some((pattern) => matches(path, pattern))) return item;
      if (field === "rule_id" || field === "dedup_key") return sourceKey(item, field, keys);
      if (isId(field)) {
        const source = keys.source(item);
        if (source !== undefined) {
          const guarded = new Proxy(db.keys, {
            get(target, key, receiver) {
              if (key !== "key") return Reflect.get(target, key, receiver);
              return (table: string, id: number | bigint) => {
                if (table !== source.table)
                  throw new Error(
                    `native view reference table differs from canonical field contract: ${field}`,
                  );
                return target.key(table, id);
              };
            },
          });
          return canonicalSignalValue(
            BigInt(source.localId),
            { keys: guarded },
            field,
            parent,
            options.bareIdTable,
          );
        }
        // Source YAML may legitimately retain old integer identities; Canon owns their mapping.
        return canonicalSignalValue(item, db, field, parent, options.bareIdTable);
      }
      return item;
    }
    if (typeof item === "bigint") {
      if (isId(field)) return canonicalSignalValue(item, db, field, parent, options.bareIdTable);
      return item;
    }
    if (typeof item === "number") {
      if (isId(field))
        return canonicalSignalValue(BigInt(item), db, field, parent, options.bareIdTable);
      // Counts stay integral. A float equal to 1 requires an explicit schema/source-lexical selector.
      return !Number.isSafeInteger(item) ||
        options.floatPaths.some((pattern) => matches(path, pattern))
        ? pyFloat(item)
        : BigInt(item);
    }
    if (typeof item === "boolean") return item;
    if (typeof item === "object") {
      if (item instanceof Set)
        return [...item].map((entry, i) => visit(entry, [...path, String(i)], field, parent));
      const entries = item instanceof Map ? [...item] : Object.entries(item);
      return Object.fromEntries(
        entries.map(([key, entry]) => {
          if (typeof key !== "string") throw new Error("native view dictionary key is not text");
          const outputKey = options.keyedRefPaths?.some((pattern) => matches(path, pattern))
            ? (keys.keyOf(key) ?? key)
            : key;
          return [outputKey, visit(entry, [...path, key], key, field)];
        }),
      );
    }
    throw new Error("unsupported native view output shape");
  };
  return visit(value, [], "", "");
}

export const REVIEW_DIGEST_FLOAT_PATHS: readonly string[] = [
  ...[
    "then",
    "now",
    "change",
    "change_pct",
    "contributions",
    "transfers",
    "implied_funding",
    "market_change",
    "market_change_pct",
  ].map((field) => `value.${field}`),
  "decisions.*.quantity",
  "decisions.*.price",
  "dividends.*",
  "price_moves.*.from",
  "price_moves.*.to",
  "price_moves.*.change_pct",
  ...["new", "escalated", "resolved"].flatMap((status) =>
    ["quantity", "price"].map((field) => `signals.${status}.*.decisions.*.${field}`),
  ),
  "events.*.quantity",
  "events.*.price",
  "events.*.cash_amount",
  "events.*.amount",
  ...["research.segments.*", "research.market.unassigned"].flatMap((prefix) =>
    ["weight", "contribution", "return"].flatMap((field) => [
      `${prefix}.${field}`,
      `${prefix}.instruments.*.${field}`,
    ]),
  ),
  "research.segments.*.trend_1w",
  "research.segments.*.trend_4w",
  "research.segments.*.member_instruments.*.return_1w",
  "research.segments.*.member_instruments.*.return_4w",
  "research.market.portfolio_return",
  "research.market.explained",
  "research.market.residual",
  "research.market.currency.contribution",
  "research.market.currency.currencies.*.weight",
  "research.market.currency.currencies.*.return",
  "research.market.currency.currencies.*.contribution",
];
export const STRATEGY_STATUS_FLOAT_PATHS: readonly string[] = [
  "facts.targets.*",
  "facts.horizon_years",
  "facts.contributions.monthly_amount",
];
export const STRATEGY_STATUS_LITERAL_IDS: readonly string[] = [
  "facts.rules.*.id",
  "facts.bucket_matches.*.id",
  "inactive_rules.*.rule_id",
];
