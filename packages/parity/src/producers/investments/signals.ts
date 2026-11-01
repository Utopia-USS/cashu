/** Native stored-view serialization. No Python result, outcome or golden input is read. */
import {
  investments as inv,
  parseDateTime,
  pyIsDigit,
  toStorage,
  unicodeDecimal,
  utcIso,
} from "@cashu/domain";
import { withBucketGeneric } from "@cashu/domain/investments/rules";
import { DATASET_CLOCKS } from "../../sources/datasets.ts";
import type { InvSignalDecisionRow, InvSignalRow } from "../../sources/investments.ts";
import type { PythonDb } from "../../sources/pythonDb.ts";
import { type OutValue, pyFloat } from "../output.ts";

// canon.py mappings, kept in the legacy-data adapter only. Unknown numeric id fields fail closed.
const FIELDS: Readonly<Record<string, string>> = {
  profile_id: "profiles",
  account_id: "accounts",
  account_ids: "accounts",
  instrument_id: "inv_instruments",
  instrument_ids: "inv_instruments",
  old_instrument_id: "inv_instruments",
  new_instrument_id: "inv_instruments",
  signal_id: "inv_signals",
  signal_ids: "inv_signals",
  alert_id: "alerts",
  alert_ids: "alerts",
  thesis_id: "inv_theses",
  topic_thesis_id: "inv_topic_theses",
  note_id: "research_notes",
  note_ids: "research_notes",
  decision_id: "inv_decisions",
  decision_ids: "inv_decisions",
  loan_id: "loans",
  version_id: "inv_strategy_versions",
  strategy_version_id: "inv_strategy_versions",
  proposal_id: "proposals",
  deposit_id: "inv_planned_deposits",
  review_id: "reviews",
  valuation_id: "inv_manual_valuations",
  created_run_id: "inv_rule_runs",
  last_run_id: "inv_rule_runs",
  rule_run_id: "inv_rule_runs",
  research_run_id: "research_runs",
  new_signal_ids: "inv_signals",
  open_txn_id: "inv_transactions",
  close_txn_id: "inv_transactions",
  batch_id: "inv_import_batches",
  import_batch_id: "inv_import_batches",
  item_id: "watchlist_items",
  run_id: "research_runs",
  running_run_id: "research_runs",
  watchlist_item_id: "watchlist_items",
  watch_item_id: "watchlist_items",
};
const PARENTS: Readonly<Record<string, string>> = {
  instrument: "inv_instruments",
  instruments: "inv_instruments",
  account: "accounts",
  accounts: "accounts",
  signal: "inv_signals",
  signals: "inv_signals",
  alert: "alerts",
  alerts: "alerts",
  thesis: "inv_theses",
  theses: "inv_theses",
  topic_theses: "inv_topic_theses",
  decision: "inv_decisions",
  decisions: "inv_decisions",
  note: "research_notes",
  notes: "research_notes",
  last_run: "inv_rule_runs",
  runs: "inv_rule_runs",
  loan: "loans",
  loans: "loans",
  versions: "inv_strategy_versions",
  manual_valuations: "inv_manual_valuations",
  planned_deposits: "inv_planned_deposits",
  watchlist: "watchlist_items",
  proposals: "proposals",
  reviews: "reviews",
  last_review: "reviews",
  imports: "inv_import_batches",
  batches: "inv_import_batches",
  transactions: "inv_transactions",
};

function tableFor(field: string, parent: string, bareIdTable: string): string | undefined {
  if (field === "id") return PARENTS[parent] ?? bareIdTable;
  if (FIELDS[field]) return FIELDS[field];
  for (const suffix of ["instrument_id", "signal_id", "account_id", "alert_id", "note_id"]) {
    if (field.endsWith(`_${suffix}`) || field.endsWith(`_${suffix}s`)) return FIELDS[suffix];
  }
  return undefined;
}

function rowId(value: unknown): number | null {
  if (typeof value === "bigint") {
    const id = Number(value);
    if (!Number.isSafeInteger(id)) throw new Error("unsafe stored signal reference");
    return id;
  }
  if (typeof value !== "string" || value === "" || value.startsWith("0")) return null;
  const digits = Array.from(value, (c) => unicodeDecimal(c.codePointAt(0) ?? 0));
  if (digits.some((d) => d < 0)) {
    if (Array.from(value).every((c) => pyIsDigit(c.codePointAt(0) ?? 0)))
      throw new Error("invalid digit-only stored signal reference");
    return null;
  }
  const id = Number(digits.join(""));
  if (!Number.isSafeInteger(id)) throw new Error("unsafe stored signal reference");
  return id;
}

/** canon.py value/_id_value, with this check's bare-id override (inv_signals). */
export function canonicalSignalValue(
  value: unknown,
  db: Pick<PythonDb, "keys">,
  field = "",
  parent = "",
  bareIdTable = "inv_signals",
): OutValue {
  if (Array.isArray(value))
    return value.map((v) => canonicalSignalValue(v, db, field, parent, bareIdTable));
  if (field === "id" || field.endsWith("_id") || field.endsWith("_ids")) {
    const id = rowId(value);
    if (id !== null) {
      const table = tableFor(field, parent, bareIdTable);
      if (table === undefined) throw new Error(`unmapped stored signal reference: ${field}`);
      return db.keys.key(table, id);
    }
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  )
    return value;
  if (typeof value === "number") return pyFloat(value);
  if (typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [
        key,
        canonicalSignalValue(v, db, key, field, bareIdTable),
      ]),
    );
  throw new Error("unsupported stored signal value");
}

const id = (value: number | null): bigint | null => (value === null ? null : BigInt(value));
const at = (value: string | null): string | null => (value === null ? null : utcIso(value));

/** Derive UTC from the harness's fixed Warsaw local instant, independent of machine timezone. */
export function signalClock(db: Pick<PythonDb, "dataset">): string {
  const local = DATASET_CLOCKS[db.dataset];
  const probe = new Date(`${local}Z`);
  const zone = new Intl.DateTimeFormat("en", {
    timeZone: "Europe/Warsaw",
    timeZoneName: "longOffset",
  })
    .formatToParts(probe)
    .find((p) => p.type === "timeZoneName")?.value;
  const match = /^GMT([+-])(\d\d):(\d\d)$/.exec(zone ?? "");
  if (match === null) throw new Error("frozen Warsaw offset unavailable");
  const offset = (Number(match[2]) * 60 + Number(match[3])) * (match[1] === "+" ? 1 : -1);
  return new Date(probe.getTime() - offset * 60_000).toISOString();
}

function decision(d: InvSignalDecisionRow, links: readonly number[]): Record<string, unknown> {
  return {
    id: id(d.id),
    signal_id: id(d.signalId),
    signal_ids: links.map(id),
    instrument_id: id(d.instrumentId),
    account_id: id(d.accountId),
    action: d.action,
    quantity: d.quantity === null ? null : Number(d.quantity),
    price: d.price === null ? null : Number(d.price),
    currency: d.currency,
    reason: d.reason,
    created_at: at(d.createdAt),
  };
}

function alertId(rule: string): bigint | null {
  if (!rule.startsWith("alert:")) return null;
  const tail = rule.slice(6);
  if (!tail) return null;
  const digits = Array.from(tail, (c) => unicodeDecimal(c.codePointAt(0) ?? 0));
  return digits.some((d) => d < 0) ? null : BigInt(digits.join(""));
}

export function produceSignals(db: PythonDb): OutValue {
  const out: Record<string, OutValue> = {};
  const now = toStorage(parseDateTime(signalClock(db)));
  for (const profile of db.profiles()) {
    if (!db.enabledModules(profile.id).includes("investments")) continue;
    const rows = db.investments.signals(profile.id);
    const decisions = db.investments.signalDecisions(profile.id);
    const linked = db.investments.decisionSignalLinks(profile.id);
    const links = new Map<number, number[]>();
    const covering = new Map<number, InvSignalDecisionRow[]>();
    for (const d of decisions) {
      const ids = new Set(linked.filter((l) => l.decisionId === d.id).map((l) => l.signalId));
      if (d.signalId !== null) ids.delete(d.signalId);
      const all = [...(d.signalId === null ? [] : [d.signalId]), ...[...ids].sort((a, b) => a - b)];
      links.set(d.id, all);
      for (const sid of all) covering.set(sid, [...(covering.get(sid) ?? []), d]);
    }
    const good =
      db.investments
        .signalRuleRuns(profile.id)
        .find((r) => r.status === "ok" || r.status === "partial")?.id ?? null;
    const instrumentIds = [
      ...new Set(rows.flatMap((r) => (r.instrumentId ? [r.instrumentId] : []))),
    ];
    const overrides = new Map(
      db.investments.profileInstruments(profile.id, instrumentIds).map((r) => [r.instrumentId, r]),
    );
    const labels = new Map(
      db.investments
        .instruments(instrumentIds)
        .map((r) => [r.id, r.symbol || overrides.get(r.id)?.name || r.name]),
    );
    const snoozed = (r: InvSignalRow) => r.snoozedUntil !== null && toStorage(r.snoozedUntil) > now;
    const serialize = (r: InvSignalRow) => {
      const label = r.instrumentId ? (labels.get(r.instrumentId) ?? null) : null;
      const [code, params] = inv.alerts.alertMessage(r.kind, r.payload, r.message, label);
      const source = r.ruleId.startsWith("alert:")
        ? "alert"
        : r.ruleId.startsWith("plan:")
          ? "plan"
          : r.ruleId.startsWith("research:")
            ? "research"
            : "rule";
      const note = r.payload?.note_id;
      return canonicalSignalValue(
        {
          id: id(r.id),
          rule_id: r.ruleId,
          kind: r.kind,
          dedup_key: r.dedupKey,
          severity: r.severity,
          polarity: r.polarity,
          source,
          alert_id: alertId(r.ruleId),
          note_id:
            source === "research" && (typeof note === "bigint" || typeof note === "boolean")
              ? note
              : null,
          status: r.status,
          message: r.message,
          message_code: code,
          message_params: params,
          instrument_id: id(r.instrumentId),
          instrument_label: label,
          account_id: id(r.accountId),
          payload: withBucketGeneric(r.kind, r.payload),
          first_seen_at: at(r.firstSeenAt),
          last_seen_at: at(r.lastSeenAt),
          acknowledged_at: at(r.acknowledgedAt),
          closed_at: at(r.closedAt),
          snoozed_until: at(r.snoozedUntil),
          snoozed: snoozed(r),
          current: good === null || r.lastRunId === null || r.lastRunId === good,
          decisions: (covering.get(r.id) ?? []).map((d) => decision(d, links.get(d.id) ?? [])),
        },
        db,
      );
    };
    const open = rows.filter((r) => r.status === "active" || r.status === "acknowledged");
    const rank = (r: InvSignalRow) => (r.severity === "action" ? 0 : r.severity === "info" ? 1 : 9);
    open.sort(
      (a, b) =>
        Number(snoozed(a)) - Number(snoozed(b)) ||
        Number(a.status !== "active") - Number(b.status !== "active") ||
        rank(a) - rank(b) ||
        b.id - a.id,
    );
    out[db.keys.key("profiles", profile.id)] = {
      open: open.map(serialize),
      history: rows.filter((r) => r.status === "resolved" || r.status === "expired").map(serialize),
      all: rows.map(serialize),
    };
  }
  return out;
}
