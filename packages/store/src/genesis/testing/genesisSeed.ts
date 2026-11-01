// Rows of the synthetic two-profile Python data dir (genesisData.ts): one row (or a few, for the
// lifecycle states) in every table genesis reads. Synthetic only: the IBAN is the textbook example
// number, every name and amount is made up.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { PythonRows } from "./pythonRows.js";

const utf8 = new TextEncoder();
const T0 = "2026-01-02 03:04:05.000000";
const T1 = "2026-02-03 04:05:06.123456";
const T2 = "2026-03-04 05:06:07.000000";
const LATER = "2027-01-01 00:00:00.000000";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
export const ARCHIVE = utf8.encode("data;1\n");
export const ARCHIVE_SHA = bytesToHex(sha256(ARCHIVE));
export const STAGED = utf8.encode("staged;1\n");
export const STAGED_SHA = bytesToHex(sha256(STAGED));
export const STRATEGY_YAML = "version: 2\n";

function seedCore(r: PythonRows): void {
  r.insert("profiles", { slug: "anna", name: "Anna Syntetyczna" });
  r.insert("profiles", { slug: "piotr", name: "Piotr Syntetyczny", created_at: T1 });
  r.insert("profile_modules", { module_id: "budget" });
  r.insert("profile_modules", { module_id: "investments" });
  r.insert("profile_modules", { module_id: "loans", enabled: 0 });
  r.insert("profile_modules", { profile_id: 2, module_id: "budget" });
  r.insert("accounts", { iban: "PL61109010140000071219812874", external_id: "csv:PL61" }); // 1
  r.insert("accounts", { bank: "cash", external_id: "cash:PLN", type: "cash" }); // 2
  r.insert("accounts", {
    bank: "xtb",
    external_id: `brokerage:${"0".repeat(31)}1`,
    type: "brokerage",
  }); // 3
  r.insert("accounts", { external_id: "manual:stare~4", type: "savings", removed_at: T1 }); // 4
  r.insert("accounts", { external_id: "manual:kredyt", type: "loan" }); // 5
  r.insert("accounts", { bank: "manual", external_id: "vehicle:auto", type: "vehicle" }); // 6
  r.insert("accounts", { profile_id: 2, bank: "pekao", external_id: "eb:UID2" }); // 7
  r.insert("balances", { account_id: 1, source: "CSV", amount: "1500.50" });
  r.insert("balances", { account_id: 7, source: "OPEN_BANKING", amount: "10" });
}

function seedBudget(r: PythonRows): void {
  r.insert("import_batches", { account_id: 1, bank: "mbank", filename: "wyciag.csv" });
  const bank = { account_id: 1, import_batch_id: 1, counterparty_name: "Sklep" };
  r.insert("transactions", {
    ...bank,
    amount: "-12.50",
    dedup_hash: "1".repeat(40),
    description: "zakupy",
    category: "jedzenie",
    category_source: "manual_txn",
    raw: '{"entry": "x1"}',
  });
  r.insert("transactions", {
    ...bank,
    amount: "-5",
    dedup_hash: "2".repeat(40),
    category: "inne",
    category_source: "rule",
  });
  r.insert("transactions", {
    ...bank,
    amount: "-100.00",
    dedup_hash: "3".repeat(40),
    description: "bankomat",
    category: "cash_withdrawal",
    category_source: "manual_txn",
  });
  r.insert("transactions", {
    account_id: 2,
    amount: "100.00",
    dedup_hash: "cashleg:3",
    raw: '{"cash_leg_of": 3}',
    category: "gotowka",
    category_source: "manual_txn",
    source: "MANUAL",
  });
  r.insert("transactions", {
    account_id: 2,
    amount: "-20.00",
    dedup_hash: "cashexp:00000000-0000-4000-8000-000000000001",
    description: "Obiad",
    category: "jedzenie",
    category_source: "manual_txn",
    source: "MANUAL",
  });
  r.insert("transactions", { account_id: 7, amount: "-1.00", description: "kawa" });
  r.insert("category_rules", { merchant_key: "SKLEP", locked: 1 });
  r.insert("category_rules", { profile_id: 2, merchant_key: "KAWIARNIA", source: "llm" });
  r.insert("loans", { account_id: 5, payment_text: "RATA KREDYTU" });
  r.insert("depreciations", { account_id: 6 });
  r.insert("asset_details", { account_id: 6, note: "Auto testowe" });
}

function seedInvestments(r: PythonRows, schema: "0025" | "0026" | "0029"): void {
  r.insert("inv_instruments", { name: "Test SA", asset_class: "equity", symbol: "TST" }); // 1
  r.insert("inv_instruments", { name: "ABC Inc", asset_class: "equity", currency: "USD" }); // 2
  r.insert("inv_instruments", { name: "Obligacja", asset_class: "bond" }); // 3
  r.insert("inv_instruments", { name: "Sierota", asset_class: "etf" }); // 4: orphan
  r.insert("inv_instrument_aliases", { instrument_id: 1, namespace: "xtb", value: "TST.PL" });
  r.insert("inv_instrument_aliases", {
    instrument_id: 1,
    namespace: "isin",
    value: "PLTST0000011",
  });
  r.insert("inv_instrument_aliases", { instrument_id: 2, namespace: "xtb", value: "ABC.US" });
  r.insert("inv_account_settings", { account_id: 3, wrapper: "ike", importer: "xtb" });
  r.insert("inv_import_batches", {
    account_id: 3,
    importer: "xtb",
    broker: "xtb",
    file_sha256: ARCHIVE_SHA,
    archive_path: `imports/anna/${ARCHIVE_SHA}.CSV`,
    warnings: '[{"row": 3, "kind": "other"}]',
  });
  const txn = { account_id: 3, import_batch_id: 1, currency: "PLN", cash_currency: "PLN" };
  r.insert("inv_transactions", {
    ...txn,
    type: "deposit",
    gross_amount: "1000",
    cash_amount: "1000",
    dedup_hash: "1".repeat(64),
  });
  r.insert("inv_transactions", {
    ...txn,
    instrument_id: 1,
    quantity: "10",
    price: "12.5",
    gross_amount: "125",
    cash_amount: "-125",
    external_ref: " X1 ",
    dedup_hash: "2".repeat(64),
  });
  r.insert("inv_transactions", {
    ...txn,
    import_batch_id: null,
    source: "manual",
    instrument_id: 2,
    dedup_hash: "3".repeat(64),
  });
  r.insert("inv_position_snapshots", { account_id: 3, instrument_id: 1, quantity: "10" });
  r.insert("inv_instrument_renames", { old_instrument_id: 2, new_instrument_id: 1 });
  r.insert("inv_manual_valuations", { instrument_id: 3, unit_value: "101.5" });
  r.insert("inv_profile_instruments", {
    instrument_id: 1,
    tags: '["dywidenda"]',
    plan: "buy",
    plan_at: T1,
    plan_reason: "Tanio",
    segment: "ai",
    segment_by: "owner",
  });
  r.insert("inv_strategy_versions", { version: 1, sha256: SHA_A, yaml_text: "version: 1\n" });
  r.insert("inv_strategy_versions", { version: 2, sha256: SHA_B, yaml_text: STRATEGY_YAML });
  const exitPlan = { exit_plan: "Sprzedaj przy 20", updated_at: T1 };
  r.insert("inv_theses", {
    instrument_id: 1,
    ...exitPlan,
    core_changed_at: T0,
    ...(schema === "0025" ? {} : { exit_plan_changed_at: T1 }),
  });
  r.insert("inv_topic_theses", { segment: "ai" });
  r.insert("inv_topic_theses", {
    segment: "gold",
    created_by: "agent",
    assessment: "Mocny",
    view_updated_at: T1,
    view_sources: '[{"title": "Raport", "url": "https://example.org/r"}]',
  });
  r.insert("inv_topic_theses", {
    segment: "energy",
    draft: 1,
    created_by: "agent",
    rejected_at: T1,
  });
  r.insert("watchlist_items", { instrument_id: 2, note: "Obserwuj", source: "user" });
  r.insert("watchlist_items", { instrument_id: 1, source: "agent", removed_at: T1 });
  r.insert("watchlist_items", { profile_id: 2, instrument_id: 1, source: "user" });
}

function seedSignals(r: PythonRows): void {
  const alert = { scope: "instrument", polarity: "negative", source: "user", created_by: "app" };
  r.insert("alerts", {
    ...alert,
    instrument_id: 1,
    status: "muted",
    last_checked_at: T1,
    last_value: "9.5",
  });
  r.insert("alerts", { ...alert, scope: "portfolio", status: "snoozed", snoozed_until: LATER });
  r.insert("alerts", { ...alert, status: "triggered", last_triggered_at: T1, deleted_at: T2 });
  r.insert("alerts", { ...alert, status: "expired", expires_at: T1 });
  r.insert("inv_rule_runs", {
    trigger: "worker",
    strategy_version_id: 2,
    report: '{"new": [1], "escalated": []}',
  });
  r.insert("inv_rule_runs", { trigger: "cli", started_at: T1 });
  const signal = { kind: "drawdown", rule_id: "drawdown" };
  r.insert("inv_signals", {
    ...signal,
    dedup_key: "drawdown|i:1",
    instrument_id: 1,
    created_run_id: 1,
    last_run_id: 2,
    payload: '{"instrument_id": 1, "accounts": [3]}',
  });
  r.insert("inv_signals", {
    kind: "alert:price_below",
    rule_id: "alert:1",
    dedup_key: "alert:1",
    status: "resolved",
    closed_at: T1,
  });
  r.insert("inv_signals", {
    ...signal,
    dedup_key: "drawdown|i:2",
    status: "acknowledged",
    acknowledged_at: T1,
  });
  r.insert("inv_signals", {
    ...signal,
    dedup_key: "drawdown|i:3",
    snoozed_until: LATER,
    created_run_id: 1,
    last_run_id: 1,
  });
  r.insert("inv_decisions", { signal_id: 3, action: "held", instrument_id: 2 });
  r.insert("inv_decision_signals", { decision_id: 1, signal_id: 3 });
  r.insert("inv_decision_signals", { decision_id: 1, signal_id: 1 });
  r.insert("inv_notification_log", { signal_id: 1, sent_at: T1, channel: "macos" });
  r.insert("inv_planned_deposits", {
    account_id: 3,
    amount: "500",
    status: "booked",
    booked_txn_id: 1,
    booked_at: T1,
  });
  r.insert("inv_planned_deposits", { amount: "200", status: "cancelled", updated_at: T1 });
  r.insert("inv_planned_deposits", { amount: "300" });
}

function seedAgent(r: PythonRows): void {
  r.insert("research_runs", {
    scope: '{"instrument_ids": [1, 2]}',
    counts: '{"notes": 2}',
    finished_at: T1,
  });
  r.insert("research_runs", { status: "running" });
  r.insert("research_notes", {
    run_id: 1,
    instrument_id: 1,
    details: '{"watchlist_item_id": 1, "thesis_id": 1}',
    signal_id: 1,
    read_at: T1,
    dismissed_at: T1,
    cooldown_until: LATER,
    expires_at: LATER,
  });
  r.insert("research_notes", { created_by: "user", read_at: T0, expires_at: LATER });
  r.insert("reviews", { stats: '{"signals": 4}' });
  r.insert("proposals", {});
  r.insert("proposals", {
    kind: "import",
    status: "approved",
    payload: JSON.stringify({
      account_id: 3,
      staged: `imports/anna/.proposals/${STAGED_SHA}-0123456789ab.csv`,
    }),
    reviewed_at: T1,
  });
  r.insert("connector_bindings", {
    account_id: 3,
    cursor: "c1",
    last_run_at: T1,
    last_status: "ok",
  });
}

/** Every table of both profiles (`schema` decides whether theses carry `exit_plan_changed_at`). */
export function seedAll(r: PythonRows, schema: "0025" | "0026" | "0029"): void {
  seedCore(r);
  seedBudget(r);
  seedInvestments(r, schema);
  seedSignals(r);
  seedAgent(r);
}
