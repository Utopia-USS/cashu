/** Alert editor preserves stored precision and fields omitted by the owner. */
import { alerts } from "@cashu/domain/investments";
import { normalizeNumberInput } from "@cashu/i18n";
import type { ReadySignals } from "@cashu/store/investments/signals-screen";
import { alertDefaultTitle } from "@cashu/ui-logic/investments/v2/logic";

export type AlertRow = ReadySignals["alerts"][number];
export type AlertDraft = {
  kind: string;
  scope: string;
  instrument: string;
  title: string;
  tag: string;
  note: string;
  polarity: string;
  severity: string;
  cooldown: string;
  expiry: string;
  params: Record<string, string>;
};
export function alertDraft(row: AlertRow | null, catalog: ReadySignals["catalog"]): AlertDraft {
  const kind = row?.kind ?? catalog[0]?.kind ?? "price_below";
  const info = catalog.find((item) => item.kind === kind);
  return {
    kind,
    scope: row?.scope ?? info?.scopes[0] ?? "instrument",
    instrument: row?.instrument ?? "",
    title: row?.title ?? "",
    tag: row?.tag ?? "",
    note: row?.note ?? "",
    polarity: row?.polarity ?? "neutral",
    severity: row?.severity ?? "info",
    cooldown: row === null ? "14" : row.cooldownDays === null ? "" : String(row.cooldownDays),
    expiry: row?.expiresAt?.slice(0, 10) ?? "",
    params: Object.fromEntries(
      (info?.params ?? []).map((param) => [
        param.name,
        row?.params[param.name] == null
          ? param.default == null
            ? ""
            : String(param.default)
          : String(row.params[param.name]),
      ]),
    ),
  };
}
function alertParams(
  draft: AlertDraft,
  row: AlertRow | null,
  catalog: ReadySignals["catalog"],
): Record<string, unknown> {
  const info = catalog.find((item) => item.kind === draft.kind);
  const out: Record<string, unknown> = { ...(row?.params ?? {}) };
  for (const param of info?.params ?? []) {
    const initial = row?.params[param.name];
    const text = draft.params[param.name] ?? "";
    if (
      row !== null &&
      (initial == null ? (param.default == null ? "" : String(param.default)) : String(initial)) ===
        text
    )
      continue;
    if (text.trim() === "") {
      delete out[param.name];
      continue;
    }
    out[param.name] =
      param.type === "choice" || param.type === "text" ? text : Number(normalizeNumberInput(text));
  }
  return out;
}
export function alertInput(
  draft: AlertDraft,
  row: AlertRow | null,
  catalog: ReadySignals["catalog"],
  instruments: ReadySignals["instruments"],
): { ok: true; fields: Record<string, unknown> } | { ok: false; reason: string } {
  const params = alertParams(draft, row, catalog);
  try {
    alerts.validateAlert(draft.kind, params, {
      scope: draft.scope,
      hasInstrument: Boolean(draft.instrument),
    });
  } catch {
    return { ok: false, reason: "alert_invalid" };
  }
  const instrument = instruments.find((item) => item.id === draft.instrument);
  const subject = instrument?.symbol ?? instrument?.name ?? draft.scope;
  const generated = alertDefaultTitle(draft.kind, params, subject, instrument?.currency);
  const oldGenerated =
    row === null ? null : alertDefaultTitle(row.kind, row.params, subject, instrument?.currency);
  const title =
    !draft.title.trim() || (row !== null && draft.title === row.title && row.title === oldGenerated)
      ? generated
      : draft.title.trim();
  const expiry = draft.expiry ? new Date(`${draft.expiry}T23:59:00`).toISOString() : null;
  const cooldownDays = draft.cooldown.trim() === "" ? null : Number(draft.cooldown);
  let tag: string | null;
  try {
    tag = alerts.validateTag(draft.tag);
  } catch {
    return { ok: false, reason: "alert_invalid" };
  }
  if (
    draft.cooldown.trim() !== "" &&
    (cooldownDays === null || !Number.isInteger(cooldownDays) || cooldownDays < 0)
  )
    return { ok: false, reason: "alert_invalid" };
  if (row === null)
    return {
      ok: true,
      fields: {
        kind: draft.kind,
        scope: draft.scope,
        instrument: draft.scope === "instrument" ? draft.instrument || null : null,
        title,
        tag,
        params,
        polarity: draft.polarity,
        severity: draft.severity,
        note: draft.note.trim() || null,
        cooldownDays,
        expiresAt: expiry,
      },
    };
  const changes: Record<string, unknown> = {};
  const compare = (key: string, value: unknown, prior: unknown) => {
    if (JSON.stringify(value) !== JSON.stringify(prior)) changes[key] = value;
  };
  compare("title", title, row.title);
  compare("tag", tag, row.tag);
  compare("params", params, row.params);
  compare("polarity", draft.polarity, row.polarity);
  compare("severity", draft.severity, row.severity);
  compare("note", draft.note.trim() || null, row.note);
  compare("cooldownDays", cooldownDays, row.cooldownDays);
  if (draft.expiry !== (row.expiresAt?.slice(0, 10) ?? ""))
    compare("expiresAt", expiry, row.expiresAt);
  return { ok: true, fields: changes };
}
