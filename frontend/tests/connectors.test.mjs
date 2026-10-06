// Connectors UI (design/v3/connectors): pure helpers, the unified diff parser, the budget connector radios and the
// connector labels. Run with `npm test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  backoffActive, budgetConnectorSources, changedSinceApproval, diffSummary, effectiveAccount, fileChange, importerName, INV_PROPOSAL_KINDS,
  kindLine, kindShort, lastRunText, lastSyncText, moduleSyncLines, newSecrets, parseUnifiedDiff, rowLine, secretChanges, secretsLeftText,
  secretsText, sizeText, sortConnectors, sortFiles, syncToast, viewable, acceptOf,
} from "../src/core/connectors.ts";
import { describeError, describeImportWarning, label, proposalSummary } from "../src/core/messages.ts";

test("sizeText: bytes, KiB with one decimal under 10 KiB, MiB", () => {
  assert.equal(sizeText(412), "412 B");
  assert.equal(sizeText(6963), "6,8 KiB");
  assert.equal(sizeText(26_300), "26 KiB");
  assert.equal(sizeText(1_300_000), "1,2 MiB");
});

test("viewable: text extensions and extension-less files up to 200 KiB", () => {
  assert.equal(viewable({ path: "connector.py", size: 5000 }), true);
  assert.equal(viewable({ path: "lib/run", size: 10 }), true);
  assert.equal(viewable({ path: "logo.png", size: 10 }), false);
  assert.equal(viewable({ path: "big.json", size: 300 * 1024 }), false);
  assert.deepEqual(sortFiles([{ path: "b.py" }, { path: "connector.yaml" }, { path: "a.py" }]).map((f) => f.path), ["connector.yaml", "a.py", "b.py"]);
});

test("diffSummary and fileChange", () => {
  const d = { modified: ["a.py"], added: ["b.py"], removed: [] };
  assert.equal(diffSummary(d), "1 zmieniony · 1 dodany");
  assert.equal(diffSummary({ modified: [], added: [], removed: [] }), "");
  assert.equal(diffSummary({ modified: ["a", "b"], added: [], removed: ["c", "d", "e", "f", "g"] }), "2 zmienione · 5 usuniętych");
  assert.equal(diffSummary(null), "");
  assert.equal(fileChange(d, "a.py"), "modified");
  assert.equal(fileChange(d, "b.py"), "added");
  assert.equal(fileChange(d, "c.py"), null);
});

test("sortConnectors: changed, pending, approved, disabled, then name", () => {
  const list = [
    { status: "approved", name: "Zeta" }, { status: "disabled", name: "Alfa" }, { status: "pending", name: "Beta" },
    { status: "changed", name: "Gamma" }, { status: "approved", name: "Ąbc" },
  ];
  assert.deepEqual(sortConnectors(list).map((c) => c.name), ["Gamma", "Beta", "Ąbc", "Zeta", "Alfa"]);
});

test("lastRunText and rowLine", () => {
  assert.equal(lastRunText({ last_run: null }), "jeszcze nie uruchomiony");
  const failed = { last_run: { outcome: "failed", error_kind: "timeout", started_at: "2026-10-05T12:30:00Z" } };
  assert.match(lastRunText(failed), /^ostatni przebieg \d+\.10 \d\d:\d\d · błąd \(limit czasu\)$/);
  assert.equal(rowLine({ version: "0.2.0", author: "Autor", kind: "file", bindings: 0, last_run: null }), "v0.2.0 · Autor · jeszcze nie uruchomiony");
  assert.equal(rowLine({ version: "1", author: null, kind: "fetch", bindings: 1, last_run: null }), "v1 · jeszcze nie uruchomiony · 1 powiązanie");
});

test("secretsText, lastSyncText", () => {
  assert.equal(secretsText({ secrets: [], secrets_set: [] }), "brak");
  assert.equal(secretsText({ secrets: [{ id: "a" }], secrets_set: ["a"] }), "ustawione");
  assert.equal(secretsText({ secrets: [{ id: "a" }, { id: "b" }], secrets_set: ["a"] }), "1 brakuje");
  assert.equal(lastSyncText({ last_run_at: null, last_status: null, last_ok_at: null }), "jeszcze nie synchronizowano");
  assert.match(lastSyncText({ last_run_at: "2026-10-05T07:31:00Z", last_status: "failed", last_ok_at: "2026-10-04T07:31:00Z" }),
    /^ostatnia synchronizacja .+ · błąd · ostatnia udana .+$/);
});

test("importerName: built-in label, connector name, raw id", () => {
  const builtins = [["auto", "rozpoznaj automatycznie"], ["cashu", "format cashU"]];
  assert.equal(importerName("connector:x", [{ id: "x", name: "N" }], builtins), "N");
  assert.equal(importerName("connector:x", [], builtins), "connector:x");
  assert.equal(importerName("cashu", [], builtins), "format cashU");
  assert.equal(acceptOf(["csv", "xlsx"]), ".csv,.xlsx");
});

test("syncToast: proposal, committed, nothing new, failed run", () => {
  const run = { ok: true };
  assert.equal(syncToast({ run, preview: { new: 41 }, proposal_id: 7, committed: null }, "Demo IKE"), "Import czeka na zatwierdzenie · 41 nowych rekordów");
  assert.equal(syncToast({ run, preview: { new: 41 }, proposal_id: null, committed: { inserted: 41 } }, "Demo IKE"), "Zapisano 41 nowych rekordów · Demo IKE");
  assert.equal(syncToast({ run, preview: { new: 0 }, proposal_id: null, committed: null }, "Demo IKE"), "Brak nowych rekordów");
  assert.equal(syncToast({ run: { ok: false }, preview: null, proposal_id: null, committed: null }, "x"), null);
});

test("connector labels: every BE error kind, the timeout param, short forms", () => {
  const kinds = ["bad_file", "unsupported_version", "auth_failed", "rate_limited", "network", "upstream", "internal", "protocol", "timeout",
    "sandbox_unavailable", "spawn_failed", "not_approved", "interpreter_changed", "missing", "bad_request", "changed", "disabled", "denied_host"];
  for (const k of kinds) {
    assert.ok(label(`connector.${k}`), `connector.${k}`);
    assert.notEqual(kindShort(k), k, `kindShort ${k}`);
  }
  assert.equal(kindLine("timeout", 60), "Konektor przekroczył limit czasu (60 s).");
  assert.equal(kindLine("bad_file"), "Konektor nie rozpoznał tego pliku.");
  assert.equal(kindLine("weird"), "Konektor nie zadziałał (weird).");
  assert.equal(describeError({ status: 422, code: "connector_bad_file", message: "x", body: { kind: "bad_file" } }).text, "Konektor nie rozpoznał tego pliku.");
  assert.equal(describeError({ status: 409, code: "connector.conflict", message: "x" }).text, "Konektor zmienił się, odkąd go otworzyłeś: sprawdź pliki jeszcze raz.");
});

test("proposal summaries for connector syncs", () => {
  assert.equal(proposalSummary({ kind: "budget_import", summary_code: "budget_import", summary_params: { account: "eKonto", connector: "Demo", new: 3 } }),
    "Import wyciągu do eKonto (konektor Demo): 3 nowe transakcje");
  assert.equal(proposalSummary({ kind: "import", summary_params: { account: "Demo IKE", connector: "Demo Broker API", new: 41 } }),
    "Import do Demo IKE (konektor Demo Broker API): 41 nowych wierszy");
  assert.ok(label("proposal.error.cursor_conflict"));
  assert.equal(INV_PROPOSAL_KINDS.has("budget_import"), false);
  assert.equal(INV_PROPOSAL_KINDS.has("import"), true);
});

test("budget connector radios: approved from the importer list, pending shown disabled", () => {
  const importers = [
    { id: "auto", name: "auto", kind: "auto", available: true },
    { id: "connector:kasa", name: "Demo Kasa CSV", kind: "connector", available: true },
  ];
  const connectors = [
    { id: "kasa", name: "Demo Kasa CSV", module: "budget", kind: "file", status: "approved", version: "1.0", description: "Kasa.", extensions: ["csv"], timeout_s: 30 },
    { id: "xlsx", name: "Demo Bank XLSX", module: "budget", kind: "file", status: "pending", extensions: ["xlsx"] },
    { id: "inv", name: "Inv", module: "investments", kind: "file", status: "approved" },
    { id: "api", name: "Api", module: "budget", kind: "fetch", status: "approved" },
  ];
  const items = budgetConnectorSources(importers, connectors);
  assert.deepEqual(items.map((i) => [i.value, i.disabled, i.status]), [["connector:kasa", false, "approved"], ["connector:xlsx", true, "pending"]]);
  assert.equal(items[0].desc, "Kasa. · csv");
  assert.equal(items[0].timeout_s, 30);
  assert.equal(items[1].desc, "Własny importer. · xlsx");
  assert.deepEqual(budgetConnectorSources(null, null), []);
  // an approved connector the importer list does not offer (not runnable now) stays disabled
  assert.equal(budgetConnectorSources([importers[0], { id: "connector:other", name: "o", kind: "connector", available: true }], connectors)
    .find((i) => i.id === "kasa").disabled, true);
});

test("parseUnifiedDiff: line numbers, counts, headers dropped", () => {
  const text = "--- a/connector.py\n+++ b/connector.py\n@@ -1,3 +1,4 @@\n import csv\n-import os\n+import json\n+import sys\n def main():\n\\ No newline at end of file\n";
  const { rows, added, removed } = parseUnifiedDiff(text);
  assert.equal(added, 2);
  assert.equal(removed, 1);
  assert.deepEqual(rows.map((r) => [r.kind, r.old, r.new, r.text]), [
    ["hunk", null, null, "@@ -1,3 +1,4 @@"],
    ["ctx", 1, 1, "import csv"],
    ["del", 2, null, "import os"],
    ["add", null, 2, "import json"],
    ["add", null, 3, "import sys"],
    ["ctx", 3, 4, "def main():"],
    ["note", null, null, "No newline at end of file"],
  ]);
  assert.deepEqual(parseUnifiedDiff("").rows, []);
});

// ---- F10 fix wave (FE-FIX) ---------------------------------------------------------------------------------------

test("FE-3 moduleSyncLines: proposal, committed, failure kind, problem, skipped reason", () => {
  const ok = { ok: true, error_kind: null };
  const lines = moduleSyncLines([
    { connector_name: "E2E Bank API", account: "Konto", run: ok, preview: { new: 2 }, proposal_id: 9, committed: null, problem: null, skipped: null },
    { connector_name: "E2E Bank API", account: "Konto", run: ok, preview: { new: 3 }, proposal_id: null, committed: { inserted: 3 }, problem: null, skipped: null },
    { connector_name: "Bank X", run: { ok: false, error_kind: "auth_failed" }, preview: null, proposal_id: null, committed: null, skipped: null },
    { connector_name: "Bank X", run: ok, preview: null, proposal_id: null, committed: null, problem: { code: "cursor_conflict", message: "x" }, skipped: null },
    { binding_id: 4, connector_id: "bank-y", skipped: "interval" },
    { binding_id: 5, connector_id: "bank-z", skipped: "failed" },
  ], (l) => (l.binding_id === 4 ? "Bank Y" : l.connector_id));
  assert.equal(lines[0].text, "E2E Bank API: Import czeka na zatwierdzenie · 2 nowe rekordy");
  assert.equal(lines[0].proposalId, 9);
  assert.equal(lines[1].text, "E2E Bank API: Zapisano 3 nowe rekordy · Konto");
  assert.equal(lines[1].inserted, 3);
  assert.equal(lines[2].failed, true);
  assert.equal(lines[2].text, `Bank X: ${kindLine("auth_failed")}`);
  assert.equal(lines[3].failed, true);
  assert.equal(lines[3].text, `Bank X: ${label("proposal.error.cursor_conflict")}`);
  assert.equal(lines[4].text, "Bank Y: pominięty · pobrany w ciągu 20 h");
  assert.equal(lines[4].failed, false);
  assert.equal(lines[5].text, "bank-z: pominięty · błąd konektora");
  assert.equal(lines[5].failed, true);
  assert.deepEqual(moduleSyncLines(undefined, () => ""), []);
});

test("FE-6 backoffActive: naive UTC with microseconds, an offset, absent", () => {
  const now = Date.UTC(2026, 9, 6, 10, 0, 0);
  assert.equal(backoffActive("2026-10-06T11:00:00.123456", now), true); // naive = UTC, 6-digit fraction
  assert.equal(backoffActive("2026-10-06T09:59:00.000001", now), false);
  assert.equal(backoffActive("2026-10-06T12:30:00+02:00", now), true);
  assert.equal(backoffActive(null, now), false);
  assert.equal(backoffActive("nonsense", now), false);
});

test("FE-1 effectiveAccount: the chosen one while offered, else the first, else none", () => {
  assert.equal(effectiveAccount(null, []), null);
  assert.equal(effectiveAccount(null, [{ id: 3 }, { id: 4 }]), 3); // the list arrived after mount
  assert.equal(effectiveAccount(4, [{ id: 3 }, { id: 4 }]), 4);
  assert.equal(effectiveAccount(7, [{ id: 3 }]), 3); // bound meanwhile: no longer offered
});

test("FE-8 secrets are trimmed; blank fields keep, null clears", () => {
  assert.deepEqual(newSecrets({ api_key: "  abc\n", other: "   ", gone: null }), { api_key: "abc" });
  assert.deepEqual(secretChanges({ api_key: "abc \n", other: "  ", gone: null }), { api_key: "abc", gone: null });
});

test("FE-11 secretsLeftText", () => {
  assert.equal(secretsLeftText(0, "x"), null);
  assert.equal(secretsLeftText(undefined, "x"), null);
  assert.equal(secretsLeftText(1, "bank-y"), "1 sekret został w pęku kluczy macOS (cashu · connector/bank-y/…)");
  assert.equal(secretsLeftText(2, "bank-y"), "2 sekrety zostały w pęku kluczy macOS (cashu · connector/bank-y/…)");
});

test("FE-5 changedSinceApproval: changed, or disabled with content_changed", () => {
  assert.equal(changedSinceApproval({ status: "changed" }), true);
  assert.equal(changedSinceApproval({ status: "disabled", content_changed: true }), true);
  assert.equal(changedSinceApproval({ status: "disabled", content_changed: false }), false);
  assert.equal(changedSinceApproval({ status: "disabled" }), false); // an older server
  assert.equal(changedSinceApproval({ status: "approved", content_changed: true }), false);
  assert.equal(changedSinceApproval({ status: "pending" }), false);
});

test("FE-10 the expired statement preview has a label", () => {
  assert.equal(label("import.preview_expired"), "Podgląd wygasł: wybierz plik jeszcze raz.");
});

test("BE-2 pending_exists: the binding sync toast and the module sync line carry the waiting proposal", () => {
  assert.equal(syncToast({ outcome: "pending_exists", run: null, preview: { new: 2 }, proposal_id: 5, committed: null }, "x"),
    "Poprzedni import czeka na zatwierdzenie · 2 nowe rekordy");
  assert.equal(syncToast({ outcome: "synced", run: null, preview: null, proposal_id: null, committed: null }, "x"), null);
  const [line] = moduleSyncLines([{ binding_id: 4, connector_id: "bank-y", skipped: "pending_exists", proposal_id: 12 }], () => "Bank Y");
  assert.equal(line.text, "Bank Y: pominięty · poprzedni import czeka na zatwierdzenie");
  assert.equal(line.proposalId, 12);
  assert.equal(line.failed, false);
});

test("BE-1 / BE-3 labels: the overlap warning and the document currency refusal", () => {
  assert.equal(describeImportWarning({ kind: "overlap", message: "3 rows are already covered" }).text, "Wiersze już w historii konta z innego źródła (bank, CSV): pominięte");
  assert.equal(describeError({ code: "import_currency_mismatch", message: "The file is in EUR, the account in PLN" }).text, "Waluta pliku różni się od waluty konta.");
});
