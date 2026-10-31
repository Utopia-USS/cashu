// Alerts (design/v2/alerts.html, ia-v2.md 7; home v3 Q3 / Q5 / Q11 / Q12): the Alerty widget on the investments
// home (waiting conditions only, nearest first, the ring icon of the state and the distance-to-level bar; a met
// alert is a signal and lives in Sygnały) and the alerts manager page (status and source filters, the table, the
// form = the standardized schema, the 12-month triggered history). One schema for the owner and the agent;
// agent items are badged and removable. Alerts are conditions on hard data, never forecasts.
import { useEffect, useMemo, useRef, useState } from "react";
import { C } from "../../../common.strings.ts";
import { inEveryLang } from "../../../i18n.ts";
import { CARD_LABEL, S } from "./Alerts.strings.ts";
import { describeError, errorText } from "../../../core/messages";
import { useAsync, useInFlight } from "../../../hooks";
import { Notice, Seg, Skeleton, useToast } from "../../../ui";
import { AgentTag, AlertIcon, AlertStatus, FootFacts, Grid, PolarityText, Widget } from "../../../widgets";
import { InstLabel } from "./InstLabel";
import { bucketLabel, dm, dmy, DECISION_ACTION, hm, parseNum, pct } from "../labels";
import {
  type Alert, type AlertInput, type AlertKindInfo, type AlertPatch, deleteAlert, getAlertKinds, getAlerts, getSignalsV2, invKey, patchAlert, postAlert, restoreAlert, type SignalV2,
} from "./api";
import {
  alertConditionText, alertDefaultTitle, alertDistance, alertFact, alertLevelText, alertNowText, alertPreview, alertState, alertWhenSuffix, KIND_LABEL, orderAlerts, price,
  ratioX, unnameBuckets,
} from "./logic";
import { alertDeleteUndo, offerUndo, recreateInput } from "./undoFlow";
import { alertPatch, buildParams, draftText, expiryChoice, expiryValue, formKind, validate } from "./alertForm";

export { validate };
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
    toast(S.removeFailed(errorText(e)), 5000);
    return false;
  }
  onChanged();
  // The restore keeps the id, the agent source and the history (BE soft delete). Only a server without the
  // restore endpoint re-creates the alert, which then comes back as a new alert of the owner: say so.
  let recreated = false;
  const u = alertDeleteUndo(() => restoreAlert(slug, a.id), () => { recreated = true; return postAlert(slug, recreateInput(a) as AlertInput); });
  offerUndo(toast, S.removed(a.title), u, S.removeWhat, onChanged, 10000,
    () => (recreated ? (a.source === "agent" ? S.backAsYourNew : S.backAsNew) : null));
  return true;
}

// ---- widget on the home ------------------------------------------------------------------------------------


/** An alert as a row: the state icon + title (+ agent badge), `teraz <b>now</b>`, the distance to the level with
 * its bar (home); `compact` (the asset page): the condition, `od d.m · teraz now` when met, else the distance. */
export function AlertRow({ a, onRemove, compact, near }: { a: Alert; onRemove?: () => void; compact?: boolean; near?: { pricePct?: number | null; pp?: number | null } | null }) {
  const trig = a.status === "triggered";
  const liveA = trig || a.status === "active";
  const dist = trig ? null : alertDistance(a);
  const level = dist?.level ?? alertLevelText(a);
  const now = alertNowText(a);
  const icon = liveA ? <AlertIcon state={alertState(a, near)} title={alertFact(a)} /> : null;
  const cond = compact && level && (a.kind === "price_below" || a.kind === "price_above") ? `${a.kind === "price_below" ? S.below : S.above} ${level}` : unnameBuckets(a.title);
  const suffix = alertWhenSuffix(a);
  return (
    <div className={`al ${trig ? "trig" : ""}`}>
      <div>
        <div className="t"><span className="ttl">{icon}{cond}</span>{a.source === "agent" && <AgentTag />}</div>
        <div className="c">
          {trig ? <>{S.since} {dm(a.last_triggered_at)}{now && <> · {S.now} <b>{now}</b></>}</>
            : compact ? <>{now ? <>{S.now} <b>{now}</b></> : alertConditionText(a)}{dist && level ? <> · <b>{dist.text}</b> {S.to} {level}</> : ""}</>
            : <>{a.scope === "portfolio" ? S.portfolioPrefix : a.scope === "bucket" ? S.bucketPrefix : ""}{now ? <>{S.now} <b>{now}</b></> : alertConditionText(a)}
              {a.kind === "volume_spike" ? S.avgOfSessions(Number(a.params.window_days ?? 20)) : ""}{suffix ? ` · ${suffix}` : ""}</>}
        </div>
      </div>
      <div className="r">
        {compact ? (!liveA && <AlertStatus status={a.status} />)
          : dist && level ? <span className="dist">{dist.text} {S.to} {level}<span className="bar" aria-hidden><i style={{ width: `${Math.round(dist.fill * 100)}%` }} /></span></span>
          : null}
        {onRemove && <button className="icon-btn" title={S.removeAgentAlert} aria-label={S.removeAria(a.title)} onClick={onRemove}>✕</button>}
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
  // Keyed (F7 PX4); `reload` goes through onChanged (the home's reload forgets the cached investments views).
  const q = useAsync(() => getAlerts(slug, "all"), [slug, nonce], { key: invKey(slug, "alerts", "all") });
  const hist = useAsync(() => getSignalsV2(slug, "all"), [slug, nonce], { key: invKey(slug, "signals", "all") });
  // History that never loaded reads as empty (the old fallback); a failed refresh keeps it.
  const histList: SignalV2[] | null = hist.data ?? (hist.error ? [] : null);
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
        toast(what === "mute" ? S.muted : S.unmuted, 2500);
      }
      reload();
    } catch (e) { toast(S.saveFailed(errorText(e)), 5000); }
  });

  return (
    <>
      <nav className="crumb" aria-label={S.breadcrumb}><button onClick={onBack}>{S.investments}</button> › <span>{S.alerts}</span></nav>
      <div className="pagehead">
        <h2 className="ph">{S.alerts}</h2>
        <Seg quiet label={S.status} value={status} onChange={setStatus} items={[
          [S.waitingN(count("active")), "active"], [S.metN(count("triggered")), "triggered"], [S.snoozedN(count("snoozed")), "snoozed"],
          [S.mutedN(count("muted")), "muted"], [S.all, "all"],
        ]} />
        <Seg quiet label={S.source} value={source} onChange={setSource} items={[[S.all, "all"], [S.mine, "user"], [S.agentN(agentCount), "agent"]]} />
        <span className="spacer" />
        <span className="muted" style={{ fontSize: 12 }}>{lastCheck ? S.checked(dm(lastCheck), hm(lastCheck)) : ""}</span>
      </div>
      <Grid items={[
        {
          id: "list", span: 2, node: (
            <Widget title={null} label={S.listLabel} body="flush"
              footer={<><FootFacts items={[<><b>{all.length}</b> {S.alertsWord(all.length)}</>, <>{S.agentLimit} <b>{S.xOf50(agentLive)}</b></>]} />
</>}>
              {!q.data ? <div style={{ padding: "0 16px" }}><Skeleton h={160} /></div> : !list.length ? <div className="empty">{S.noAlerts}</div> : (
                <div className="scroll">
                  <table>
                    <thead><tr><th>{S.status}</th><th>{S.colAlert}</th><th>{S.colScope}</th><th className="num">{S.colNowLevel}</th><th>{S.colType}</th><th>{S.colSource}</th><th>{S.colLast}</th><th><span className="sr-only">{S.colActions}</span></th></tr></thead>
                    <tbody>
                      {list.map((a) => {
                        const dist = a.status === "triggered" ? null : alertDistance(a);
                        const suffix = alertWhenSuffix(a);
                        return (
                          <tr key={a.id} className={editing === a.id ? "hover" : undefined}>
                            <td>{a.status === "active" || a.status === "triggered" ? <AlertIcon state={alertState(a)} title={alertFact(a)} /> : <AlertStatus status={a.status} />}</td>
                            <td><span className="nm">{unnameBuckets(a.title)}</span><span className="cond">{alertConditionText(a)}{a.note ? ` · ${a.note.length > 48 ? `${a.note.slice(0, 46)}…` : a.note}` : ""}{suffix ? ` · ${suffix}` : ""}{a.status === "triggered" && a.cooldown_days ? S.pause(a.cooldown_days) : ""}</span></td>
                            <td>{a.scope === "portfolio" ? S.portfolio : a.scope === "bucket" ? [S.bucket, bucketLabel(String(a.params.bucket ?? ""))].filter(Boolean).join(" ") : a.instrument ? <InstLabel density="inline" inst={a.instrument} /> : "-"}</td>
                            <td className="num"><b>{alertNowText(a) ?? "-"}</b><span className="cond">{alertLevelText(a) ?? ""}{dist ? ` · ${a.kind.startsWith("price") ? (a.kind === "price_below" ? "-" : "+") : ""}${dist.text}` : ""}</span></td>
                            <td><PolarityText polarity={a.polarity} /><span className="cond">{a.severity === "action" ? S.severityAction : S.severityInfo}</span></td>
                            <td>{a.source === "agent" ? <AgentTag /> : <span className="muted">{S.you}</span>}</td>
                            <td className="muted">{a.last_triggered_at ? dm(a.last_triggered_at) : "-"}</td>
                            <td>
                              <div className="acts">
                                {a.status === "muted"
                                  ? <button className="icon-btn quiet" title={S.turnOn} aria-label={S.turnOnAria(a.title)} onClick={() => act(a, "unmute")}>●</button>
                                  : <button className="icon-btn quiet" title={S.mute} aria-label={S.muteAria(a.title)} onClick={() => act(a, "mute")} disabled={a.status === "expired"}>◌</button>}
                                <button className="icon-btn quiet" title={C.edit} aria-label={S.editAria(a.title)} onClick={() => setEditing(a.id)}>✎</button>
                                <button className="icon-btn" title={C.remove} aria-label={S.removeAria(a.title)} disabled={flight.busy} onClick={() => act(a, "delete")}>✕</button>
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
              onSaved={(a, created) => { toast(created ? S.created(a.title) : S.savedAlert, 2500); setEditing("new"); reload(); }} />
          ),
        },
        { id: "history", span: 3, node: <TriggeredHistory signals={histList} alerts={all} /> },
      ]} />
    </>
  );
}

// ---- the form (the standardized schema) -------------------------------------------------------------------

type Scope = "instrument" | "portfolio" | "bucket";
type KindCard = "price_above" | "price_below" | "change_pct" | "drawdown_from_high" | "new_high" | "sma_cross" | "range_breakout" | "volume_spike" | "weight" | "custom";

/** Static catalog (mirrors alerts/catalog.py) when the server has no /alert-kinds. */
const STATIC_KINDS: Record<string, string[]> = {
  price_above: ["instrument"], price_below: ["instrument"], change_pct: ["instrument"], drawdown_from_high: ["instrument"], new_high: ["instrument"],
  sma_cross: ["instrument"], weight_above: ["instrument", "bucket"], weight_below: ["instrument", "bucket"], custom: ["instrument", "portfolio", "bucket"],
  range_breakout: ["instrument"], volume_spike: ["instrument"],
};
const CARDS: { card: KindCard; machine: string; kinds: string[] }[] = [
  { card: "price_above", machine: "price_above", kinds: ["price_above"] },
  { card: "price_below", machine: "price_below", kinds: ["price_below"] },
  { card: "change_pct", machine: "change_pct", kinds: ["change_pct"] },
  { card: "drawdown_from_high", machine: "drawdown_from_high", kinds: ["drawdown_from_high"] },
  { card: "new_high", machine: "new_high", kinds: ["new_high"] },
  { card: "sma_cross", machine: "sma_cross", kinds: ["sma_cross"] },
  { card: "range_breakout", machine: "range_breakout", kinds: ["range_breakout"] },
  { card: "volume_spike", machine: "volume_spike", kinds: ["volume_spike"] },
  { card: "weight", machine: "weight_above · weight_below", kinds: ["weight_above", "weight_below"] },
  { card: "custom", machine: "custom", kinds: ["custom"] },
];
const DEFAULT_POLARITY: Record<string, string> = {
  price_below: "positive", price_above: "neutral", change_pct: "negative", drawdown_from_high: "positive", new_high: "neutral",
  sma_cross: "negative", weight_above: "negative", weight_below: "positive", custom: "neutral",
  range_breakout: "neutral", volume_spike: "neutral",
};
/** A breakout's polarity follows its direction until the owner picks one: up = chance, down = risk. */
const breakoutPolarity = (direction: string) => (direction === "up" ? "positive" : direction === "down" ? "negative" : "neutral");
const COOLDOWNS: (number | null)[] = [null, 7, 14, 30, 90];
const cooldownLabel = (v: number | null) => (v == null ? S.noPause : S.days(v));

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
  const [rangePct, setRangePct] = useState(t0.rangePct ?? "");
  const [multiple, setMultiple] = useState(t0.multiple ?? "");
  const [polarity, setPolarity] = useState<string>(alert?.polarity ?? DEFAULT_POLARITY[kind] ?? "neutral");
  const polarityTouched = useRef(!!alert);
  const [severity, setSeverity] = useState<string>(alert?.severity ?? "info");
  const [title, setTitle] = useState(alert?.title ?? "");
  // An edited alert whose title is still the generated one keeps following the condition. Either language counts: the title may have been generated before a language switch.
  const titleTouched = useRef(!!alert && !inEveryLang(() => alertDefaultTitle(alert.kind, alert.params, alert.instrument?.symbol ?? alert.instrument?.label ?? (alert.scope === "bucket" ? bucketLabel(String(alert.params.bucket ?? "")) ?? S.bucket : S.portfolio), alert.instrument?.currency)).includes(alert.title));
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
    if (kind === "range_breakout") {
      if (!windowDays) setWindowDays("30");
      if (!rangePct) setRangePct("8");
      // A direction picked on another card does not carry over: `oba` unless the stored alert has one (FE-8).
      const stored = alert?.kind === "range_breakout" ? String(alert.params.direction ?? "any") : "any";
      setDirection(["up", "down", "any"].includes(stored) ? stored : "any");
    }
    if (kind === "volume_spike") {
      if (!windowDays) setWindowDays("20");
      if (!multiple) setMultiple(S.defaultMultiple);
    }
  }, [kind]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (kind === "range_breakout" && !polarityTouched.current) setPolarity(breakoutPolarity(direction)); }, [kind, direction]);

  const cardOk = (c: (typeof CARDS)[number]) => c.kinds.some((k) => (catalog[k] ?? []).includes(scope));
  useEffect(() => {
    const cur = CARDS.find((c) => c.card === card)!;
    if (!cardOk(cur)) setCard((CARDS.find(cardOk)?.card ?? "custom") as KindCard);
  }, [scope]); // eslint-disable-line react-hooks/exhaustive-deps

  const params = buildParams(kind, scope, { level, threshold, windowDays, direction, expression, bucket, rangePct, multiple });
  const subject = scope === "instrument" ? (inst?.symbol ?? inst?.label ?? "") : scope === "bucket" ? bucketLabel(bucket) ?? S.bucket : S.portfolio;
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
        <h3 id="alert-form-h">{alert ? S.editTitle : S.newTitle}</h3>
        {alert?.source === "agent" && <AgentTag />}
        <span className="spacer" />
        {alert && <button className="icon-btn quiet" aria-label={S.closeEdit} title={S.closeEsc} onClick={onCancel}>✕</button>}
      </div>
      <div className="wb tight form">
        <div className="field" title={alert ? S.scopeNewOnly : undefined}>
          <label id="af-scope">{S.colScope}</label>
          <Seg quiet label={S.colScope} value={scope} disabled={!!alert} onChange={(v) => !alert && setScope(v)} items={[[S.scopeInstrument, "instrument"], [S.portfolio, "portfolio"], ...(buckets.length || alert?.scope === "bucket" ? [[S.bucket, "bucket"] as [string, Scope]] : [])]} />
        </div>
        {scope === "instrument" && (
          <div className="field">
            <label htmlFor="af-inst">{S.scopeInstrument}</label>
            <input id="af-inst" list="af-inst-list" value={instText} onChange={(e) => pickInstrument(e.target.value)} disabled={!!alert} placeholder={S.instPlaceholder} autoComplete="off" />
            <datalist id="af-inst-list">{instruments.map((i) => <option key={i.id} value={choiceText(i)} />)}</datalist>
            {!instruments.length && <span className="sub">{S.watchFirst}</span>}
          </div>
        )}
        {scope === "bucket" && (
          <div className="field">
            <label htmlFor="af-bucket">{S.bucket}</label>
            {/* Generic buckets only (F7-generic); an agent's alert on the owner's own bucket keeps it, unnamed. */}
            <select id="af-bucket" value={bucket} onChange={(e) => setBucket(e.target.value)} disabled={!buckets.length || (!!bucket && !bucketLabel(bucket))}>
              {!buckets.length && !bucket && <option value="">{S.noBuckets}</option>}
              {!!bucket && !bucketLabel(bucket) && <option value={bucket}>-</option>}
              {buckets.map((b) => <option key={b} value={b}>{bucketLabel(b)}</option>)}
            </select>
          </div>
        )}
        <div className="field">
          <label>{S.condition}</label>
          <div className="kinds" role="radiogroup" aria-label={S.condition}>
            {CARDS.map((c) => (
              <button key={c.card} type="button" role="radio" aria-checked={card === c.card} className={`kind ${card === c.card ? "on" : ""}`}
                disabled={!cardOk(c) || (!!alert && !c.kinds.includes(alert.kind) && !(c.card === "weight" && alert.kind.startsWith("weight")))}
                onClick={() => setCard(c.card)}>
                {CARD_LABEL[c.card]}<span>{c.machine}</span>
              </button>
            ))}
          </div>
        </div>
        {(kind === "price_above" || kind === "price_below") && (
          <div className="frow">
            <div className="field"><label htmlFor="af-level">{S.level}{inst ? ` (${inst.currency})` : ""}</label>
              <input id="af-level" className="num" inputMode="decimal" value={level} onChange={(e) => setLevel(e.target.value)} /></div>
            <div className="field"><label htmlFor="af-now">{S.nowLabel}</label>
              <input id="af-now" disabled value={inst?.price != null ? `${price(inst.price, inst.currency)}${distNow != null ? ` · ${pct(distNow, true)}` : ""}` : "-"} /></div>
          </div>
        )}
        {(kind === "change_pct" || kind === "drawdown_from_high" || kind === "new_high" || kind === "sma_cross") && (
          <div className="frow">
            <div className="field"><label htmlFor="af-win">{S.window}</label>
              <input id="af-win" className="num" inputMode="numeric" value={windowDays} onChange={(e) => setWindowDays(e.target.value.replace(/\D/g, ""))} /></div>
            {(kind === "change_pct" || kind === "drawdown_from_high") && (
              <div className="field"><label htmlFor="af-th">{S.thresholdPct}</label>
                <input id="af-th" className="num" inputMode="decimal" value={threshold} onChange={(e) => setThreshold(e.target.value)} /></div>
            )}
            {kind === "sma_cross" && (
              <div className="field"><label>{S.direction}</label>
                <Seg quiet label={S.direction} value={direction} onChange={setDirection} items={[[S.down, "below"], [S.up, "above"]]} /></div>
            )}
          </div>
        )}
        {(kind === "range_breakout" || kind === "volume_spike") && (
          <div className="frow">
            <div className="field"><label htmlFor="af-win">{S.window}</label>
              <input id="af-win" className="num" inputMode="numeric" value={windowDays} onChange={(e) => setWindowDays(e.target.value.replace(/\D/g, ""))} /></div>
            {kind === "range_breakout" ? (
              <div className="field"><label htmlFor="af-range">{S.maxRange}</label>
                <input id="af-range" className="num" inputMode="decimal" value={rangePct} onChange={(e) => setRangePct(e.target.value)} /></div>
            ) : (
              <div className="field"><label htmlFor="af-mult">{S.multiple}</label>
                <input id="af-mult" className="num" inputMode="decimal" value={multiple} onChange={(e) => setMultiple(e.target.value)} /></div>
            )}
          </div>
        )}
        {kind === "range_breakout" && (
          <div className="field"><label>{S.direction}</label>
            <Seg quiet label={S.breakoutDirection} value={direction} onChange={setDirection} items={[[S.up, "up"], [S.down, "down"], [S.both, "any"]]} /></div>
        )}
        {kind === "change_pct" && (
          <div className="field"><label>{S.direction}</label>
            <Seg quiet label={S.changeDirection} value={direction} onChange={setDirection} items={[[S.fall, "down"], [S.rise, "up"], [S.both, "any"]]} /></div>
        )}
        {card === "weight" && (
          <div className="frow">
            <div className="field"><label>{S.direction}</label>
              <Seg quiet label={S.weightDirection} value={kind === "weight_above" ? "above" : "below"} disabled={!!alert}
                title={alert ? S.directionNewOnly : undefined} onChange={(v) => !alert && setAbove(v === "above")} items={[[S.above, "above"], [S.below, "below"]]} /></div>
            <div className="field"><label htmlFor="af-wth">{S.thresholdPortfolio}</label>
              <input id="af-wth" className="num" inputMode="decimal" value={threshold} onChange={(e) => setThreshold(e.target.value)} /></div>
          </div>
        )}
        {kind === "custom" && (
          <div className="field"><label htmlFor="af-expr">{S.expression}</label>
            <textarea id="af-expr" rows={2} value={expression} onChange={(e) => setExpression(e.target.value)} placeholder={scope === "portfolio" ? "cash_weight < 4%" : "weight > 10%"} /></div>
        )}
        <div className="frow">
          <div className="field"><label>{S.type}</label>
            <Seg quiet label={S.type} value={polarity} onChange={(v) => { polarityTouched.current = true; setPolarity(v); }} items={[[S.chance, "positive"], [S.risk, "negative"], [S.neutral, "neutral"]]} /></div>
          <div className="field"><label>{S.severity}</label>
            <Seg quiet label={S.severity} value={severity} onChange={setSeverity} items={[[S.info, "info"], [S.action, "action"]]} /></div>
        </div>
        <div className="field"><label htmlFor="af-title">{S.title}</label>
          <input id="af-title" value={title} maxLength={120} onChange={(e) => { titleTouched.current = true; setTitle(e.target.value); }} /></div>
        <div className="field"><label htmlFor="af-note">{S.note}</label>
          <textarea id="af-note" rows={2} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} placeholder={S.notePlaceholder} /></div>
        <div className="frow">
          <div className="field"><label htmlFor="af-cool">{S.cooldown}</label>
            <select id="af-cool" value={cooldown ?? ""} onChange={(e) => setCooldown(e.target.value ? Number(e.target.value) : null)}>
              {COOLDOWNS.map((v) => <option key={v ?? ""} value={v ?? ""}>{cooldownLabel(v)}</option>)}
              {cooldown != null && !COOLDOWNS.includes(cooldown) && <option value={cooldown}>{S.days(cooldown)}</option>}
            </select></div>
          <div className="field"><label htmlFor="af-exp">{S.expires}</label>
            <select id="af-exp" value={expiry} onChange={(e) => setExpiry(e.target.value)}>
              <option value="">{S.never}</option>
              {[inDays(30), inDays(90), endOfYear(), inDays(365)].filter((d, i, a) => a.indexOf(d) === i).map((d) => <option key={d} value={d}>{dmy(d)}</option>)}
              {expiry && ![inDays(30), inDays(90), endOfYear(), inDays(365)].includes(expiry) && <option value={expiry}>{dmy(expiry)}</option>}
            </select></div>
        </div>
        {preview && <div className="preview" aria-live="polite">{preview}</div>}
        {err && <Notice tone="neg">{err}</Notice>}
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button className="btn primary" onClick={save} disabled={busy}>{busy ? S.saving : alert ? C.save : S.create}</button>
          {alert && <button className="btn" onClick={onCancel}>{C.cancel}</button>}
          <span className="spacer" style={{ flex: 1 }} />
          <span className="sub">{S.noForecasts}</span>
        </div>
      </div>
    </section>
  );
}

const choiceText = (i: InstrumentChoice) => [i.label, i.symbol, i.venue].filter(Boolean).join(" · ");

// ---- triggered history ------------------------------------------------------------------------------------

function TriggeredHistory({ signals, alerts }: { signals: SignalV2[] | null; alerts: Alert[] }) {
  const since = Date.now() - 365 * 86400000;
  const rows = (signals ?? []).filter((s) => (s.source === "alert" || s.rule_id.startsWith("alert:")) && parseServerTime(s.first_seen_at) >= since)
    .sort((a, b) => (b.first_seen_at ?? "").localeCompare(a.first_seen_at ?? ""));
  const byId = new Map(alerts.map((a) => [a.id, a]));
  const value = (s: SignalV2) => {
    const p = s.payload, c = typeof p.currency === "string" ? p.currency : undefined;
    if (typeof p.ratio === "number" || (typeof p.ratio === "string" && p.ratio)) return ratioX(Number(p.ratio));
    if (typeof p.breakout_pct === "number") return pct(p.breakout_pct, true);
    if (typeof p.change === "number") return pct(p.change, true);
    if (typeof p.drawdown === "number") return pct(-p.drawdown);
    if (typeof p.weight === "number") return pct(p.weight);
    if (p.close != null) return price(Number(p.close), c);
    return "-";
  };
  const next = (s: SignalV2) => {
    if (s.status === "active") return S.signalOpen;
    if (s.status === "acknowledged") return S.acknowledged(dm(s.acknowledged_at));
    if (s.status === "resolved") return S.resolved(dm(s.closed_at));
    if (s.status === "expired") return S.expired(dm(s.closed_at));
    return s.status;
  };
  const decision = (s: SignalV2) => {
    const d = s.decisions[s.decisions.length - 1];
    if (!d) return "-";
    const verb = DECISION_ACTION[d.action] ?? d.action;
    const qty = d.quantity != null && (d.action === "bought" || d.action === "sold") ? ` ${d.quantity}${d.price != null ? ` @ ${price(d.price, d.currency)}` : ""}` : "";
    return `${verb}${qty}${d.reason ? S.reasonQuoted(d.reason.length > 40 ? `${d.reason.slice(0, 38)}…` : d.reason) : ""}`;
  };
  const title = (s: SignalV2) => byId.get(s.alert_id ?? -1)?.title ?? (typeof s.payload.title === "string" ? s.payload.title : s.instrument_label ?? S.alert);
  const exportCsv = () => {
    // Formula prefixes in agent-written titles / reasons are neutralised (csv.ts, F7 FE16).
    const lines = [csvLine(S.csvHeader),
      ...rows.map((s) => csvLine([localDay(s.first_seen_at) ?? "", title(s), value(s), s.polarity ?? "", byId.get(s.alert_id ?? -1)?.source ?? "", next(s), decision(s)]))];
    const url = URL.createObjectURL(new Blob([`﻿${lines.join("\n")}`], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url; a.download = S.csvFile; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <Widget title={S.history} count={S.historyCount(rows.length)} controls={rows.length ? <button className="lnk" onClick={exportCsv}>{S.exportCsv}</button> : undefined} body="flush tight">
      {!signals ? <div style={{ padding: "0 16px" }}><Skeleton h={80} /></div> : !rows.length ? <div className="empty">{S.noneMet}</div> : (
        <div className="scroll">
          <table>
            <thead><tr><th>{S.colDate}</th><th>{S.colAlert}</th><th className="num">{S.colValue}</th><th>{S.colType}</th><th>{S.colSource}</th><th>{S.colNext}</th><th>{S.colDecision}</th></tr></thead>
            <tbody>
              {rows.map((s) => {
                const a = byId.get(s.alert_id ?? -1);
                return (
                  <tr key={s.id}>
                    <td className="tnum">{localDay(s.first_seen_at)}</td>
                    <td>{title(s)}</td>
                    <td className="num">{value(s)}</td>
                    <td><PolarityText polarity={s.polarity ?? "neutral"} /></td>
                    <td>{a?.source === "agent" ? <AgentTag /> : a ? <span className="muted">{S.you}</span> : <span className="muted">{S.deleted}</span>}</td>
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
