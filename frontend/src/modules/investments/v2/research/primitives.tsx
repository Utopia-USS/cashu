// Research primitives (research.md 3-6, implementation-plan item 29): thesis health pill, thesis relation
// chip, strength bars, 8-week sentiment bars (inline SVG, three sizes), the note card, the candidate card
// and the copyable command. Copy from the research.md 8 deck; boundaries: facts and sentiment with sources,
// never a recommendation, a price or a target.
import { Fragment, type ReactNode, useState } from "react";
import { useWidth } from "../../../../hooks";
import { copyText, useToast } from "../../../../ui";
import { AgentTag } from "../../../../widgets";
import { dm, micName, plural } from "../../labels";
import { InstLabel, type InstLike } from "../InstLabel";
import {
  candidateCriteria, candidateReturn, clampStrength, criterionText, entryTypeLabel, expiryText, freshness, HEALTH_CLS, HEALTH_LABEL, isExpired,
  acceptedAt, KIND_LABEL, NOISE_SCALE, noteRowTitle, noteSubject, noteWhen, normRelation, polarityCls, watchItemId, POLARITY_WORD, RELATION_CLS, RELATION_LABEL, relationIcon,
  ROUTINE_MENU, ROUTINE_PROMPT, safeUrl, sentimentBars, sourceParts, sourceText, strengthTitle, summaryWithoutCriteria,
} from "./logic";
import type { HealthKey, ResearchNote } from "./types";
import "./research.css";
import { localDay } from "../../../../time";

/** `pre` (P2): the state rests only on research older than the thesis' last change: the dot goes hollow (stale
 * research, `muted`, wins). */
export function HealthPill({ state, muted, pre, title }: { state: HealthKey; muted?: boolean; pre?: boolean; title?: string }) {
  const base = title ?? `teza: ${HEALTH_LABEL[state]}`;
  const hollow = !!pre && !muted;
  return (
    <span className={`health ${HEALTH_CLS[state]} ${muted ? "muted" : ""} ${hollow ? "pre" : ""}`} title={hollow ? `${base} · research sprzed zmiany tezy` : base}>
      <i aria-hidden />{HEALTH_LABEL[state]}
    </span>
  );
}

/** P2: a note stored before the thesis' last core change (judged against the previous thesis). */
export const PreTag = () => <span className="tag pre">sprzed zmiany tezy</span>;

export function RelationChip({ relation, text }: { relation: string | null | undefined; text?: string }) {
  const r = normRelation(relation);
  return <span className={`rel ${RELATION_CLS[r]}`}>{text ?? RELATION_LABEL[r]}</span>;
}

export function Strength({ value }: { value: number }) {
  const v = clampStrength(value);
  return <span className={`str s${v}`} title={strengthTitle(v)} aria-label={`siła ${v} z 3`} role="img"><i /><i /><i /></span>;
}

export function KindTag({ kind }: { kind: string }) {
  return <span className={`tag solid ${kind === "community" ? "warn" : "muted"}`}>{KIND_LABEL[kind] ?? kind}</span>;
}

const SIZES = { sm: [56, 18], md: [128, 30], lg: [0, 72] } as const;

/** 8 bars, one per ISO week, oldest left: positive rises (`--pos`), negative falls (`--neg`), an empty week is
 * a 2 px tick (no data looks different from balanced). No smoothing, no line: eight facts, not a forecast. */
export function SentimentBars({ values, labels, size = "sm" }: { values: (number | null)[]; labels?: string[]; size?: "sm" | "md" | "lg" }) {
  const { ref, width } = useWidth<HTMLSpanElement>();
  const [w0, h] = SIZES[size];
  const w = size === "lg" ? Math.max(120, Math.round(width) || 300) : w0;
  const band = labels ? 13 : 0;
  const { mid, bars, bw } = sentimentBars(values, w, h, band);
  const desc = values.map((v) => (v == null ? "brak" : v > 0 ? `+${v.toFixed(1)}` : v.toFixed(1))).join(", ");
  return (
    <span ref={ref} className={`sent ${size}`} role="img" aria-label={`Sentyment 8 tygodni, od najstarszego: ${desc}`}>
      <svg viewBox={`0 0 ${w} ${h}`} width={size === "lg" ? undefined : w} height={h} preserveAspectRatio="none" aria-hidden>
        <line x1={0} x2={w} y1={mid} y2={mid} className="base" />
        {bars.map((b, i) => (
          <Fragment key={i}>
            <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={b.cls === "none" ? 0 : 1} className={b.cls} />
            {labels?.[i] && <text x={b.x + bw / 2} y={h - 2} className="ax" textAnchor="middle">{labels[i]}</text>}
          </Fragment>
        ))}
      </svg>
    </span>
  );
}

/** Summary text with numbers and quoted thesis words in bold (rendered as text nodes, never as HTML). */
export function richSummary(text: string): ReactNode[] {
  const re = /(„[^”"]{1,80}[”"]|[+\-−]?\d+(?:[.,]\d+)?\s?(?:%|pp|pb|mld\s?\$|mln\s?\$|mld\s?zł|mln\s?zł|zł|\$|€)(?:\s?r\/r|\s?m\/m)?)/g;
  const out: ReactNode[] = [];
  let last = 0, k = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(<b key={k++}>{m[0]}</b>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export interface NoteCardProps {
  note: ResearchNote;
  today: string;
  /** "instrument": inside an instrument context (no `who`); "list": the research view (with `who`). */
  context: "instrument" | "list";
  card?: boolean;
  hl?: boolean;
  /** Instrument display name + symbol, or the theme, shown in list context. */
  who?: { name: string; sym?: string | null; inst?: InstLike } | null;
  signalText?: string | null;
  onDismiss?: (n: ResearchNote) => void;
  onRestore?: (n: ResearchNote) => void;
  canRestore?: boolean;
  /** List context: the instrument name opens the asset drawer at this note. */
  onWho?: () => void;
}

/** `.note`: header (polarity dot, who, kind, strength, relation, agent badge, date, ✕), title, a 3-line
 * summary (click expands), footer (sources as `publisher · d.m` links, `sygnał`, `szum`, expiry). */
export function NoteCard({ note: n, today, context, card, hl, who, signalText, onDismiss, onRestore, canRestore, onWho }: NoteCardProps) {
  const [open, setOpen] = useState(false);
  const expired = isExpired(n, today);
  const dismissed = !!n.dismissed_at;
  const fresh = freshness(n.observed_at, today);
  const exp = expiryText(n, today);
  const community = n.kind === "community";
  const body = summaryWithoutCriteria(n.summary);
  return (
    <article className={`note ${card ? "card" : ""} ${dismissed || expired ? "dim" : ""} ${hl ? "hl" : ""}`} id={`note-${n.id}`} data-note={n.id}>
      <div className="nh">
        <span className={`pd ${polarityCls(n.polarity)}`} title={`polaryzacja: ${POLARITY_WORD[n.polarity] ?? n.polarity}`} />
        {context === "list" && who && (who.inst
          ? <span className="who"><InstLabel density="inline" inst={who.inst} text={who.name} onOpen={onWho ? () => onWho() : undefined} /></span>
          : <span className="who">{onWho ? <button className="lnk who-btn" onClick={(e) => { e.stopPropagation(); onWho(); }}>{who.name}</button> : who.name}{who.sym && <span className="sym">{who.sym}</span>}</span>)}
        <KindTag kind={n.kind} />
        <Strength value={n.strength} />
        <RelationChip relation={n.thesis_relation} />
        {n.predates_thesis && <PreTag />}
        <span className="right">
          {n.created_by === "agent" && <AgentTag text="research" />}
          <span className={`when ${fresh !== "fresh" ? "old" : ""}`} title={localDay(n.observed_at) ?? undefined}>{noteWhen(n.observed_at, today)}</span>
          {onDismiss && !dismissed && <button className="icon-btn" title="Odrzuć notatkę" aria-label={`Odrzuć notatkę: ${n.title}`} onClick={() => onDismiss(n)}>✕</button>}
        </span>
      </div>
      <div className="nt">{n.title}</div>
      {body && <div className={`ns ${open ? "open" : ""}`} onClick={() => setOpen((v) => !v)} title={open ? "Zwiń" : "Rozwiń"}>{richSummary(open ? body : body.split(/\n\s*\n/)[0])}</div>}
      <div className="nf">
        {n.sources.map((s, i) => {
          const url = safeUrl(s.url);
          return (
            <Fragment key={i}>
              {i > 0 && <span className="sep">·</span>}
              {url ? <a href={url} target="_blank" rel="noopener noreferrer" title={s.title ?? url}>{sourceText(s)}</a> : <span>{sourceText(s)}</span>}
            </Fragment>
          );
        })}
        <span className="spacer" />
        {community && <span className="noise">{NOISE_SCALE[String(n.details?.scale ?? "small")] ?? NOISE_SCALE.small}</span>}
        {n.signal_id != null && (signalText ? <span>{signalText}</span> : <span className={`tag solid ${n.polarity === "negative" ? "neg" : n.polarity === "positive" ? "pos" : "muted"}`}>sygnał</span>)}
        {dismissed ? (
          <span>odrzucona {dm(n.dismissed_at)}{onRestore && canRestore && <> · <button className="lnk" onClick={() => onRestore(n)}>przywróć</button></>}</span>
        ) : exp && <span>{exp}</span>}
      </div>
    </article>
  );
}

/** The note's effect on the thesis (asset-detail.md 6): circled plus / minus / filled minus / tilde. */
export function RelationIcon({ relation }: { relation: string | null | undefined }) {
  const r = relationIcon(relation);
  return <span className={`ri ${r.cls}`} role="img" aria-label={r.label} title={r.label}>{r.glyph}</span>;
}

/** A note in the instrument context (asset-detail.md 6): the relation icon + the title; a click expands the
 * summary, `źródła (n)` (one more click lists them) and `odrzuć`. Kind and date live in the row's tooltip;
 * a dismissed row keeps `przywróć` one click away while it can be restored. `NoteCard` stays for the list. */
export function NoteRow({ note: n, today, hl, open, onToggle, onDismiss, onRestore, canRestore }: {
  note: ResearchNote; today: string; hl?: boolean; open: boolean; onToggle: () => void;
  onDismiss?: (n: ResearchNote) => void; onRestore?: (n: ResearchNote) => void; canRestore?: boolean;
}) {
  const [src, setSrc] = useState(false);
  const dismissed = !!n.dismissed_at;
  const body = summaryWithoutCriteria(n.summary);
  const restore = dismissed && onRestore && canRestore ? (
    <span className="nrr">odrzucona {dm(n.dismissed_at)} · <button className="lnk" onClick={(e) => { e.stopPropagation(); onRestore(n); }}>przywróć</button></span>
  ) : null;
  return (
    <article className={`nr ${open ? "open" : ""} ${dismissed || isExpired(n, today) ? "dim" : ""} ${hl ? "hl" : ""}`} id={`note-${n.id}`} data-note={n.id}>
      <div className="nrw">
        <button className="nrh" aria-expanded={open} title={noteRowTitle(n, today)} onClick={onToggle}>
          <RelationIcon relation={n.thesis_relation} />
          <span className="nt">{n.title}</span>
          {n.predates_thesis && <PreTag />}
          <svg className="nchev" width="12" height="12" viewBox="0 0 12 12" aria-hidden><path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        {restore}
      </div>
      {open && (
        <div className="nx">
          {body && <p className="ns">{richSummary(body)}</p>}
          {(n.sources.length > 0 || (onDismiss && !dismissed)) && (
            <div className="nf">
              {n.sources.length > 0 && <button className="lnk" aria-expanded={src} onClick={() => setSrc((v) => !v)}>źródła ({n.sources.length})</button>}
              {n.sources.length > 0 && onDismiss && !dismissed && <span aria-hidden>·</span>}
              {onDismiss && !dismissed && <button className="lnk" onClick={() => onDismiss(n)}>odrzuć</button>}
            </div>
          )}
          {src && (
            <ul className="nsrc">
              {n.sources.map((s, i) => {
                const url = safeUrl(s.url);
                const p = sourceParts(s);
                return <li key={i}>{url ? <a href={url} target="_blank" rel="noopener noreferrer" title={s.title ?? url}>{p.who}</a> : p.who}{p.date && <span>{p.date}</span>}</li>;
              })}
            </ul>
          )}
        </div>
      )}
    </article>
  );
}

export interface CandidateState { watchedSince?: string | null; agent?: boolean }

/** `.cand`: name + `symbol · venue`, entry-type tag, criteria met / not met (each a measured fact with the
 * strategy threshold), one context line, `Obserwuj` / `Odrzuć`, sources count + date. No price, no target,
 * no size: a candidate is never a position. */
export function CandidateCard({ note: n, compact, today, state, busy, onWatch, onDismiss, onRestore, canRestore }: {
  note: ResearchNote; compact?: boolean; today: string; state?: CandidateState; busy?: boolean;
  onWatch?: (n: ResearchNote) => void; onDismiss?: (n: ResearchNote) => void; onRestore?: (n: ResearchNote) => void; canRestore?: boolean;
}) {
  const { name, sym } = noteSubject(n);
  const crit = candidateCriteria(n);
  const entry = entryTypeLabel(n.details?.entry_type ?? null);
  const dismissed = !!n.dismissed_at;
  const back = n.cooldown_until ?? (n.dismissed_at ? candidateReturn(n.dismissed_at) : null);
  const context = typeof n.details?.context === "string" ? n.details.context : null;
  const watched = state?.watchedSince != null || !!acceptedAt(n) || watchItemId(n) != null;
  const srcLine = `${plural(n.sources.length, "źródło", "źródła", "źródeł")} · ${dm(n.observed_at)}`;
  return (
    <div className={`cand ${dismissed ? "dim" : ""}`} data-note={n.id}>
      <div className="ch">
        <InstLabel density="compact" card={false} text={name}
          inst={{ id: n.id, label: name, symbol: n.instrument?.symbol ?? n.candidate?.symbol ?? null, name }}
          sub={micName(n.instrument?.mic ?? n.candidate?.exchange) ?? (sym && !(n.instrument?.symbol ?? n.candidate?.symbol) ? sym : undefined)} />
        <span className="spacer" />
        {entry && <span className="tag">{entry}</span>}
      </div>
      {dismissed ? (
        <>
          <div><span className="tag solid muted">odrzucony {dm(n.dismissed_at)}</span></div>
          <div className="cc">{n.title}{context ? ` · ${context}` : ""}{back ? ` · wraca najwcześniej ${dm(back)}` : ""}</div>
          {onRestore && canRestore && <div><button className="lnk" onClick={() => onRestore(n)}>przywróć</button></div>}
        </>
      ) : compact ? (
        <div className="cc">
          {crit.total > 0 ? <>kryteria <b>{crit.met} z {crit.total}</b>{crit.items.filter((c) => c.met).map((c, k) => <Fragment key={k}> · {richSummary(c.text)}</Fragment>)}</> : n.title}
          {context && !crit.total ? ` · ${context}` : ""}
        </div>
      ) : (
        <>
          {crit.total > 0 ? (
            <div className="crit">
              {crit.items.map((c, k) => <span key={k} className={c.met ? "" : "miss"}><i aria-label={c.met ? "spełnione" : "niespełnione"}>{c.met ? "✓" : "·"}</i>{criterionText(c)}</span>)}
            </div>
          ) : <div className="cc">{n.title}</div>}
          {context && <div className="cc">{context}</div>}
        </>
      )}
      {!dismissed && (
        <div className="cact">
          {state?.agent ? <span className="tag agent"><i aria-hidden>A</i>dodany przez agenta</span>
            : watched ? <span className="tag solid muted">obserwowany od {dm(state?.watchedSince ?? acceptedAt(n) ?? today)}</span>
            : <>
              <button className="btn sm primary" disabled={busy} onClick={() => onWatch?.(n)} title="Dodaje do Obserwowanych z wersją roboczą tezy">Obserwuj</button>
              <button className="btn sm" disabled={busy} onClick={() => onDismiss?.(n)} title="Wraca po 90 dniach">Odrzuć</button>
            </>}
          <span className="spacer" />
          <span className="src">{srcLine}</span>
        </div>
      )}
    </div>
  );
}

/** Monospace command + `Kopiuj polecenie` (the app copies, Claude Code runs it; design answer 3). */
export function CopyCommand({ cmd, label = "Kopiuj polecenie", primary = true, showCmd = true, sm, done = "Skopiowano · wklej w Claude Code", title }: {
  cmd: string; label?: string; primary?: boolean; showCmd?: boolean; sm?: boolean; done?: string; title?: string;
}) {
  const toast = useToast();
  return (
    <>
      {showCmd && <code className="cmd" title={cmd}>{cmd}</code>}
      <button className={`btn ${primary ? "primary" : ""} ${sm ? "sm" : ""}`} title={title} onClick={() => copyText(cmd).then(() => toast(done, 3000))}>{label}</button>
    </>
  );
}

/** How to schedule the Saturday routine: a LOCAL routine in the Claude desktop app, in the profile's workspace
 * folder (the app only explains; it never creates the routine). */
export function ScheduleHow({ path, onSettings }: { path: string; onSettings?: () => void }) {
  return (
    <div className="sched">
      <div><b>{ROUTINE_MENU}</b>: sobota 07:00, folder <code className="cmd wrap">{path}</code>, polecenie <code className="cmd">{ROUTINE_PROMPT}</code></div>
      <div className="acts">
        <CopyCommand cmd={ROUTINE_PROMPT} label="Kopiuj polecenie rutyny" primary={false} showCmd={false} sm done="Skopiowano · wklej w aplikacji Claude" title="Rutyna lokalna: tylko ona widzi serwer MCP na tym Macu." />
        <CopyCommand cmd={path} label="Kopiuj folder" primary={false} showCmd={false} sm done="Skopiowano" />
        {onSettings && <button className="lnk" onClick={onSettings}>Szczegóły: Ustawienia › Agent AI</button>}
      </div>
    </div>
  );
}
