/** Native owner read projections. Canonical gids and covering links never pass through legacy DTOs. */
import { parseDateTime, toStorage } from "@cashu/domain";
import { alerts as alertDomain, instrumentLabel, views } from "@cashu/domain/investments";
import { withBucketGeneric } from "@cashu/domain/investments/rules";
import type { Read } from "../../query.js";
import { loadInstruments } from "../queries/instruments.js";
import { decisionSignalGids, decisions } from "../queries/journal.js";
import { allSignals, isCurrent, lastGoodRunGid } from "../queries/signals.js";
import { byCreation } from "../views/stableOrder.js";

export type SignalScope = "open" | "history" | "all";
export function readSignalRows(read: Read, now: string, scope: SignalScope = "open") {
  const instant = toStorage(parseDateTime(now));
  const good = lastGoodRunGid(read);
  const rows = allSignals(read)
    .filter((row) => !views.hiddenFromOwner(row))
    .filter(
      (row) =>
        scope === "all" ||
        (scope === "open"
          ? row.status === "active" || row.status === "acknowledged"
          : row.status === "resolved" || row.status === "expired"),
    );
  const subjects = loadInstruments(
    read,
    rows.flatMap((row) => (row.instrument === null ? [] : [row.instrument])),
  );
  const journal = decisions(read);
  const links = decisionSignalGids(
    read,
    journal.map((row) => row.gid),
  );
  const enrichedDecisions = journal.map((row) => ({ ...row, signals: links.get(row.gid) ?? [] }));
  const covering = new Map<string, typeof enrichedDecisions>();
  for (const row of enrichedDecisions) {
    for (const signal of row.signals.length ? row.signals : row.signal === null ? [] : [row.signal])
      covering.set(signal, [...(covering.get(signal) ?? []), row]);
  }
  const enriched = rows.map((row) => {
    const instrument = row.instrument === null ? undefined : subjects.get(row.instrument);
    const label = instrument === undefined ? null : instrumentLabel(instrument);
    const [messageCode, messageParams] = alertDomain.alertMessage(
      row.kind,
      row.payload,
      row.message,
      label,
    );
    const source = views.signalSource(row);
    return {
      ...row,
      payload: withBucketGeneric(row.kind, row.payload) ?? {},
      source,
      instrumentLabel: label,
      messageCode,
      messageParams,
      alert: row.ruleId.startsWith("alert:") ? row.ruleId.slice(6) : null,
      note:
        source === "research" && typeof row.payload.note_id === "string"
          ? row.payload.note_id
          : null,
      snoozed: row.snoozedUntil !== null && toStorage(parseDateTime(row.snoozedUntil)) > instant,
      current: isCurrent(row, good),
      decisions: covering.get(row.gid) ?? [],
    };
  });
  if (scope !== "open") return enriched;
  // allSignals already supplies newest creation first; stable sort preserves this final source tie.
  const rank = (severity: string) => (severity === "action" ? 0 : severity === "info" ? 1 : 9);
  return enriched.sort(
    (a, b) =>
      Number(a.snoozed) - Number(b.snoozed) ||
      Number(a.status !== "active") - Number(b.status !== "active") ||
      rank(a.severity) - rank(b.severity),
  );
}
export type SignalRow = ReturnType<typeof readSignalRows>[number];

/** Source alert manager order uses effective status, then newest creation anchor. */
export function orderAlertRows<T extends { readonly gid: string; readonly status: string }>(
  read: Read,
  rows: readonly T[],
) {
  const rank: Readonly<Record<string, number>> = {
    triggered: 0,
    active: 1,
    snoozed: 2,
    muted: 3,
    expired: 4,
  };
  return byCreation(read, "alerts", rows, true).sort(
    (a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9),
  );
}
