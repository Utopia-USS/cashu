// Majątek on Przegląd (F7 merge, design/v2/networth-merge): the manually valued positions in one widget of the
// assets module (no tab any more): the list with valuation dates and a vehicle's monthly loss, `+ Dodaj` and a
// row open one drawer form (add / edit), `Usuń` removes with `Cofnij`. An older server without
// GET /assets/manual: the net-worth rows, read-only.
import { useState } from "react";
import type { Account } from "../../core/api";
import { errorText } from "../../core/messages";
import type { ModuleCtx } from "../../core/types";
import { cur0s, round0, TYPE_LABEL } from "../../format";
import { useAsync } from "../../hooks";
import { ck } from "../../swr";
import { todayLocal } from "../../time";
import { Drawer, Empty, Notice, Skeleton, Tag, useToast } from "../../ui";
import { FootFacts, Widget } from "../../widgets";
import { deleteManualAsset, getManualAssets, type ManualAsset, patchManualAsset, postManualAsset, restoreManualAsset } from "./api";
import {
  type AssetDraft, CREATE_TYPES, createBody, dmy, isAsset, monthlyLoss, NOTE_MAX, patchBody, ratePct, sumByCurrency, valuationLabel, visibleRows,
} from "./logic";

type Row = Account & Partial<Pick<ManualAsset, "kind" | "note" | "depreciation">>;
const CAP = 5;

export function AssetsWidget({ ctx }: { ctx: ModuleCtx }) {
  const toast = useToast();
  const slug = ctx.slug;
  const base = ctx.profile.base_currency;
  const today = todayLocal();
  const manual = useAsync(() => getManualAssets(slug), [slug], { key: ck(slug, "assets-manual") });
  const [edit, setEdit] = useState<null | "new" | ManualAsset>(null);
  const [all, setAll] = useState(false);

  const api = manual.data != null;
  // The API's order (largest |value| first) is the contract; the fallback keeps the net-worth order.
  const rows: Row[] = api ? manual.data!.filter((a) => !a.is_liability) : ctx.networth.accounts.filter(isAsset);
  const vehicles = rows.filter((a) => a.kind === "vehicle" && a.depreciation && a.currency === base);
  const losses = vehicles.map((a) => monthlyLoss(a.balance, a.depreciation)).filter((v): v is number => v != null);
  const loss = losses.length ? losses.reduce((s, v) => s + v, 0) : null;
  const totals = sumByCurrency(rows, base);

  const saved = (created: boolean, valueChanged: boolean) => {
    setEdit(null);
    toast(created ? "Dodano" : "Zapisano");
    manual.reload();
    // A value moves the net worth: the hero, the chart and Konta re-read (the page remounts).
    if (valueChanged) ctx.refresh();
  };
  const removed = (a: ManualAsset) => {
    setEdit(null);
    const refresh = ctx.refresh;
    const undo = () => {
      void restoreManualAsset(slug, a.id).then(
        () => { refresh(); toast(`Cofnięto: usunięcie ${a.name}`, 2500); },
        (e: unknown) => toast(`Nie cofnięto: ${errorText(e)}`, 8000, { label: "Cofnij", onClick: undo }),
      );
    };
    toast(`Usunięto ${a.name}`, 10000, { label: "Cofnij", onClick: undo });
    refresh();
  };

  if (manual.loading && !manual.data) {
    return <Widget title="Majątek" body="flush tight"><div style={{ padding: "0 16px" }}><Skeleton h={40} /></div></Widget>;
  }

  const subLine = (a: Row) => {
    if (api && a.kind === "vehicle") return `krzywa utraty wartości${a.depreciation ? ` · ${ratePct(a.depreciation.annual_rate)} % / rok` : ""}`;
    const v = valuationLabel(a.as_of, today);
    if (!v) return null;
    return v.stale ? <span className="warn" title="wycena starsza niż rok">{v.text}</span> : v.text;
  };
  const lossLine = (a: Row) => {
    if (!api || a.kind !== "vehicle") return null;
    const l = monthlyLoss(a.balance, a.depreciation);
    if (l == null) return null;
    return round0(l) > 0 ? `-${cur0s(l, a.currency)} / mies.` : "wartość minimalna";
  };

  return (
    <Widget title="Majątek" count={rows.length || undefined} id="ov-assets"
      controls={api && rows.length ? <button className="btn sm" onClick={() => setEdit("new")}>+ Dodaj</button> : undefined}
      body="flush tight"
      footer={rows.length ? (
        <>
          <FootFacts items={[
            <>razem <b>{totals.map(([c, v]) => cur0s(v, c)).join(" · ")}</b></>,
            loss != null && round0(loss) > 0 && <>{vehicles.length === 1 ? "auto" : "auta"} <b>-{cur0s(loss, base)}</b> / mies.</>,
          ]} />
          <span className="spacer" />
          {rows.length > CAP && <button className="lnk" onClick={() => setAll((v) => !v)}>{all ? "mniej" : `wszystkie (${rows.length})`}</button>}
        </>
      ) : undefined}>
      {!rows.length ? (
        <Empty title="Brak pozycji." action={api
          ? <button className="btn" onClick={() => setEdit("new")}>Dodaj</button>
          : <button className="btn" onClick={() => ctx.go({ kind: "setup", module: "assets" })}>Konfiguracja</button>} />
      ) : (
        <table>
          <tbody>
            {visibleRows(rows, all, CAP).map((a) => {
              const sub = subLine(a);
              const line = lossLine(a);
              const open = api ? () => setEdit(a as ManualAsset) : undefined;
              return (
                <tr key={a.id} className={api ? "rowlink" : undefined} onClick={open}>
                  <td>
                    {api
                      ? <button className="nm" onClick={(e) => { e.stopPropagation(); open!(); }} aria-label={`Edytuj: ${a.name}`}>{a.name}</button>
                      : <span className="nm">{a.name}</span>}
                    {api && a.note && <> <Tag title={a.note}>notatka</Tag></>}
                    {sub != null && <span className="sym">{sub}</span>}
                  </td>
                  <td className="num">{cur0s(a.balance, a.currency)}{line && <span className="sym">{line}</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {edit != null && (
        <AssetDrawer key={edit === "new" ? "new" : edit.id} target={edit} slug={slug} base={base} today={today}
          onClose={() => setEdit(null)} onSaved={saved} onRemoved={removed} />
      )}
    </Widget>
  );
}

/** "zł" / "€" after the value field (the currency code when Intl has no symbol). */
function currencySign(c: string): string {
  try {
    return new Intl.NumberFormat("pl-PL", { style: "currency", currency: c }).formatToParts(0).find((p) => p.type === "currency")?.value ?? c;
  } catch { return c; }
}

/** "545 000" / "1 250,5" for the value field. */
const valueText = (v: number | null) => (v == null ? "" : v.toLocaleString("pl-PL", { maximumFractionDigits: 2 }));

/** The add / edit form in a drawer: a new position (name, type, value, currency, date, note), a manual one
 * (value, date, note) or a vehicle (note only: its value follows the depreciation terms). */
function AssetDrawer({ target, slug, base, today, onClose, onSaved, onRemoved }: {
  target: "new" | ManualAsset; slug: string; base: string; today: string;
  onClose: () => void; onSaved: (created: boolean, valueChanged: boolean) => void; onRemoved: (a: ManualAsset) => void;
}) {
  const row = target === "new" ? null : target;
  const vehicle = row?.kind === "vehicle";
  const [d, setD] = useState<AssetDraft>({
    name: "", type: "property", currency: base, onDate: today,
    value: row ? valueText(row.balance) : "", note: row?.note ?? "",
  });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof AssetDraft) => (e: { target: { value: string } }) => setD((x) => ({ ...x, [k]: e.target.value }));

  const submit = async () => {
    const r = row ? patchBody(row, { note: d.note, value: vehicle ? null : d.value, onDate: d.onDate }, today) : createBody(d, today);
    if (!r.ok) { setErr(r.error); return; }
    if (row && !Object.keys(r.body).length) { onClose(); return; }
    setBusy(true); setErr(null);
    try {
      if (row) await patchManualAsset(slug, row.id, r.body); else await postManualAsset(slug, r.body);
      onSaved(!row, !row || "value" in r.body);
    } catch (e) {
      setErr(`Nie zapisano: ${errorText(e)}`);
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!row) return;
    setBusy(true); setErr(null);
    try {
      await deleteManualAsset(slug, row.id);
      onRemoved(row);
    } catch (e) {
      setErr(`Nie usunięto: ${errorText(e)}`);
      setBusy(false);
    }
  };

  const valueField = (
    <div className="field">
      <label htmlFor="as-value">Wartość</label>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input id="as-value" className="num" inputMode="decimal" autoComplete="off" value={d.value} onChange={set("value")}
          style={{ flex: 1, minWidth: 0 }} data-autofocus={row && !vehicle ? true : undefined} />
        {row && <span className="muted" style={{ fontSize: 13 }}>{currencySign(row.currency)}</span>}
      </div>
    </div>
  );
  const dateField = (
    <div className="field">
      <label htmlFor="as-date">Data wyceny</label>
      <input id="as-date" type="date" value={d.onDate ?? ""} max={today} onChange={set("onDate")} />
    </div>
  );
  const noteField = (
    <div className="field">
      <label htmlFor="as-note">Notatka</label>
      <input id="as-note" value={d.note} maxLength={NOTE_MAX} autoComplete="off" onChange={set("note")} data-autofocus={vehicle ? true : undefined} />
    </div>
  );

  return (
    <Drawer open width={480} onClose={onClose} label="Majątek"
      title={row ? row.name : "Nowa pozycja"}
      tag={row ? <Tag>{TYPE_LABEL[row.type] ?? row.type}</Tag> : undefined}
      footer={
        <>
          <button type="submit" form="asset-form" className="btn primary" disabled={busy}>{busy ? "Zapisuję…" : "Zapisz"}</button>
          <button type="button" className="btn" onClick={onClose}>Anuluj</button>
          {row && <button type="button" className="btn" onClick={() => void remove()} disabled={busy}>Usuń</button>}
        </>
      }>
      {/* noValidate: the date picker keeps `max` (no future day to pick), a typed one gets the Polish line below. */}
      <form id="asset-form" className="asset-form" noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        {err && <Notice tone="neg">{err}</Notice>}
        {!row ? (
          <>
            <div className="field">
              <label htmlFor="as-name">Nazwa</label>
              <input id="as-name" value={d.name} maxLength={120} autoComplete="off" onChange={set("name")} data-autofocus />
            </div>
            <div className="field">
              <label htmlFor="as-type">Typ</label>
              <select id="as-type" value={d.type} onChange={set("type")}>
                {CREATE_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t] ?? t}</option>)}
              </select>
            </div>
            <div className="form-row">
              {valueField}
              <div className="field">
                <label htmlFor="as-cur">Waluta</label>
                <input id="as-cur" value={d.currency} maxLength={3} autoComplete="off" style={{ textTransform: "uppercase" }} onChange={set("currency")} />
              </div>
            </div>
            {dateField}
            {noteField}
          </>
        ) : vehicle ? (
          <>
            <div className="field">
              <label htmlFor="as-ro">Wartość</label>
              <output id="as-ro" className="ro">{cur0s(row.balance, row.currency)}</output>
            </div>
            <div className="sub">krzywa utraty wartości{row.depreciation ? ` · ${ratePct(row.depreciation.annual_rate)} % / rok` : ""}</div>
            {noteField}
          </>
        ) : (
          <>
            <div className="form-row">
              {valueField}
              {dateField}
            </div>
            {row.as_of && <div className="sub">ostatnia wycena {dmy(row.as_of)}</div>}
            {noteField}
          </>
        )}
      </form>
    </Drawer>
  );
}
