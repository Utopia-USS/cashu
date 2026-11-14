// Pure helpers of Ustawienia › Konektory on the native connector snapshot and the connector activity query
// (ab24ab6 core/connectors.ts parts the native data carries: status vocabulary, list order, labels, the binding
// form's parameters, the run and sync lines).
import { intlLocale, lang } from "@cashu/i18n";
import { CS, KIND, KIND_SHORT, MODULE, OUTCOME } from "@cashu/i18n/core/connectors.strings";
import type { ConnectorBindingSync, ConnectorRunView } from "@cashu/store/core/desktop-settings";
import { label } from "@cashu/ui-logic/core/messages";
import { parseServerTime, serverDate } from "@cashu/ui-logic/core/time";
import type { SettingsScreenState } from "../useSettingsScreen.js";

type Snapshot = NonNullable<SettingsScreenState["connectorSnapshot"]>;
export type Connector = Snapshot["connectors"][number];
export type Binding = Snapshot["bindings"][number];
export type ConnectorRun = SettingsScreenState["connectorActivity"]["runs"][number];

const ORDER: Readonly<Record<string, number>> = {
  changed: 0,
  pending: 1,
  approved: 2,
  disabled: 3,
};
/** changed, pending, approved, disabled; then by name (Polish collation). */
export function sortConnectors<T extends { approval: string; name: string }>(
  list: readonly T[],
): T[] {
  return [...list].sort(
    (a, b) =>
      (ORDER[a.approval] ?? 9) - (ORDER[b.approval] ?? 9) || a.name.localeCompare(b.name, "pl"),
  );
}

export const moduleLabel = (module: string): string =>
  module in MODULE ? MODULE[module as keyof typeof MODULE] : module;
export const kindLabel = (kind: string): string =>
  kind in KIND ? KIND[kind as keyof typeof KIND] : kind;

/** `sha256 0123456789ab…` (old checksum line). */
export const shortSha = (sha: string): string => `sha256 ${sha.slice(0, 12)}…`;

type Tone = "pos" | "neg" | "warn" | "info";
/** Old `OUTCOME_TONE`. */
const OUTCOME_TONE: Readonly<Record<string, Tone>> = {
  ok: "pos",
  failed: "neg",
  timeout: "neg",
  refused: "warn",
};
export const outcomeLabel = (outcome: string): string =>
  outcome in OUTCOME ? OUTCOME[outcome as keyof typeof OUTCOME] : outcome;
export const outcomeTone = (outcome: string): Tone | undefined => OUTCOME_TONE[outcome];

/** Short lower-case form of an error kind for table rows (`limit czasu`, `odrzucony plik`). */
export const kindShort = (kind: string | null | undefined): string =>
  kind ? (kind in KIND_SHORT ? KIND_SHORT[kind as keyof typeof KIND_SHORT] : kind) : "";
/** The one line of a failure kind (`connector.<kind>` in messages). */
export const kindLine = (kind: string, timeoutS?: number | null): string =>
  label(`connector.${kind}`, timeoutS != null ? { timeout_s: timeoutS } : {}) ??
  CS.kindFailed(kind);

/** "5.10 14:30" in local time (Settings' time format); English: the locale's short day, month and time. */
export function when(iso: string | null | undefined): string {
  const t = serverDate(iso);
  if (t && lang() !== "pl")
    return new Intl.DateTimeFormat(intlLocale(), {
      day: "numeric",
      month: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(t);
  return t
    ? `${t.getDate()}.${String(t.getMonth() + 1).padStart(2, "0")} ${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`
    : "-";
}

/** A run's duration: `850 ms`, `1,3 s`. */
export const durationText = (ms: number): string =>
  ms >= 1000
    ? `${(ms / 1000).toLocaleString(intlLocale(), { maximumFractionDigits: 1 })} s`
    : `${ms} ms`;

/** The connector's newest runs in this profile, newest first. */
export const runsOf = (
  runs: readonly ConnectorRunView[],
  connectorId: string,
): ConnectorRunView[] => runs.filter((run) => run.connectorId === connectorId);

/** The connector row's run line: `jeszcze nie uruchomiony` | `ostatni przebieg 5.10 14:30 · błąd (limit czasu)`. */
function lastRunText(run: ConnectorRunView | undefined): string {
  if (!run) return CS.neverRun;
  const out = outcomeLabel(run.outcome);
  return CS.lastRun(
    when(run.startedAt),
    `${out}${run.errorKind ? ` (${kindShort(run.errorKind)})` : ""}`,
  );
}

/** The connector row's second line: `v1.2 · autor · ostatni przebieg ... · 2 powiązania`. */
export function rowLine(
  connector: Pick<Connector, "version" | "author" | "kind">,
  lastRun: ConnectorRunView | undefined,
  bindings: number,
): string {
  const parts = [
    ...(connector.version
      ? [`v${connector.version}${connector.author ? ` · ${connector.author}` : ""}`]
      : []),
    lastRunText(lastRun),
  ];
  if (bindings > 0 || connector.kind === "fetch") parts.push(CS.bindings(bindings));
  return parts.join(" · ");
}

/** A binding row's sync line. */
export function lastSyncText(sync: ConnectorBindingSync | undefined): string {
  if (!sync?.lastRunAt) return CS.neverSynced;
  const status = sync.lastStatus ? outcomeLabel(sync.lastStatus) : "-";
  return `${CS.lastSync(when(sync.lastRunAt), status)}${
    sync.lastOkAt && sync.lastStatus !== "ok" ? CS.lastOk(when(sync.lastOkAt)) : ""
  }`;
}

/** A rate-limit backoff still holds. */
export const backoffActive = (iso: string | null | undefined, now = Date.now()): boolean =>
  parseServerTime(iso) > now;
