// Alerts (design/v2/alerts.html, ia-v2.md 7): the Alerty widget on the investments home (triggered first,
// distance-to-level bars, agent badge) and the alerts manager page (status and source filters, the table, the
// form = the standardized schema, the 12-month triggered history). One schema for the owner and the agent;
// agent items are badged and removable. Alerts are conditions on hard data, never forecasts.
import { useEffect, useMemo, useRef, useState } from "react";
import { describeError, errorText } from "../../../core/messages";
import { useAsync, useInFlight } from "../../../hooks";
import { Notice, Seg, Skeleton, useToast } from "../../../ui";
import { AgentTag, AlertStatus, FootFacts, Grid, PolarityText, Widget } from "../../../widgets";
import { bucketLabel, dm, dmy, DECISION_ACTION, hm, parseNum, pct, plural } from "../labels";
import {
  type Alert, type AlertInput, type AlertKindInfo, type AlertPatch, deleteAlert, getAlertKinds, getAlerts, getSignalsV2, patchAlert, postAlert, restoreAlert, type SignalV2,
} from "./api";
import {
  alertConditionText, alertDefaultTitle, alertDistance, alertLevelText, alertNowText, alertPreview, alertWhenSuffix, instName, KIND_LABEL, orderAlerts, price,
} from "./logic";
import { alertDeleteUndo, offerUndo, recreateInput } from "./undoFlow";
import { alertPatch, buildParams, draftText, expiryChoice, expiryValue, formKind } from "./alertForm";
import { csvLine } from "../../../csv";
import { addDays, localDay, parseServerTime, todayLocal } from "../../../time";

export interface InstrumentChoice { id: number; label: string; symbol: string | null; venue: string | null; currency: string; price: number | null; held: boolean }

const isLive = (a: Alert) => a.status === "active" || a.status === "triggered" || a.status === "snoozed";

/** Delete an alert at once; the toast's "Cofnij" restores it (same id, 15 minutes; BE soft delete) or, on a
 * server without the restore endpoint, re-creates it. Returns false when the delete failed. */
export async function removeAlertWithUndo(slug: string, a: Alert, toast: (t: string, ms?: number, act?: { label: string; onClick: () => void }) => void,
  onChanged: () => void): Promise<boolean> {
  try {
    await deleteAlert(slug, a.id);
  } catch (e) {
    toast(`Nie usunięto alertu: ${errorText(e)}`, 5000);
    return false;
  }
  onChanged();
  // The restore keeps the id, the agent source and the history (BE soft delete). Only a server without the
  // restore endpoint re-creates the alert, which then comes back as a new alert of the owner: say so.
  let recreated = false;
  const u = alertDeleteUndo(() => restoreAlert(slug, a.id), () => { recreated = true; return postAlert(slug, recreateInput(a) as AlertInput); });
  offerUndo(toast, `Usunięto alert „${a.title}"`, u, "usunięcie alertu", onChanged, 10000,
    () => (recreated ? (a.source === "agent" ? "wraca jako Twój nowy alert" : "wraca jako nowy alert") : null));
  return true;
}

// ---- widget on the home ------------------------------------------------------------------------------------

export function AlertsWidget({ slug, alerts, onManage, onNew, onChanged }: {
  slug: string; alerts: Alert[] | null; onManage: () => void; onNew: () => void; onChanged: () => void;
}) {
  const toast = useToast();
  const live = orderAlerts((alerts ?? []).filter((a) => a.status === "active" || a.status === "triggered"));
  const triggered = live.filter((a) => a.status === "triggered").length;
  const flight = useInFlight();
  const remove = (a: Alert) => { void flight.run(() => removeAlertWithUndo(slug, a, toast, onChanged)); };
  return (
    <Widget title="Alerty" count={live.length || undefined} controls={<button className="btn sm" onClick={onNew}>+ Nowy</button>} body="tight"
      footer={<><FootFacts items={[<><b>{live.length - triggered}</b> aktywne</>, triggered > 0 && <><b>{triggered}</b> wyzwolone</>]} /><span className="spacer" />
        <button className="lnk" onClick={onManage}>zarządzaj</button></>}>
      {!alerts ? <Skeleton h={120} /> : !live.length ? (
        <div className="empty">Brak aktywnych alertów. Alert to Twój poziom („dokupię poniżej 140 zł"); agent też może je dodawać.</div>
      ) : live.slice(0, 6).map((a) => <AlertRow key={a.id} a={a} onRemove={a.source === "agent" ? () => remove(a) : undefined} />)}
      {live.length > 6 && <div className="muted" style={{ fontSize: 12, paddingTop: 6 }}>i {plural(live.length - 6, "kolejny", "kolejne", "kolejnych")} · <button className="lnk" onClick={onManage}>wszystkie</button></div>}
    </Widget>
  );
}

export function AlertRow({ a, onRemove, compact }: { a: Alert; onRemove?: () => void; compact?: boolean }) {
  const trig = a.status === "triggered";
  const dist = trig ? null : alertDistance(a);
  const now = alertNowText(a);
  const kindWord = a.polarity === "positive" ? "szansa" : a.polarity === "negative" ? "ryzyko" : "neutralny";
  return (
    <div className={`al ${trig ? "trig" : ""}`}>
      <div>
        <div className="t">{compact ? (alertLevelText(a) && (a.kind === "price_below" || a.kind === "price_above") ? `${a.kind === "price_below" ? "poniżej" : "powyżej"} ${alertLevelText(a)}` : a.title) : a.title}{a.source === "agent" && <AgentTag />}</div>
        <div className="c">
          {trig ? <>wyzwolony {dm(a.last_triggered_at)}{now && <> · teraz <b>{now}</b></>}{a.cooldown_days ? ` · cooldown ${a.cooldown_days} dni` : ""}</>
            : compact ? <>{kindWord} · {a.severity === "action" ? "do działania" : "informacja"}{dist ? <> · <b>{dist.text}</b> do poziomu</> : now ? <> · teraz <b>{now}</b></> : ""}</>
            : <>{a.scope === "portfolio" ? "portfel · " : a.scope === "bucket" ? `koszyk · ` : ""}{now ? <>teraz <b>{now}</b> · </> : ""}{kindWord}{alertWhenSuffix(a) ? ` · ${alertWhenSuffix(a)}` : ""}</>}
        </div>
      </div>
      <div className="r">
        {trig ? <span className="tag solid neg">wyzwolony</span>
          : compact ? <AlertStatus status={a.status} />
          : dist ? <span className="dist">{dist.text}{!dist.pp ? " do poziomu" : ""}<span className="bar" aria-hidden><i style={{ width: `${Math.round(dist.fill * 100)}%` }} /></span></span>
          : null}
        {onRemove && <button className="icon-btn" title="Usuń alert agenta" aria-label={`Usuń alert ${a.title}`} onClick={onRemove}>✕</button>}
      </div>
    </div>
  );
}

// ---- manager page ------------------------------------------------------------------------------------------

type StatusFilter = "active" | "triggered" | "snoozed" | "muted" | "all";
type SourceFilter = "all" | "user" | "agent";

export function AlertsManager({ slug, instruments, buckets, digestWeekday, onBack, initial, onChanged }: {
  slug: string;
  instruments: InstrumentChoice[];
  buckets: string[];
  digestWeekday: string;
  onBack: () => void;
  /** `?new=1&instrument=306` or `?edit=12` from the URL. */
  initial: URLSearchParams;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [nonce, setNonce] = useState(0);
  const q = useAsync(() => getAlerts(slug, "all"), [slug, nonce]);
  const hist = useAsync(() => getSignalsV2(slug, "all").catch(() => [] as SignalV2[]), [slug, nonce]);
  const reload = () => { setNonce((n) => n + 1); onChanged(); };
  const [status, setStatus] = useState<StatusFilter>("all");
  const [source, setSource] = useState<SourceFilter>("all");
  const [editing, setEditingState] = useState<number | "new">(() => (initial.get("edit") ? Number(initial.get("edit")) : "new"));
  // A new key per opened form: after a save the "new" form starts empty again.
  const [formKey, setFormKey] = useState(0);
  const setEditing = (v: number | "new") => { setEditingState(v); setFormKey((k) => k + 1); };
  const presetInstrument = initial.get("instrument") ? Number(initial.get("instrument")) : null;
  const all = q.data ?? [];
  const count = (st: string) => all.filter((a) => a.status === st).length;
  const agentCount = all.filter((a) => a.source === "agent").length;
  const list = orderAlerts(all.filter((a) => (status === "all" || a.status === status) && (source === "all" || (source === "agent" ? a.source === "agent" : a.source !== "agent"))));
  const lastCheck = all.map((a) => a.last_checked_at).filter(Boolean).sort().slice(-1)[0] ?? null;
  const agentLive = all.filter((a) => a.source === "agent" && isLive(a)).length;
  const editAlert = typeof editing === "number" ? all.find((a) => a.id === editing) ?? null : null;

  // One mute / delete request at a time (F7 FE2): a double click must not send a second delete.
  const flight = useInFlight();
  const act = (a: Alert, what: "mute" | "unmute" | "delete") => flight.run(async () => {
    try {
      if (what === "delete") {
        if (await removeAlertWithUndo(slug, a, toast, reload) && editing === a.id) setEditing("new");
        return;
      } else {
        await patchAlert(slug, a.id, { status: what === "mute" ? "muted" : "active" });
        toast(what === "mute" ? "Alert wyciszony" : "Alert włączony", 2500);
      }
      reload();
    } catch (e) { toast(`Nie zapisano: ${errorText(e)}`, 5000); }
  });

  return (
    <>
      <nav className="crumb" aria-label="Ścieżka"><button onClick={onBack}>Inwestycje</button> › <span>Alerty</span></nav>
      <div className="pagehead">
        <h2 className="ph">Alerty</h2>
        <Seg quiet label="Status" value={status} onChange={setStatus} items={[
          [`Aktywne · ${count("active")}`, "active"], [`Wyzwolone · ${count("triggered")}`, "triggered"], [`Uśpione · ${count("snoozed")}`, "snoozed"],
          [`Wyciszone · ${count("muted")}`, "muted"], ["Wszystkie", "all"],
        ]} />
        <Seg quiet label="Źródło" value={source} onChange={setSource} items={[["Wszystkie", "all"], ["Moje", "user"], [`Agenta · ${agentCount}`, "agent"]]} />
        <span className="spacer" />
        <span className="muted" style={{ fontSize: 12 }}>sprawdzane codziennie po odświeżeniu cen{lastCheck ? ` · ostatnio ${dm(lastCheck)} ${hm(lastCheck)}` : ""}</span>
      </div>
      <Grid items={[
        {
          id: "list", span: 2, node: (
            <Widget title={null} label="Lista alertów" body="flush"
              footer={<><FootFacts items={[<><b>{all.length}</b> {all.length === 1 ? "alert" : "alertów"}</>, <>limit agenta: <b>{agentLive} z 50</b></>]} />
                <span className="spacer" /><span>wyzwolony alert staje się sygnałem; cooldown i wygaśnięcie wg schematu</span></>}>
              {!q.data ? <div style={{ padding: "0 16px" }}><Skeleton h={160} /></div> : !list.length ? <div className="empty">Brak alertów w tym widoku.</div> : (
                <div className="scroll">
                  <table>
                    <thead><tr><th>Status</th><th>Alert</th><th>Zakres</th><th className="num">Teraz / poziom</th><th>Typ</th><th>Źródło</th><th>Ostatnio</th><th><span className="sr-only">Akcje</span></th></tr></thead>
                    <tbody>
                      {list.map((a) => {
                        const dist = a.status === "triggered" ? null : alertDistance(a);
                        const suffix = alertWhenSuffix(a);
                        return (
                          <tr key={a.id} className={editing === a.id ? "hover" : undefined}>
                            <td><AlertStatus status={a.status} /></td>
                            <td><span className="nm">{a.title}</span><span className="cond">{alertConditionText(a)}{a.note ? ` · ${a.note.length > 48 ? `${a.note.slice(0, 46)}…` : a.note}` : ""}{suffix ? ` · ${suffix}` : ""}</span></td>
                            <td>{a.scope === "portfolio" ? "Portfel" : a.scope === "bucket" ? `Koszyk ${bucketLabel(String(a.params.bucket ?? ""))}` : a.instrument ? instName(a.instrument) : "-"}</td>
                            <td className="num"><b>{alertNowText(a) ?? "-"}</b><span className="cond">{alertLevelText(a) ?? ""}{dist ? ` · ${a.kind.startsWith("price") ? (a.kind === "price_below" ? "-" : "+") : ""}${dist.text}` : ""}</span></td>
                            <td><PolarityText polarity={a.polarity} /><span className="cond">{a.severity === "action" ? "do działania" : "informacja"}</span></td>
                            <td>{a.source === "agent" ? <AgentTag /> : <span className="muted">ty</span>}</td>
                            <td className="muted">{a.last_triggered_at ? dm(a.last_triggered_at) : "-"}</td>
                            <td>
                              <div className="acts">
                                {a.status === "muted"
                                  ? <button className="icon-btn quiet" title="Włącz" aria-label={`Włącz alert ${a.title}`} onClick={() => act(a, "unmute")}>●</button>
                                  : <button className="icon-btn quiet" title="Wycisz" aria-label={`Wycisz alert ${a.title}`} onClick={() => act(a, "mute")} disabled={a.status === "expired"}>◌</button>}
                                <button className="icon-btn quiet" title="Edytuj" aria-label={`Edytuj alert ${a.title}`} onClick={() => setEditing(a.id)}>✎</button>
                                <button className="icon-btn" title="Usuń" aria-label={`Usuń alert ${a.title}`} disabled={flight.busy} onClick={() => act(a, "delete")}>✕</button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Widget>
          ),
        },
        {
          id: "form", span: 1, node: (
            <AlertForm key={`${editing}:${formKey}`} slug={slug} alert={editAlert} instruments={instruments} buckets={buckets} digestWeekday={digestWeekday}
              presetInstrument={editing === "new" && formKey === 0 ? presetInstrument : null}
              onCancel={() => setEditing("new")}
              onSaved={(a, created) => { toast(created ? `Utworzono alert „${a.title}"` : "Zapisano alert", 2500); setEditing("new"); reload(); }} />
          ),
        },
        { id: "history", span: 3, node: <TriggeredHistory signals={hist.data} alerts={all} /> },
      ]} />
    </>
  );
}

// ---- the form (the standardized schema) -------------------------------------------------------------------

type Scope = "instrument" | "portfolio" | "bucket";
type KindCard = "price_above" | "price_below" | "change_pct" | "drawdown_from_high" | "new_high" | "sma_cross" | "weight" | "custom";

/** Static catalog (mirrors alerts/catalog.py) when the server has no /alert-kinds. */
const STATIC_KINDS: Record<string, string[]> = {
  price_above: ["instrument"], price_below: ["instrument"], change_pct: ["instrument"], drawdown_from_high: ["instrument"], new_high: ["instrument"],
  sma_cross: ["instrument"], weight_above: ["instrument", "bucket"], weight_below: ["instrument", "bucket"], custom: ["instrument", "portfolio", "bucket"],
};
const CARDS: { card: KindCard; label: string; machine: string; kinds: string[] }[] = [
  { card: "price_above", label: "Cena powyżej", machine: "price_above", kinds: ["price_above"] },
  { card: "price_below", label: "Cena poniżej", machine: "price_below", kinds: ["price_below"] },
  { card: "change_pct", label: "Zmiana % w oknie", machine: "change_pct", kinds: ["change_pct"] },
  { card: "drawdown_from_high", label: "Spadek od szczytu", machine: "drawdown_from_high", kinds: ["drawdown_from_high"] },
  { card: "new_high", label: "Nowy szczyt", machine: "new_high", kinds: ["new_high"] },
  { card: "sma_cross", label: "Przecięcie SMA", machine: "sma_cross", kinds: ["sma_cross"] },
  { card: "weight", label: "Waga powyżej / poniżej", machine: "weight_above · weight_below", kinds: ["weight_above", "weight_below"] },
  { card: "custom", label: "Własne wyrażenie", machine: "custom", kinds: ["custom"] },
];
const DEFAULT_POLARITY: Record<string, string> = {
  price_below: "positive", price_above: "neutral", change_pct: "negative", drawdown_from_high: "positive", new_high: "neutral",
  sma_cross: "negative", weight_above: "negative", weight_below: "positive", custom: "neutral",
};
const COOLDOWNS: [string, number | null][] = [["bez pauzy", null], ["7 dni", 7], ["14 dni", 14], ["30 dni", 30], ["90 dni", 90]];

function endOfYear(): string { return `${new Date().getFullYear()}-12-31`; }
/** Local calendar day `days` from today (never the UTC date). */
function inDays(days: number): string { return addDays(todayLocal(), days); }

export function AlertForm({ slug, alert, instruments, buckets, digestWeekday, presetInstrument, onCancel, onSaved }: {
  slug: string; alert: Alert | null; instruments: InstrumentChoice[]; buckets: string[]; digestWeekday: string;
  presetInstrument: number | null; onCancel: () => void; onSaved: (a: Alert, created: boolean) => void;
}) {
  const kinds = useAsync(() => getAlertKinds(slug).catch(() => null), [slug]);
  const catalog: Record<string, string[]> = useMemo(() => (kinds.data ? Object.fromEntries(kinds.data.kinds.map((k: AlertKindInfo) => [k.kind, k.scopes])) : STATIC_KINDS), [kinds.data]);
  // The stored values as lossless texts (F7 FE4); `initial` is what the untouched form would build.
  const t0 = useMemo(() => draftText(alert?.params, buckets[0] ?? ""), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [scope, setScope] = useState<Scope>((alert?.scope as Scope) ?? (presetInstrument != null || instruments.length ? "instrument" : "portfolio"));
  const [instId, setInstId] = useState<number | null>(alert?.instrument_id ?? presetInstrument ?? null);
  const inst = instruments.find((i) => i.id === instId) ?? null;
  const [instText, setInstText] = useState(inst ? choiceText(inst) : alert?.instrument?.label ?? "");
  const [bucket, setBucket] = useState<string>(t0.bucket);
  const [card, setCard] = useState<KindCard>(() => (alert ? (alert.kind.startsWith("weight") ? "weight" : (alert.kind as KindCard)) : "price_below"));
  const [above, setAbove] = useState(alert?.kind === "weight_above" || (!alert && false));
  // An edit keeps the stored kind: the direction of a weight alert cannot change by PATCH (F7 FE12).
  const kind = formKind(card, above, alert?.kind ?? null);
  const [level, setLevel] = useState(t0.level);
  const [threshold, setThreshold] = useState(t0.threshold);
  const [windowDays, setWindowDays] = useState(t0.windowDays);
  const [direction, setDirection] = useState<string>(t0.direction);
  const [expression, setExpression] = useState(t0.expression);
  const [polarity, setPolarity] = useState<string>(alert?.polarity ?? DEFAULT_POLARITY[kind] ?? "neutral");
  const polarityTouched = useRef(!!alert);
  const [severity, setSeverity] = useState<string>(alert?.severity ?? "info");
  const [title, setTitle] = useState(alert?.title ?? "");
  // An edited alert whose title is still the generated one keeps following the condition.
  const titleTouched = useRef(!!alert && alert.title !== alertDefaultTitle(alert.kind, alert.params, alert.instrument?.symbol ?? alert.instrument?.label ?? (alert.scope === "bucket" ? bucketLabel(String(alert.params.bucket ?? "")) : "Portfel"), alert.instrument?.currency));
  const [note, setNote] = useState(alert?.note ?? "");
  // "bez pauzy" (null) stays null when editing; 14 days only for a new alert.
  const [cooldown, setCooldown] = useState<number | null>(alert ? alert.cooldown_days : 14);
  const [expiry, setExpiry] = useState<string>(expiryChoice(alert?.expires_at));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLElement>(null);

  // Kind defaults: window and direction per kind, polarity until touched.
  useEffect(() => {
    if (!polarityTouched.current) setPolarity(DEFAULT_POLARITY[kind] ?? "neutral");
    if (!windowDays && (kind === "drawdown_from_high" || kind === "new_high")) setWindowDays("252");
    if (!windowDays && kind === "sma_cross") setWindowDays("200");
    if (!windowDays && kind === "change_pct") setWindowDays("30");
    if (kind === "sma_cross" && direction !== "above" && direction !== "below") setDirection("below");
    if (kind === "change_pct" && !["up", "down", "any"].includes(direction)) setDirection("down");
  }, [kind]); // eslint-disable-line react-hooks/exhaustive-deps

  const cardOk = (c: (typeof CARDS)[number]) => c.kinds.some((k) => (catalog[k] ?? []).includes(scope));
  useEffect(() => {
    const cur = CARDS.find((c) => c.card === card)!;
    if (!cardOk(cur)) setCard((CARDS.find(cardOk)?.card ?? "custom") as KindCard);
  }, [scope]); // eslint-disable-line react-hooks/exhaustive-deps

  const params = buildParams(kind, scope, { level, threshold, windowDays, direction, expression, bucket });
  const subject = scope === "instrument" ? (inst?.symbol ?? inst?.label ?? "") : scope === "bucket" ? bucketLabel(bucket) : "Portfel";
  const problems = validate(kind, scope, params, inst, bucket);
  // The title follows the condition until the owner edits it; nothing to suggest while the condition is incomplete.
  const autoTitle = problems.length ? "" : alertDefaultTitle(kind, params, subject, inst?.currency);
  useEffect(() => { if (!titleTouched.current) setTitle(autoTitle); }, [autoTitle]);
  const nowPrice = inst?.price ?? null;
  const preview = problems.length ? null : alertPreview({ kind, params, subject: inst?.symbol ?? inst?.label ?? subject, currency: inst?.currency, now: kind.startsWith("price") ? nowPrice : null, polarity, severity, cooldown, digestWeekday });

  const save = async () => {
    if (problems.length) { setErr(problems[0]); return; }
    setBusy(true); setErr(null);
    const body: AlertInput = {
      kind, title: title.trim() || alertDefaultTitle(kind, params, subject, inst?.currency), params, scope, instrument_id: scope === "instrument" ? instId : null, polarity, severity,
      note: note.trim() || null, cooldown_days: cooldown, expires_at: expiry ? expiryValue(expiry) : null,
    };
    try {
      if (alert) {
        // Only what the owner changed; untouched values go back exactly as stored (F7 FE4).
        const patch = alertPatch(alert, {
          title: body.title, params, initialParams: buildParams(alert.kind, alert.scope, t0), polarity, severity,
          note: body.note ?? null, cooldown_days: cooldown, expiry,
        });
        onSaved(Object.keys(patch).length ? await patchAlert(slug, alert.id, patch as AlertPatch) : alert, false);
      } else onSaved(await postAlert(slug, body), true);
    } catch (e) {
      const d = describeError(e);
      setErr(d.detail ? `${d.text} (${d.detail})` : d.text);
    } finally { setBusy(false); }
  };
  const pickInstrument = (text: string) => {
    setInstText(text);
    const hit = instruments.find((i) => choiceText(i) === text || i.symbol?.toLowerCase() === text.trim().toLowerCase());
    setInstId(hit?.id ?? null);
  };
  const distNow = inst?.price != null && parseNum(level) != null && inst.price > 0 ? (parseNum(level)! - inst.price) / inst.price : null;
  return (
    <section className="w hl" ref={ref} aria-labelledby="alert-form-h" onKeyDown={(e) => { if (e.key === "Escape" && alert) { e.stopPropagation(); onCancel(); } }}>
      <div className="wh">
        <h3 id="alert-form-h">{alert ? "Edycja alertu" : "Nowy alert"}</h3>
        {alert?.source === "agent" && <AgentTag />}
        <span className="spacer" />
        {alert && <button className="icon-btn quiet" aria-label="Zamknij edycję" title="Zamknij (Esc)" onClick={onCancel}>✕</button>}
      </div>
      <div className="wb tight form">
        <div className="field" title={alert ? "Zakres zmienisz tylko nowym alertem." : undefined}>
          <label id="af-scope">Zakres</label>
          <Seg quiet label="Zakres" value={scope} disabled={!!alert} onChange={(v) => !alert && setScope(v)} items={[["Instrument", "instrument"], ["Portfel", "portfolio"], ["Koszyk", "bucket"]]} />
        </div>
        {scope === "instrument" && (
          <div className="field">
            <label htmlFor="af-inst">Instrument</label>
            <input id="af-inst" list="af-inst-list" value={instText} onChange={(e) => pickInstrument(e.target.value)} disabled={!!alert} placeholder="nazwa lub symbol" autoComplete="off" />
            <datalist id="af-inst-list">{instruments.map((i) => <option key={i.id} value={choiceText(i)} />)}</datalist>
            <span className="sub">posiadane i obserwowane{instruments.length ? "" : " · najpierw dodaj instrument do obserwowanych"}</span>
          </div>
        )}
        {scope === "bucket" && (
          <div className="field">
            <label htmlFor="af-bucket">Koszyk</label>
            <select id="af-bucket" value={bucket} onChange={(e) => setBucket(e.target.value)} disabled={!buckets.length}>
              {!buckets.length && <option value="">brak koszyków w strategii</option>}
              {buckets.map((b) => <option key={b} value={b}>{bucketLabel(b)}</option>)}
            </select>
          </div>
        )}
        <div className="field">
          <label>Warunek</label>
          <div className="kinds" role="radiogroup" aria-label="Warunek">
            {CARDS.map((c) => (
              <button key={c.card} type="button" role="radio" aria-checked={card === c.card} className={`kind ${card === c.card ? "on" : ""}`}
                disabled={!cardOk(c) || (!!alert && !c.kinds.includes(alert.kind) && !(c.card === "weight" && alert.kind.startsWith("weight")))}
                onClick={() => setCard(c.card)}>
                {c.label}<span>{c.machine}</span>
              </button>
            ))}
          </div>
        </div>
        {(kind === "price_above" || kind === "price_below") && (
          <div className="frow">
            <div className="field"><label htmlFor="af-level">Poziom{inst ? ` (${inst.currency})` : ""}</label>
              <input id="af-level" className="num" inputMode="decimal" value={level} onChange={(e) => setLevel(e.target.value)} /></div>
            <div className="field"><label htmlFor="af-now">Teraz</label>
              <input id="af-now" disabled value={inst?.price != null ? `${price(inst.price, inst.currency)}${distNow != null ? ` · ${pct(distNow, true)}` : ""}` : "-"} /></div>
          </div>
        )}
        {(kind === "change_pct" || kind === "drawdown_from_high" || kind === "new_high" || kind === "sma_cross") && (
          <div className="frow">
            <div className="field"><label htmlFor="af-win">Okno (sesje)</label>
              <input id="af-win" className="num" inputMode="numeric" value={windowDays} onChange={(e) => setWindowDays(e.target.value.replace(/\D/g, ""))} /></div>
            {(kind === "change_pct" || kind === "drawdown_from_high") && (
              <div className="field"><label htmlFor="af-th">Próg (%)</label>
                <input id="af-th" className="num" inputMode="decimal" value={threshold} onChange={(e) => setThreshold(e.target.value)} /></div>
            )}
            {kind === "sma_cross" && (
              <div className="field"><label>Kierunek</label>
                <Seg quiet label="Kierunek" value={direction} onChange={setDirection} items={[["w dół", "below"], ["w górę", "above"]]} /></div>
            )}
          </div>
        )}
        {kind === "change_pct" && (
          <div className="field"><label>Kierunek</label>
            <Seg quiet label="Kierunek zmiany" value={direction} onChange={setDirection} items={[["spadek", "down"], ["wzrost", "up"], ["oba", "any"]]} /></div>
        )}
        {card === "weight" && (
          <div className="frow">
            <div className="field"><label>Kierunek</label>
              <Seg quiet label="Kierunek wagi" value={kind === "weight_above" ? "above" : "below"} disabled={!!alert}
                title={alert ? "Kierunek zmienisz tylko nowym alertem." : undefined} onChange={(v) => !alert && setAbove(v === "above")} items={[["powyżej", "above"], ["poniżej", "below"]]} /></div>
            <div className="field"><label htmlFor="af-wth">Próg (% portfela)</label>
              <input id="af-wth" className="num" inputMode="decimal" value={threshold} onChange={(e) => setThreshold(e.target.value)} /></div>
          </div>
        )}
        {kind === "custom" && (
          <div className="field"><label htmlFor="af-expr">Wyrażenie</label>
            <textarea id="af-expr" rows={2} value={expression} onChange={(e) => setExpression(e.target.value)} placeholder={scope === "portfolio" ? "cash_weight < 4%" : "weight > 10%"} />
            <span className="sub">język wyrażeń strategii, np. „weight &gt; 10%", „cash_weight &gt;= 5%"</span></div>
        )}
        <div className="frow">
          <div className="field"><label>Typ</label>
            <Seg quiet label="Typ" value={polarity} onChange={(v) => { polarityTouched.current = true; setPolarity(v); }} items={[["Szansa", "positive"], ["Ryzyko", "negative"], ["Neutralny", "neutral"]]} /></div>
          <div className="field"><label>Waga</label>
            <Seg quiet label="Waga" value={severity} onChange={setSeverity} items={[["Informacja", "info"], ["Do działania", "action"]]} /></div>
        </div>
        <div className="field"><label htmlFor="af-title">Tytuł</label>
          <input id="af-title" value={title} maxLength={120} onChange={(e) => { titleTouched.current = true; setTitle(e.target.value); }} /></div>
        <div className="field"><label htmlFor="af-note">Notatka</label>
          <textarea id="af-note" rows={2} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} placeholder="Dlaczego ten poziom? Trafi obok sygnału." /></div>
        <div className="frow">
          <div className="field"><label htmlFor="af-cool">Cooldown</label>
            <select id="af-cool" value={cooldown ?? ""} onChange={(e) => setCooldown(e.target.value ? Number(e.target.value) : null)}>
              {COOLDOWNS.map(([l, v]) => <option key={l} value={v ?? ""}>{l}</option>)}
              {cooldown != null && !COOLDOWNS.some(([, v]) => v === cooldown) && <option value={cooldown}>{plural(cooldown, "dzień", "dni", "dni")}</option>}
            </select></div>
          <div className="field"><label htmlFor="af-exp">Wygasa</label>
            <select id="af-exp" value={expiry} onChange={(e) => setExpiry(e.target.value)}>
              <option value="">nigdy</option>
              {[inDays(30), inDays(90), endOfYear(), inDays(365)].filter((d, i, a) => a.indexOf(d) === i).map((d) => <option key={d} value={d}>{dmy(d)}</option>)}
              {expiry && ![inDays(30), inDays(90), endOfYear(), inDays(365)].includes(expiry) && <option value={expiry}>{dmy(expiry)}</option>}
            </select></div>
        </div>
        {preview && <div className="preview" aria-live="polite">{preview}</div>}
        {err && <Notice tone="neg">{err}</Notice>}
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button className="btn primary" onClick={save} disabled={busy}>{busy ? "Zapisuję…" : alert ? "Zapisz zmiany" : "Utwórz alert"}</button>
          {alert && <button className="btn" onClick={onCancel}>Anuluj</button>}
          <span className="spacer" style={{ flex: 1 }} />
          <span className="sub">bez prognoz: tylko warunki na danych</span>
        </div>
      </div>
    </section>
  );
}

const choiceText = (i: InstrumentChoice) => [i.label, i.symbol, i.venue].filter(Boolean).join(" · ");

/** Client-side checks before the server's catalog validation (Polish messages). */
export function validate(kind: string, scope: string, params: Record<string, unknown>, inst: InstrumentChoice | null, bucket: string): string[] {
  const out: string[] = [];
  if (scope === "instrument" && !inst) out.push("Wybierz instrument z listy (posiadane i obserwowane).");
  if (scope === "bucket" && !bucket) out.push("Wybierz koszyk.");
  const num = (k: string) => (typeof params[k] === "number" && Number.isFinite(params[k] as number) ? (params[k] as number) : null);
  if ((kind === "price_above" || kind === "price_below") && !(num("level")! > 0)) out.push("Podaj poziom ceny większy od zera.");
  if ("window_days" in params) {
    // The catalog wants at least 2 sessions for drawdown / new high / SMA (alerts/catalog.py), 1 for a change.
    const w = num("window_days"), min = kind === "change_pct" ? 1 : 2;
    if (w == null || w < min || w > 260 || !Number.isInteger(w)) out.push(`Okno: liczba sesji od ${min} do 260.`);
  }
  if (kind === "change_pct" && !(num("threshold")! > 0)) out.push("Podaj próg zmiany w procentach.");
  if (kind === "drawdown_from_high" && !(num("threshold")! > 0 && num("threshold")! < 1)) out.push("Próg spadku: od 0 do 100 %.");
  if ((kind === "weight_above" || kind === "weight_below") && !(num("threshold")! > 0 && num("threshold")! <= 1)) out.push("Próg wagi: od 0 do 100 % portfela.");
  if (kind === "custom" && !String(params.expression ?? "").trim()) out.push("Wpisz wyrażenie.");
  return out;
}

// ---- triggered history ------------------------------------------------------------------------------------

function TriggeredHistory({ signals, alerts }: { signals: SignalV2[] | null; alerts: Alert[] }) {
  const since = Date.now() - 365 * 86400000;
  const rows = (signals ?? []).filter((s) => (s.source === "alert" || s.rule_id.startsWith("alert:")) && parseServerTime(s.first_seen_at) >= since)
    .sort((a, b) => (b.first_seen_at ?? "").localeCompare(a.first_seen_at ?? ""));
  const byId = new Map(alerts.map((a) => [a.id, a]));
  const value = (s: SignalV2) => {
    const p = s.payload, c = typeof p.currency === "string" ? p.currency : undefined;
    if (typeof p.change === "number") return pct(p.change, true);
    if (typeof p.drawdown === "number") return pct(-p.drawdown);
    if (typeof p.weight === "number") return pct(p.weight);
    if (p.close != null) return price(Number(p.close), c);
    return "-";
  };
  const next = (s: SignalV2) => {
    if (s.status === "active") return "sygnał otwarty";
    if (s.status === "acknowledged") return `potwierdzony ${dm(s.acknowledged_at)}`;
    if (s.status === "resolved") return `rozstrzygnięty ${dm(s.closed_at)}`;
    if (s.status === "expired") return `wygasł ${dm(s.closed_at)}`;
    return s.status;
  };
  const decision = (s: SignalV2) => {
    const d = s.decisions[s.decisions.length - 1];
    if (!d) return "-";
    const verb = DECISION_ACTION[d.action] ?? d.action;
    const qty = d.quantity != null && (d.action === "bought" || d.action === "sold") ? ` ${d.quantity}${d.price != null ? ` @ ${price(d.price, d.currency)}` : ""}` : "";
    return `${verb}${qty}${d.reason ? ` · „${d.reason.length > 40 ? `${d.reason.slice(0, 38)}…` : d.reason}"` : ""}`;
  };
  const title = (s: SignalV2) => byId.get(s.alert_id ?? -1)?.title ?? (typeof s.payload.title === "string" ? s.payload.title : s.instrument_label ?? "Alert");
  const exportCsv = () => {
    // Formula prefixes in agent-written titles / reasons are neutralised (csv.ts, F7 FE16).
    const lines = [csvLine(["data", "alert", "wartość", "typ", "źródło", "co dalej", "decyzja"]),
      ...rows.map((s) => csvLine([localDay(s.first_seen_at) ?? "", title(s), value(s), s.polarity ?? "", byId.get(s.alert_id ?? -1)?.source ?? "", next(s), decision(s)]))];
    const url = URL.createObjectURL(new Blob([`﻿${lines.join("\n")}`], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url; a.download = "alerty-historia.csv"; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <Widget title="Historia wyzwoleń" count={`12 mies. · ${rows.length}`} controls={rows.length ? <button className="lnk" onClick={exportCsv}>eksport CSV</button> : undefined} body="flush tight">
      {!signals ? <div style={{ padding: "0 16px" }}><Skeleton h={80} /></div> : !rows.length ? <div className="empty">W ostatnich 12 miesiącach żaden alert się nie wyzwolił.</div> : (
        <div className="scroll">
          <table>
            <thead><tr><th>Data</th><th>Alert</th><th className="num">Wartość</th><th>Typ</th><th>Źródło</th><th>Co dalej</th><th>Decyzja</th></tr></thead>
            <tbody>
              {rows.map((s) => {
                const a = byId.get(s.alert_id ?? -1);
                return (
                  <tr key={s.id}>
                    <td className="tnum">{localDay(s.first_seen_at)}</td>
                    <td>{title(s)}</td>
                    <td className="num">{value(s)}</td>
                    <td><PolarityText polarity={s.polarity ?? "neutral"} /></td>
                    <td>{a?.source === "agent" ? <AgentTag /> : a ? <span className="muted">ty</span> : <span className="muted">usunięty</span>}</td>
                    <td>{next(s)}</td>
                    <td className={s.decisions.length ? undefined : "muted"}>{decision(s)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Widget>
  );
}

export { KIND_LABEL };
