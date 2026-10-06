// Connectors (F10, design/v3/connectors): pure helpers for Settings > Konektory, the connector drawer, the
// import drawers and the sync toasts. No React, no DOM: tested in tests/connectors.test.mjs.
import { label, plural } from "./messages.ts";
import { parseServerTime, serverDate } from "../time.ts";

type Tone = "pos" | "neg" | "warn" | "info";

/** Status vocabulary (D8): label, tone, solid. */
export const STATUS: Record<string, [string, Tone | undefined, boolean]> = {
  pending: ["do zatwierdzenia", "warn", true],
  approved: ["zatwierdzony", "pos", false],
  changed: ["zmieniony", "neg", true],
  disabled: ["wyłączony", undefined, false],
};
export const statusOf = (s: string): [string, Tone | undefined, boolean] => STATUS[s] ?? [s, undefined, false];
export const OUTCOME_LABEL: Record<string, string> = { ok: "ok", failed: "błąd", timeout: "limit czasu", refused: "odmowa" };
export const OUTCOME_TONE: Record<string, Tone> = { ok: "pos", failed: "neg", timeout: "neg", refused: "warn" };
export const KIND_LABEL: Record<string, string> = { file: "plik", fetch: "pobieranie" };
export const MODULE_LABEL: Record<string, string> = { investments: "Inwestycje", budget: "Budżet" };
/** The public contract for connector authors (owner question 1: the GitHub link). */
export const CONNECTORS_DOCS_URL = "https://github.com/Utopia-USS/cashu/blob/main/docs/connectors.md";
/** The rule behind `Automatyczny zapis` (tooltip, D10). */
export const AUTO_RULE = "Dopiero po pierwszym zatwierdzonym imporcie i tylko czyste przebiegi (bez ostrzeżeń, same nowe rekordy). Inaczej import czeka na Twoją decyzję.";
/** Proposal kinds the investments views list (a `budget_import` belongs to the budget tabbar). */
export const INV_PROPOSAL_KINDS: ReadonlySet<string> = new Set(["strategy", "custom_rule", "rule", "import"]);

/** "5.10 14:30" in local time (Settings' time format). */
export function when(iso: string | null | undefined): string {
  const t = serverDate(iso);
  return t ? `${t.getDate()}.${String(t.getMonth() + 1).padStart(2, "0")} ${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}` : "-";
}

/** `412 B`, `6,8 KiB`, `26 KiB`, `1,2 MiB` (Polish decimal comma). */
export function sizeText(bytes: number): string {
  const f = (v: number, d: number) => v.toLocaleString("pl-PL", { minimumFractionDigits: d, maximumFractionDigits: d });
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${f(bytes / 1024, bytes < 10240 ? 1 : 0)} KiB`;
  return `${f(bytes / 1048576, 1)} MiB`;
}

const TEXT_EXT = /\.(py|js|mjs|cjs|ts|rb|pl|sh|yaml|yml|json|md|txt|toml|cfg|ini|csv|gitignore)$/i;
export const MAX_VIEW_BYTES = 200 * 1024;
/** Can the code viewer show it: a text extension (or none) and <= 200 KiB. */
export function viewable(f: { path: string; size: number }): boolean {
  const name = f.path.split("/").pop() ?? f.path;
  return f.size <= MAX_VIEW_BYTES && (TEXT_EXT.test(name) || !name.includes("."));
}

/** `connector.yaml` first, the rest by path. */
export function sortFiles<T extends { path: string }>(files: readonly T[]): T[] {
  return [...files].sort((a, b) => (a.path === "connector.yaml" ? -1 : b.path === "connector.yaml" ? 1 : a.path.localeCompare(b.path)));
}

export interface FilesDiff { added: string[]; removed: string[]; modified: string[] }
/** `1 zmieniony · 1 dodany` (only non-zero parts; "" when nothing changed). */
export function diffSummary(d: FilesDiff | null | undefined): string {
  if (!d) return "";
  return [
    d.modified.length ? plural(d.modified.length, "zmieniony", "zmienione", "zmienionych") : "",
    d.added.length ? plural(d.added.length, "dodany", "dodane", "dodanych") : "",
    d.removed.length ? plural(d.removed.length, "usunięty", "usunięte", "usuniętych") : "",
  ].filter(Boolean).join(" · ");
}

/** What happened to `path` since approval (a `changed` connector), or null. */
export function fileChange(d: FilesDiff | null | undefined, path: string): "modified" | "added" | "removed" | null {
  if (!d) return null;
  return d.modified.includes(path) ? "modified" : d.added.includes(path) ? "added" : d.removed.includes(path) ? "removed" : null;
}

const ORDER: Record<string, number> = { changed: 0, pending: 1, approved: 2, disabled: 3 };
/** changed, pending, approved, disabled; then by name (Polish collation). */
export function sortConnectors<T extends { status: string; name: string }>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9) || a.name.localeCompare(b.name, "pl"));
}

/** Short lower-case form of an error kind for table rows (`limit czasu`, `odrzucony plik`). */
const KIND_SHORT: Record<string, string> = {
  bad_file: "odrzucony plik", unsupported_version: "wersja eksportu", auth_failed: "klucz odrzucony", rate_limited: "limit zapytań",
  network: "sieć", upstream: "błąd serwisu", internal: "błąd konektora", protocol: "protokół", timeout: "limit czasu",
  sandbox_unavailable: "brak piaskownicy", spawn_failed: "nie uruchomiony", not_approved: "niezatwierdzony", changed: "zmieniony",
  interpreter_changed: "zmieniony interpreter", disabled: "wyłączony", missing: "brak katalogu", bad_request: "zły plik",
  denied_host: "host poza listą",
};
export const kindShort = (kind: string | null | undefined): string => (kind ? KIND_SHORT[kind] ?? kind : "");
/** The one Polish line of a failure kind (`connector.<kind>` in messages.ts). */
export const kindLine = (kind: string, timeoutS?: number | null): string =>
  label(`connector.${kind}`, timeoutS != null ? { timeout_s: timeoutS } : {}) ?? `Konektor nie zadziałał (${kind}).`;

/** The connector row's run line: `jeszcze nie uruchomiony` | `ostatni przebieg 5.10 14:30 · błąd (limit czasu)`. */
export function lastRunText(c: { last_run: { outcome: string; error_kind: string | null; started_at: string | null } | null }): string {
  const r = c.last_run;
  if (!r) return "jeszcze nie uruchomiony";
  const out = OUTCOME_LABEL[r.outcome] ?? r.outcome;
  return `ostatni przebieg ${when(r.started_at)} · ${out}${r.error_kind ? ` (${kindShort(r.error_kind)})` : ""}`;
}

/** The connector row's second line (section 2). */
export function rowLine(c: { version: string; author: string | null; kind: string; bindings: number; last_run: { outcome: string; error_kind: string | null; started_at: string | null } | null }): string {
  const parts = [`v${c.version}${c.author ? ` · ${c.author}` : ""}`, lastRunText(c)];
  if (c.bindings > 0 || c.kind === "fetch") parts.push(plural(c.bindings, "powiązanie", "powiązania", "powiązań"));
  return parts.join(" · ");
}

/** `brak` | `ustawione` | `1 brakuje`. */
export function secretsText(b: { secrets: { id: string }[]; secrets_set: string[] }): string {
  if (!b.secrets.length) return "brak";
  const missing = b.secrets.filter((s) => !b.secrets_set.includes(s.id)).length;
  return missing ? `${missing} brakuje` : "ustawione";
}
export const secretMissing = (b: { secrets: { id: string }[]; secrets_set: string[] }): boolean =>
  b.secrets.some((s) => !b.secrets_set.includes(s.id));

/** A binding row's sync line. */
export function lastSyncText(b: { last_run_at: string | null; last_status: string | null; last_ok_at: string | null }): string {
  if (!b.last_run_at) return "jeszcze nie synchronizowano";
  const st = b.last_status ? OUTCOME_LABEL[b.last_status] ?? b.last_status : "-";
  return `ostatnia synchronizacja ${when(b.last_run_at)} · ${st}${b.last_ok_at && b.last_status !== "ok" ? ` · ostatnia udana ${when(b.last_ok_at)}` : ""}`;
}

/** Built-in importer label, else the connector's name, else the raw id. */
export function importerName(id: string | null | undefined, connectors: readonly { id: string; name: string }[] | null | undefined, builtins: readonly [string, string][] = []): string {
  if (!id) return "-";
  const b = builtins.find(([k]) => k === id);
  if (b) return b[1];
  if (id.startsWith("connector:")) {
    const c = connectors?.find((x) => x.id === id.slice(10));
    if (c) return c.name;
  }
  return id;
}

/** The toast after `Synchronizuj` (null: no toast, the row shows the failure). `pending_exists` (BE-2): nothing ran,
 * the binding's previous result still waits (`proposal_id`, its stored preview). */
export function syncToast(r: { outcome?: string; run: { ok: boolean } | null; preview: { new: number } | null; proposal_id: number | null; committed: { inserted: number } | null }, account: string): string | null {
  if (r.outcome === "pending_exists") return `Poprzedni import czeka na zatwierdzenie · ${plural(r.preview?.new ?? 0, "nowy rekord", "nowe rekordy", "nowych rekordów")}`;
  if (!r.run?.ok) return null;
  if (r.proposal_id != null) return `Import czeka na zatwierdzenie · ${plural(r.preview?.new ?? 0, "nowy rekord", "nowe rekordy", "nowych rekordów")}`;
  if (r.committed && r.committed.inserted > 0) return `Zapisano ${plural(r.committed.inserted, "nowy rekord", "nowe rekordy", "nowych rekordów")} · ${account}`;
  return "Brak nowych rekordów";
}

/** A blocking sync problem (`import_failed`, `cursor_conflict`, a connector code): its Polish label, else the text. */
export function problemText(p: { code: string; message: string } | null | undefined): string | null {
  if (!p) return null;
  return label(`proposal.error.${p.code}`) ?? label(`error.${p.code}`) ?? p.message;
}

/** A module sync line (`POST /resync`, `/investments/run`: `connectors[]`): a binding's sync result, or the
 * reason it was skipped (`not_approved`, `missing_secret`, `backoff`, `interval`, `busy`, `failed`). */
export interface ModuleSyncLine {
  binding_id?: number;
  connector_id?: string;
  connector_name?: string;
  account?: string | null;
  run?: { ok: boolean; error_kind: string | null };
  preview?: { new: number } | null;
  proposal_id?: number | null;
  committed?: { inserted: number } | null;
  problem?: { code: string; message: string } | null;
  skipped: string | null;
}
const SKIPPED: Record<string, string> = {
  not_approved: "konektor niezatwierdzony", missing_secret: "brak sekretu", backoff: "limit API serwisu",
  interval: "pobrany w ciągu 20 h", busy: "synchronizacja już trwa", failed: "błąd konektora",
  pending_exists: "poprzedni import czeka na zatwierdzenie",
};
export interface SyncToastLine { text: string; failed: boolean; proposalId: number | null; inserted: number }
/** One toast per connector of a module sync: `{name}: {result}`. `name(line)` resolves a skipped line's name
 * (it carries only the ids). */
export function moduleSyncLines(lines: readonly ModuleSyncLine[] | null | undefined, name: (l: ModuleSyncLine) => string): SyncToastLine[] {
  return (lines ?? []).map((l) => {
    const n = l.connector_name || name(l);
    // a `pending_exists` line carries the waiting proposal (`Zobacz`)
    if (l.skipped) return { text: `${n}: pominięty · ${SKIPPED[l.skipped] ?? l.skipped}`, failed: l.skipped === "failed", proposalId: l.proposal_id ?? null, inserted: 0 };
    if (!l.run?.ok) return { text: `${n}: ${kindLine(l.run?.error_kind ?? "internal")}`, failed: true, proposalId: null, inserted: 0 };
    const problem = problemText(l.problem);
    if (problem) return { text: `${n}: ${problem}`, failed: true, proposalId: null, inserted: 0 };
    const text = syncToast({ run: l.run, preview: l.preview ?? null, proposal_id: l.proposal_id ?? null, committed: l.committed ?? null }, l.account || n);
    return { text: `${n}: ${text ?? ""}`, failed: false, proposalId: l.proposal_id ?? null, inserted: l.committed?.inserted ?? 0 };
  });
}

/** A rate-limit backoff still holds (`backoff_until` is a naive UTC date-time from the server). */
export const backoffActive = (iso: string | null | undefined, now = Date.now()): boolean => parseServerTime(iso) > now;

/** The binding form's account: the chosen one while it is still offered, else the first offered (the account list
 * may arrive after the form mounted), else none. */
export function effectiveAccount(chosen: number | null, accounts: readonly { id: number }[]): number | null {
  return chosen != null && accounts.some((a) => a.id === chosen) ? chosen : accounts[0]?.id ?? null;
}

/** Secrets of a new binding: the typed, non-blank ones, trimmed (a pasted key often ends with a newline). */
export function newSecrets(secrets: Readonly<Record<string, string | null>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(secrets)) if (typeof v === "string" && v.trim()) out[k] = v.trim();
  return out;
}
/** Secret changes of an existing binding: a typed value (trimmed) sets, null clears, a blank field keeps. */
export function secretChanges(secrets: Readonly<Record<string, string | null>>): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(secrets)) {
    if (v === null) out[k] = null;
    else if (v.trim()) out[k] = v.trim();
  }
  return out;
}

/** Keychain entries a delete could not remove (`secrets_left`): one line for a toast, null when none. */
export function secretsLeftText(n: number | null | undefined, connectorId: string): string | null {
  if (!n) return null;
  return `${plural(n, "sekret został", "sekrety zostały", "sekretów zostało")} w pęku kluczy macOS (cashu · connector/${connectorId}/…)`;
}

/** The files differ from the approved copy: a `changed` connector, or a `disabled` one edited on disk
 * (`content_changed`, FE-5 contract). The drawer then shows the notice and the line diff. */
export const changedSinceApproval = (c: { status: string; content_changed?: boolean }): boolean =>
  c.status === "changed" || (c.status === "disabled" && !!c.content_changed);

/** The file input's `accept` for a connector's extensions (`.csv,.xlsx`). */
export const acceptOf = (extensions: readonly string[] | null | undefined): string => (extensions ?? []).map((e) => `.${e}`).join(",");

/** The budget statement drawer's connector radios (section 5.1): approved file connectors of the budget module
 * from the importer list (`kind: connector`) or the status list, pending / changed / disabled ones shown
 * disabled with their status. Empty = the drawer keeps the placeholder radio. */
export interface ConnectorSourceItem {
  value: string; id: string; name: string; desc: string; status: string; disabled: boolean;
  version: string | null; extensions: string[]; timeout_s: number | null;
}
export function budgetConnectorSources(
  importers: readonly { id: string; name: string; kind: string; available: boolean }[] | null | undefined,
  connectors: readonly { id: string; name: string; module: string; kind: string; status: string; version?: string; description?: string | null; extensions?: string[]; timeout_s?: number }[] | null | undefined,
): ConnectorSourceItem[] {
  const listed = (importers ?? []).filter((i) => i.kind === "connector" && i.id.startsWith("connector:"));
  const known = new Map((connectors ?? []).filter((c) => c.module === "budget" && c.kind === "file").map((c) => [c.id, c]));
  const ids = [...new Set([...listed.map((i) => i.id.slice(10)), ...known.keys()])];
  const items = ids.map((id) => {
    const imp = listed.find((i) => i.id === `connector:${id}`);
    const c = known.get(id);
    const status = c?.status ?? (imp?.available === false ? "pending" : "approved");
    // The importer list is the authority on "can run"; a server that lists no connectors there: the status.
    const runnable = listed.length ? !!imp && imp.available !== false && status === "approved" : status === "approved";
    const ext = c?.extensions ?? [];
    return {
      value: `connector:${id}`, id, name: c?.name ?? imp?.name ?? id,
      desc: [c?.description || "Własny importer.", ext.join(", ")].filter(Boolean).join(" · "),
      status, disabled: !runnable, version: c?.version ?? null, extensions: ext, timeout_s: c?.timeout_s ?? null,
    };
  });
  return items.sort((a, b) => Number(a.disabled) - Number(b.disabled) || a.name.localeCompare(b.name, "pl"));
}

// ---- unified diff (a `changed` file against its approved copy) ------------------------------------

export interface DiffRow { kind: "hunk" | "add" | "del" | "ctx" | "note"; old: number | null; new: number | null; text: string }
/** Rows of a unified diff with old / new line numbers (file headers dropped). */
export function parseUnifiedDiff(text: string): { rows: DiffRow[]; added: number; removed: number } {
  const rows: DiffRow[] = [];
  let o = 0, n = 0, added = 0, removed = 0, inHunk = false;
  const lines = text.replace(/\n$/, "").split("\n");
  for (const l of lines) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(l);
    if (h) {
      o = Number(h[1]); n = Number(h[2]); inHunk = true;
      rows.push({ kind: "hunk", old: null, new: null, text: l });
      continue;
    }
    if (!inHunk) continue; // --- / +++ / diff / index headers
    if (l.startsWith("+")) { rows.push({ kind: "add", old: null, new: n++, text: l.slice(1) }); added++; }
    else if (l.startsWith("-")) { rows.push({ kind: "del", old: o++, new: null, text: l.slice(1) }); removed++; }
    else if (l.startsWith("... (diff cut")) rows.push({ kind: "note", old: null, new: null, text: l });
    else if (l.startsWith("\\")) rows.push({ kind: "note", old: null, new: null, text: l.slice(1).trim() });
    else rows.push({ kind: "ctx", old: o++, new: n++, text: l.startsWith(" ") ? l.slice(1) : l });
  }
  return { rows, added, removed };
}
