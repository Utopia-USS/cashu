// Research primitives (research.md 3-6, implementation-plan item 29): thesis health pill, thesis relation
// chip, strength bars, 8-week sentiment bars (inline SVG, three sizes), the note card, the candidate card
// and the copyable command. Copy from the research.md 8 deck; boundaries: facts and sentiment with sources,
// never a recommendation, a price or a target.
import { Fragment, type ReactNode, useState } from "react";
import { useWidth } from "../../../../hooks";
import { copyText, useToast } from "../../../../ui";
import { AgentTag } from "../../../../widgets";
import { dm, plural } from "../../labels";
import {
  candidateCriteria, candidateReturn, clampStrength, criterionText, entryTypeLabel, expiryText, freshness, HEALTH_CLS, HEALTH_LABEL, isExpired,
  acceptedAt, KIND_LABEL, NOISE_SCALE, noteSubject, noteWhen, normRelation, polarityCls, watchItemId, POLARITY_WORD, RELATION_CLS, RELATION_LABEL, ROUTINE_MENU, ROUTINE_PROMPT, safeUrl, sentimentBars,
  sourceText, strengthTitle, summaryWithoutCriteria,
} from "./logic";
import type { HealthKey, ResearchNote } from "./types";
import "./research.css";
import { localDay } from "../../../../time";

export function HealthPill({ state, muted, title }: { state: HealthKey; muted?: boolean; title?: string }) {
  return <span className={`health ${HEALTH_CLS[state]} ${muted ? "muted" : ""}`} title={title ?? `teza: ${HEALTH_LABEL[state]}`}><i aria-hidden />{HEALTH_LABEL[state]}</span>;
}

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
  who?: { name: string; sym?: string | null } | null;
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
        {context === "list" && who && <span className="who">{onWho ? <button className="lnk who-btn" onClick={(e) => { e.stopPropagation(); onWho(); }}>{who.name}</button> : who.name}{who.sym && <span className="sym">{who.sym}</span>}</span>}
        <KindTag kind={n.kind} />
        <Strength value={n.strength} />
        <RelationChip relation={n.thesis_relation} />
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
        <span className="nm">{name}{sym && <span className="sym">{sym}</span>}</span>
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
              <button className="btn sm primary" disabled={busy} onClick={() => onWatch?.(n)}>Obserwuj</button>
              <button className="btn sm" disabled={busy} onClick={() => onDismiss?.(n)}>Odrzuć</button>
            </>}
          <span className="spacer" />
          <span className="src">{srcLine}</span>
        </div>
      )}
    </div>
  );
}

/** Monospace command + `Kopiuj polecenie` (the app copies, Claude Code runs it; design answer 3). */
export function CopyCommand({ cmd, label = "Kopiuj polecenie", primary = true, showCmd = true, sm, done = "Polecenie skopiowane · wklej w Claude Code" }: {
  cmd: string; label?: string; primary?: boolean; showCmd?: boolean; sm?: boolean; done?: string;
}) {
  const toast = useToast();
  return (
    <>
      {showCmd && <code className="cmd" title={cmd}>{cmd}</code>}
      <button className={`btn ${primary ? "primary" : ""} ${sm ? "sm" : ""}`} onClick={() => copyText(cmd).then(() => toast(done, 3000))}>{label}</button>
    </>
  );
}

/** How to schedule the Saturday routine: a LOCAL routine in the Claude desktop app, in the profile's workspace
 * folder (the app only explains; it never creates the routine). */
export function ScheduleHow({ path, onSettings }: { path: string; onSettings?: () => void }) {
  return (
    <div className="sched">
      <div>Rutyna działa lokalnie w aplikacji Claude na tym Macu, w folderze workspace profilu, więc ma dostęp do lokalnego serwera MCP finanse:</div>
      <div><b>{ROUTINE_MENU}</b>: sobota 07:00, folder <code className="cmd wrap">{path}</code>, polecenie <code className="cmd">{ROUTINE_PROMPT}</code></div>
      <div className="acts">
        <CopyCommand cmd={ROUTINE_PROMPT} label="Kopiuj polecenie rutyny" primary={false} showCmd={false} sm done="Polecenie rutyny skopiowane · wklej w aplikacji Claude" />
        <CopyCommand cmd={path} label="Kopiuj folder" primary={false} showCmd={false} sm done="Ścieżka workspace skopiowana" />
        {onSettings && <button className="lnk" onClick={onSettings}>Szczegóły: Ustawienia › Agent AI</button>}
      </div>
      <div>Wynik pojawi się tu i w niedzielnym przeglądzie.</div>
    </div>
  );
}
