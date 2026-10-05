// v1 rail pieces still rendered by v2: instruments to classify (inline) and data warnings.
import { useEffect, useMemo, useRef, useState } from "react";
import { copyText, Tag, useToast } from "../../ui";
import { type AccountRow, type BucketMatch, type Instrument, type Position, type StrategyStatus } from "./api";
import {
  accountLabel, ASSET_CLASS, bucketLabel, dm, money, pct, plural, qty, REGION, region as regionLabel, VALUATION,
} from "./labels";
import { type WarningItem } from "./logic";

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
    void copyText(text).then(() => toast("Skopiowano · wklej w Claude Code", 4000));
  };
  return (
    <div className="signal" style={{ borderBottom: "none" }} ref={ref} data-classify={String(i.id)}>
      <div className="sh">
        <span className="grow">{i.name} {i.symbol && i.symbol !== i.name && <span className="sym">{i.symbol}</span>}</span>
        {pos && <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>{qty(pos.quantity)} szt. · {pct(pos.weight)}</span>}
      </div>
      <div className="sm">
        {first ? `kupno ${dm(first.open_date)}${acc ? ` (${accountLabel(acc, accounts)})` : ""} · ` : ""}poza alokacją i regułami
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
          {strategy?.version != null && <button className="btn" onClick={propose} title="Kopiuje polecenie dla agenta">Zaproponuj zmianę</button>}
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
        </div>
      )}
    </div>
  );
}

export { plural, money };
