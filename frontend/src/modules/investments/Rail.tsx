// The rail is the to-do list: signals with the decision form in place, instruments to classify
// (inline), data warnings. Only one decision form is open at a time; Esc collapses it.
import { useEffect, useMemo, useRef, useState } from "react";
import { useAsync } from "../../hooks";
import { copyText, Seg, Tag, useToast } from "../../ui";
import {
  type AccountRow, type BucketMatch, type BucketRow, type Decision, type DecisionInput, getPositionDetail, type Instrument, type Position,
  type Signal, type StrategyStatus,
} from "./api";
import {
  accountLabel, ASSET_CLASS, bucketLabel, dm, dmy, money, numInput, parseNum, pct, plural, qty, REGION, region as regionLabel, VALUATION,
} from "./labels";
import {
  decisionEffect, decisionTag, nextDeposit, signalFacts, signalInstrument, signalTitle, signalTone, type WarningItem,
} from "./logic";
import { canUndo } from "./undo";

type Act = "none" | "buy" | "sell" | "later";
const ACTION: Record<Act, string> = { none: "held", buy: "bought", sell: "sold", later: "other" };

export interface SignalsProps {
  signals: Signal[];
  openId: number | null;
  cursorId: number | null;
  highlight: boolean;
  positions: Position[];
  buckets: BucketRow[];
  total: number;
  base: string;
  accounts: AccountRow[];
  today: string;
  contributionDay: number | null;
  slug: string;
  onToggle: (id: number | null) => void;
  onDecide: (s: Signal, input: DecisionInput, label: string) => void;
  onAck: (s: Signal, reason?: string) => void;
  /** Undo a saved decision within 15 minutes (F5 R4); the link shows on the decided signal. */
  onUndo?: (s: Signal, d: Decision) => void;
  onHistory: () => void;
}

export function SignalsCard(props: SignalsProps) {
  const { signals, highlight } = props;
  const open = signals.filter((s) => !s.decisions.length);
  const action = open.filter((s) => s.severity === "action").length;
  const review = open.length - action;
  return (
    <section className={`card signals ${highlight ? "hl" : ""}`} id="inv-signals" aria-label="Do decyzji">
      <div className="controls" style={{ marginBottom: 4 }}>
        <h2 style={{ margin: 0 }}>Do decyzji</h2>
        {action > 0 && <Tag tone="neg">{action} do działania</Tag>}
        {review > 0 && <Tag>{review} do przeglądu</Tag>}
        {!open.length && signals.length > 0 && <Tag tone="pos">wszystko rozstrzygnięte</Tag>}
      </div>
      {!signals.length && (
        <div className="muted" style={{ fontSize: 13, padding: "6px 0" }}>Brak otwartych sygnałów. Reguły sprawdzają portfel przy każdym przebiegu.</div>
      )}
      {signals.map((s) => <SignalItem key={s.id} s={s} {...props} />)}
      <div className="controls" style={{ margin: "10px 0 0", paddingTop: 8, borderTop: "1px solid var(--border)" }}>
        <button className="lnk" style={{ fontSize: 12 }} onClick={props.onHistory}>historia sygnałów i dziennik decyzji</button>
      </div>
    </section>
  );
}

function SignalItem({ s, openId, cursorId, onToggle, onAck, onUndo, today, contributionDay, base, ...rest }: SignalsProps & { s: Signal }) {
  const tone = signalTone(s);
  const facts = signalFacts(s, base);
  const inst = signalInstrument(s);
  const decided = s.decisions[s.decisions.length - 1];
  const isOpen = openId === s.id && !decided;
  const isNew = s.status === "active" && !!s.first_seen_at && daysAgo(s.first_seen_at, today) <= 7;
  const later = nextDeposit(today, contributionDay);
  return (
    <div className={`signal ${isOpen ? "open" : ""} ${cursorId === s.id ? "cur" : ""} ${decided ? "done" : ""}`} data-signal={s.id}>
      <div className="sh">
        <span className={`sev ${decided ? "resolved" : tone}`} aria-hidden />
        <span className="grow">{signalTitle(s)}</span>
        {decided ? <Tag tone="pos">{decisionTag(decided)}</Tag>
          : <Tag tone={tone === "action" ? "neg" : "warn"}>{tone === "action" ? "do działania" : "do przeglądu"}</Tag>}
        {decided && onUndo && canUndo(decided) && (
          <button className="lnk" style={{ fontSize: 12 }} title="Decyzję można cofnąć przez 15 minut od zapisu" onClick={() => onUndo(s, decided)}>cofnij</button>
        )}
        {isNew && !decided && <Tag tone="info">nowy</Tag>}
      </div>
      <div className="sm">
        {inst && s.kind !== "position_concentration" && <span>{inst}</span>}
        {facts.measured && (
          <span>{s.kind === "contribution_gap" ? <b>{facts.measured}</b> : <>zmierzono <b>{facts.measured}</b></>}{facts.limit ? ` · ${facts.limit}` : ""}</span>
        )}
        {!facts.measured && s.kind === "custom" && <span>{s.message}</span>}
        <span>od {dm(s.first_seen_at)}</span>
        {facts.extra && <span>{facts.extra}</span>}
        <span>reguła {s.rule_id}</span>
      </div>
      {isOpen ? (
        <DecisionForm s={s} positions={rest.positions} buckets={rest.buckets} total={rest.total} accounts={rest.accounts} slug={rest.slug}
          onDecide={rest.onDecide} base={base} onCollapse={() => onToggle(null)} onAck={(reason) => onAck(s, reason)} />
      ) : !decided && (
        <div className="sm" style={{ marginTop: 6 }}>
          <button className="btn" onClick={() => onToggle(s.id)}>Zanotuj decyzję</button>
          <button className="btn" onClick={() => onAck(s)}>Potwierdź</button>
          {s.kind === "contribution_gap" && <button className="btn" onClick={() => onAck(s, `odłożone do ${later}`)}>Odłóż do {dm(later)}</button>}
        </div>
      )}
    </div>
  );
}

const daysAgo = (iso: string, today: string) => Math.round((new Date(`${today}T12:00:00`).getTime() - new Date(iso).getTime()) / 86400000);

function defaultAct(s: Signal): Act {
  switch (s.kind) {
    case "drawdown_from_high": case "loss_from_cost": return "buy";
    case "gain_from_cost": case "position_concentration": return "sell";
    case "allocation_drift": return Number(s.payload.drift_pp) > 0 ? "sell" : "buy";
    default: return "none";
  }
}

function DecisionForm({ s, positions, buckets, total, base, accounts, slug, onDecide, onAck, onCollapse }:
  Pick<SignalsProps, "positions" | "buckets" | "total" | "base" | "accounts" | "slug" | "onDecide"> & {
  s: Signal; onCollapse: () => void; onAck: (reason?: string) => void;
}) {
  const pos = s.instrument_id != null ? positions.find((p) => String(p.instrument.id) === String(s.instrument_id)) ?? null : null;
  const [act, setAct] = useState<Act>(() => defaultAct(s));
  const [q, setQ] = useState(() => {
    if (!pos || !pos.price) return "";
    if (s.kind === "position_concentration") {
      const over = (Number(s.payload.weight) - Number(s.payload.max_weight)) * total;
      return over > 0 ? String(Math.max(1, Math.ceil(over / pos.price))) : "";
    }
    return s.kind === "drawdown_from_high" || s.kind === "loss_from_cost" ? String(Math.max(1, Math.round(pos.quantity / 3))) : "";
  });
  const [price, setPrice] = useState(() => numInput(pos?.price ?? null));
  const held = pos ? pos.accounts.map((a) => a.account_id) : [];
  const [acc, setAcc] = useState<number | null>(held[0] ?? accounts[0]?.id ?? null);
  const [reason, setReason] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.querySelector<HTMLElement>(".seg button.on")?.focus(); }, []);
  const detail = useAsync(() => (pos ? getPositionDetail(slug, pos.instrument.id) : Promise.resolve(null)), [slug, pos?.instrument.id]);
  const thesis = detail.data?.theses[detail.data.theses.length - 1] ?? null;
  const trade = act === "buy" || act === "sell";
  const qn = parseNum(q), pn = parseNum(price);
  const currency = pos?.price_currency ?? base;
  const bucketId = pos?.bucket ?? (s.kind === "allocation_drift" ? String(s.payload.bucket_id) : null);
  const bucket = buckets.find((b) => b.bucket_id === bucketId) ?? null;
  const effect = trade && pos ? decisionEffect({ side: act === "buy" ? "buy" : "sell", quantity: qn, price: pn, currency, bucket, total, base }) : null;
  const invalid = trade && pos != null && (qn == null || qn <= 0 || pn == null || pn <= 0);

  const save = () => {
    const input: DecisionInput = {
      action: ACTION[act], reason: reason.trim() || null,
      ...(trade && pos ? { quantity: qn, price: pn, currency, account_id: acc } : {}),
    };
    onDecide(s, input, decisionTag({ action: ACTION[act], quantity: trade ? qn : null }) ?? "decyzja");
  };
  return (
    <div className="decide" ref={ref} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onCollapse(); } }}>
      <div className="fr">
        <label>Co robię?</label>
        <Seg<Act> items={[["Nic", "none"], ["Dokupuję", "buy"], ["Sprzedaję", "sell"], ["Odkładam", "later"]]} value={act} onChange={setAct} />
      </div>
      {trade && pos && (
        <>
          <div className="fr">
            <label htmlFor={`dq-${s.id}`}>Ilość</label>
            <input id={`dq-${s.id}`} className="num" inputMode="decimal" value={q} onChange={(e) => setQ(e.target.value)} />
            <label htmlFor={`dp-${s.id}`}>Cena</label>
            <input id={`dp-${s.id}`} className="num" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
            <label htmlFor={`da-${s.id}`}>Rachunek</label>
            <select id={`da-${s.id}`} value={acc ?? ""} onChange={(e) => setAcc(Number(e.target.value))}>
              {(held.length ? accounts.filter((a) => held.includes(a.id)) : accounts).map((a) => <option key={a.id} value={a.id}>{accountLabel(a, accounts)}</option>)}
            </select>
          </div>
          {effect && <div className="fr"><span className="muted" style={{ fontSize: 12 }}>{effect}</span></div>}
        </>
      )}
      <textarea rows={3} placeholder="Dlaczego? Jedno-dwa zdania, trafią do dziennika." value={reason} onChange={(e) => setReason(e.target.value)}
        aria-label="Powód decyzji" />
      {thesis && (
        <div className="thesis">
          <b>Teza ({dmy(thesis.created_at)}):</b>{thesis.thesis ? ` wejście - ${thesis.thesis}` : ""}{thesis.invalidation ? ` · unieważnienie - ${thesis.invalidation}` : ""}{thesis.exit_plan ? ` · wyjście - ${thesis.exit_plan}` : ""}
        </div>
      )}
      <div className="fr">
        <button className="btn primary" onClick={save} disabled={invalid}>Zapisz decyzję</button>
        <button className="btn" onClick={() => onAck(reason.trim() || undefined)}>Potwierdź bez zmian</button>
        <span style={{ flex: 1 }} />
        <button className="lnk" onClick={onCollapse}>Zwiń</button>
      </div>
      {trade && pos && <div className="hint">Decyzja trafia do dziennika; transakcję zapiszesz po wykonaniu (import albo ręcznie).</div>}
    </div>
  );
}

// ---- classification -------------------------------------------------------------------

/** Does an instrument with this class / tags fit the bucket's match? (mic / currency / ids as stored). */
export function fits(m: BucketMatch, i: { asset_class: string; tags: string[]; mic: string | null; currency: string; id: number | string }): boolean {
  if (m.instrument_ids.length && m.instrument_ids.some((x) => String(x) === String(i.id))) return true;
  if (m.asset_class.length && !m.asset_class.includes(i.asset_class)) return false;
  if (m.tags.length && !m.tags.every((t) => i.tags.map((x) => x.toLowerCase()).includes(t.toLowerCase()))) return false;
  if (m.mic.length && !m.mic.map((x) => x.toUpperCase()).includes((i.mic ?? "").toUpperCase())) return false;
  if (m.currency.length && !m.currency.includes(i.currency)) return false;
  return !(m.asset_class.length === 0 && m.tags.length === 0 && m.mic.length === 0 && m.currency.length === 0 && m.instrument_ids.length > 0);
}

export function ClassifyCard({ items, positions, strategy, accounts, onSave, highlight, focusId }: {
  items: Instrument[];
  positions: Position[];
  strategy: StrategyStatus | null;
  accounts: AccountRow[];
  onSave: (i: Instrument, patch: { asset_class: string; region: string | null; valuation_mode: string; tags: string[] }) => Promise<void>;
  highlight: boolean;
  focusId: string | null;
}) {
  if (!items.length) return null;
  return (
    <section className={`card ${highlight ? "hl" : ""}`} id="inv-classify" aria-label="Do sklasyfikowania">
      <div className="controls" style={{ marginBottom: 4 }}>
        <h2 style={{ margin: 0 }}>Do sklasyfikowania</h2><Tag tone="warn">{items.length}</Tag>
      </div>
      {items.map((i) => (
        <ClassifyItem key={String(i.id)} i={i} pos={positions.find((p) => String(p.instrument.id) === String(i.id)) ?? null}
          strategy={strategy} accounts={accounts} onSave={onSave} focus={focusId === String(i.id)} />
      ))}
    </section>
  );
}

const CLASSES = ["equity", "etf", "fund", "bond", "treasury_bond", "cash", "crypto", "commodity", "claim", "other"];

function ClassifyItem({ i, pos, strategy, accounts, onSave, focus }: {
  i: Instrument; pos: Position | null; strategy: StrategyStatus | null; accounts: AccountRow[];
  onSave: (i: Instrument, patch: { asset_class: string; region: string | null; valuation_mode: string; tags: string[] }) => Promise<void>; focus: boolean;
}) {
  const toast = useToast();
  const matches = strategy?.facts?.bucket_matches ?? [];
  const [cls, setCls] = useState(i.asset_class);
  const [reg, setReg] = useState(i.region ?? "");
  const [mode, setMode] = useState(i.valuation_mode ?? "market");
  // Preselect only a bucket the instrument already fits as it is (no guessed tags): a wrong default
  // would silently put e.g. an EM ETF into "Akcje PL".
  const [bucket, setBucket] = useState<string>(() => matches.find((m) => fits(m, i))?.id ?? "");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (focus) ref.current?.querySelector<HTMLElement>("select")?.focus(); }, [focus]);
  const chosen = matches.find((m) => m.id === bucket) ?? null;
  const classOk = !chosen || !chosen.asset_class.length || chosen.asset_class.includes(cls);
  const first = useMemo(() => [...(pos?.lots ?? [])].sort((a, b) => a.open_date.localeCompare(b.open_date))[0], [pos]);
  const acc = first ? accounts.find((a) => a.id === first.account_id) : null;
  const regionText = reg ? regionLabel(reg) : "";
  const pickBucket = (b: string) => {
    setBucket(b);
    const m = matches.find((x) => x.id === b);
    if (m && m.asset_class.length && !m.asset_class.includes(cls)) setCls(m.asset_class[0]);
  };
  const save = async () => {
    setBusy(true);
    try {
      const tags = [...new Set([...i.tags, ...(chosen?.tags ?? [])])];
      await onSave(i, { asset_class: cls, region: reg || null, valuation_mode: mode, tags });
    } finally { setBusy(false); }
  };
  const propose = () => {
    const text = `Zaproponuj zmianę strategii (propose_strategy): instrument ${i.label}${i.isin ? ` (${i.isin})` : ""}, klasa ${ASSET_CLASS[cls] ?? cls}${regionText ? `, region ${regionText}` : ""} nie pasuje do żadnego koszyka. Dodaj koszyk${regionText ? ` „${regionText}"` : ""} albo rozszerz istniejący i zaproponuj nowe cele.`;
    void copyText(text).then(() => toast("Skopiowano polecenie dla Claude Code - propozycja pojawi się w Strategii do zatwierdzenia", 4000));
  };
  return (
    <div className="signal" style={{ borderBottom: "none" }} ref={ref} data-classify={String(i.id)}>
      <div className="sh">
        <span className="grow">{i.name} {i.symbol && i.symbol !== i.name && <span className="sym">{i.symbol}</span>}</span>
        {pos && <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>{qty(pos.quantity)} szt. · {pct(pos.weight)}</span>}
      </div>
      <div className="sm">
        {first ? `kupno ${dm(first.open_date)}${acc ? ` (${accountLabel(acc, accounts)})` : ""} · ` : ""}bez klasy aktywów i koszyka · poza alokacją i regułami
      </div>
      <div className="decide" style={{ marginTop: 8 }}>
        <div className="fr">
          <label htmlFor={`cc-${i.id}`}>Klasa</label>
          <select id={`cc-${i.id}`} value={cls} onChange={(e) => setCls(e.target.value)}>
            {CLASSES.map((c) => <option key={c} value={c}>{ASSET_CLASS[c]}</option>)}
          </select>
          <label htmlFor={`cr-${i.id}`}>Region</label>
          <select id={`cr-${i.id}`} value={reg} onChange={(e) => setReg(e.target.value)}>
            <option value="">-</option>
            {[...new Set([...Object.keys(REGION).filter((k) => k !== "unknown"), ...(reg ? [reg] : [])])].map((k) => <option key={k} value={k}>{REGION[k] ?? k}</option>)}
          </select>
          <label htmlFor={`cv-${i.id}`}>Wycena</label>
          <select id={`cv-${i.id}`} value={mode} onChange={(e) => setMode(e.target.value)}>
            {Object.entries(VALUATION).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <div className="fr">
          <label htmlFor={`cb-${i.id}`}>Koszyk</label>
          <select id={`cb-${i.id}`} value={bucket} onChange={(e) => pickBucket(e.target.value)} disabled={!matches.length}>
            <option value="">{matches.length ? "bez koszyka" : "brak strategii"}</option>
            {matches.map((m) => <option key={m.id} value={m.id}>{bucketLabel(m.id)}</option>)}
            {matches.length > 0 && <option value="__new">nowy koszyk…</option>}
          </select>
          {(!bucket || bucket === "__new") && strategy?.version != null && (
            <span className="muted" style={{ fontSize: 12 }}>brak koszyka{regionText ? ` „${regionText}"` : ""} w strategii v{strategy.version}</span>
          )}
          {chosen && chosen.tags.length > 0 && <span className="muted" style={{ fontSize: 12 }}>doda tag {chosen.tags.join(", ")}</span>}
          {!classOk && <span style={{ fontSize: 12, color: "var(--warn)" }}>koszyk wymaga klasy {chosen!.asset_class.map((c) => ASSET_CLASS[c] ?? c).join(" / ")}</span>}
        </div>
        <div className="fr">
          <button className="btn primary" onClick={save} disabled={busy || !classOk}>{busy ? "Zapisuję…" : "Zapisz"}</button>
          {strategy?.version != null && <button className="btn" onClick={propose} title="Kopiuje polecenie dla agenta; zmiana strategii przychodzi jako propozycja do zatwierdzenia">Zaproponuj zmianę strategii</button>}
        </div>
      </div>
    </div>
  );
}

// ---- data warnings ---------------------------------------------------------------------

export function WarningsCard({ items, onAction, onAlias, highlight, aliasHints }: {
  items: WarningItem[];
  onAction: (w: WarningItem) => void;
  onAlias: (instrumentId: string, yahoo: string) => Promise<void>;
  highlight: boolean;
  aliasHints: Map<string, string>;
}) {
  if (!items.length) return null;
  return (
    <section className={`card ${highlight ? "hl" : ""}`} id="inv-warnings" aria-label="Ostrzeżenia danych">
      <div className="controls" style={{ marginBottom: 4 }}>
        <h2 style={{ margin: 0 }}>Ostrzeżenia danych</h2><Tag tone="warn">{items.length}</Tag>
      </div>
      {items.map((w) => <WarningRow key={w.key} w={w} onAction={onAction} onAlias={onAlias} hint={aliasHints.get(w.key.split(":")[1] ?? "")} />)}
    </section>
  );
}

function WarningRow({ w, onAction, onAlias, hint }: { w: WarningItem; onAction: (w: WarningItem) => void; onAlias: (id: string, v: string) => Promise<void>; hint?: string }) {
  const [edit, setEdit] = useState(false);
  const [val, setVal] = useState(hint ?? "");
  const [busy, setBusy] = useState(false);
  const instId = w.key.split(":")[1] ?? "";
  return (
    <div className="signal">
      <div className="sh" style={{ fontWeight: 500, fontSize: 13.5 }}>
        <span className={`sev ${w.tone}`} aria-hidden /><span className="grow">{w.title}</span>
      </div>
      <div className="sm">
        <span>{w.hint}</span>
        {w.action === "snapshot" && <button className="lnk" style={{ fontSize: 12.5 }} onClick={() => onAction(w)}>wgraj snapshot</button>}
        {w.action === "import" && <button className="lnk" style={{ fontSize: 12.5 }} onClick={() => onAction(w)}>import</button>}
        {w.action === "alias" && !edit && instId && (
          <><button className="lnk" style={{ fontSize: 12.5 }} onClick={() => setEdit(true)}>dodaj alias</button>{hint && <span>(podpowiedź: {hint})</span>}</>
        )}
      </div>
      {edit && (
        <div className="decide" style={{ marginTop: 6 }}>
          <div className="fr">
            <label htmlFor={`al-${w.key}`}>Symbol Yahoo</label>
            <input id={`al-${w.key}`} value={val} onChange={(e) => setVal(e.target.value)} style={{ width: 120 }} autoFocus
              onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setEdit(false); } }} />
            <button className="btn primary" disabled={busy || !val.trim()} onClick={async () => {
              setBusy(true);
              try { await onAlias(instId, val.trim()); setEdit(false); } finally { setBusy(false); }
            }}>Zapisz</button>
            <button className="lnk" onClick={() => setEdit(false)}>Anuluj</button>
          </div>
          <div className="hint">Ceny pobiorą się przy następnym przebiegu reguł.</div>
        </div>
      )}
    </div>
  );
}

export { plural, money };
