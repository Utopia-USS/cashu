// Research primitives (research.md 3-6, implementation-plan item 29): thesis health pill, thesis relation
// chip, strength bars, 8-week sentiment bars (inline SVG, three sizes), the segment contribution bar (P5), the
// macro explain popover and the topic row (P7), the note card, the candidate card and the copyable command. Copy from the research.md 8 deck; boundaries: facts and sentiment with sources,
// never a recommendation, a price or a target.
import { type FocusEvent, Fragment, type KeyboardEvent, type ReactNode, useEffect, useState } from "react";
import { useWidth } from "../../../../hooks";
import { copyText, useToast } from "../../../../ui";
import { AgentTag, Mark } from "../../../../widgets";
import { dm, micName } from "../../labels";
import { InstLabel, type InstLike } from "../InstLabel";
import {
  candidateCriteria, candidateReturn, clampStrength, criterionText, entryTypeLabel, expiryText, freshness, HEALTH_CLS, HEALTH_LABEL, isExpired,
  acceptedAt, KIND_LABEL, NOISE_SCALE, noteRowTitle, noteSubject, noteWhen, normRelation, polarityCls, watchItemId, POLARITY_WORD, RELATION_CLS, RELATION_LABEL, relationIcon,
  ROUTINE_PROMPT, safeUrl, sentimentBars, sourceParts, sourceText, strengthTitle, summaryWithoutCriteria,
} from "./logic";
import { briefLines, type DisplayRow, kindTitle, ppOf, ppTone, type PpTone, staleTitle, symbolsText, thesisDraft, type TopicKind, topicView } from "./segments";
import { metricTitle } from "./macro";
import type { HealthKey, MacroMetric, ResearchNote } from "./types";
import "./research.css";
import { localDay } from "../../../../time";
import { S as L } from "./logic.strings.ts";
import { S } from "./primitives.strings.ts";

/** `pre` (P2): the state rests only on research older than the thesis' last change: the dot goes hollow (stale
 * research, `muted`, wins). */
export function HealthPill({ state, muted, pre, title }: { state: HealthKey; muted?: boolean; pre?: boolean; title?: string }) {
  const base = title ?? S.thesisState(HEALTH_LABEL[state]);
  const hollow = !!pre && !muted;
  return (
    <span className={`health ${HEALTH_CLS[state]} ${muted ? "muted" : ""} ${hollow ? "pre" : ""}`} title={hollow ? S.researchPredates(base) : base}>
      <i aria-hidden />{HEALTH_LABEL[state]}
    </span>
  );
}

/** P2: a note stored before the thesis' last core change (judged against the previous thesis). */
export const PreTag = () => <span className="tag pre">{S.predatesThesis}</span>;

export function RelationChip({ relation, text }: { relation: string | null | undefined; text?: string }) {
  const r = normRelation(relation);
  return <span className={`rel ${RELATION_CLS[r]}`}>{text ?? RELATION_LABEL[r]}</span>;
}

export function Strength({ value }: { value: number }) {
  const v = clampStrength(value);
  return <span className={`str s${v}`} title={strengthTitle(v)} aria-label={S.strengthAria(v)} role="img"><i /><i /><i /></span>;
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
  const desc = values.map((v) => (v == null ? S.noWeekData : v > 0 ? `+${v.toFixed(1)}` : v.toFixed(1))).join(", ");
  return (
    <span ref={ref} className={`sent ${size}`} role="img" aria-label={S.sentimentAria(desc)}>
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

/** P5 diverging contribution bar (CSS, zero axis in the middle; geometry from `contribBars`): decoration only,
 * the signed pp text next to it is the value; the scale lives in `title`. */
export function ContribBar({ w, cls, size, title }: { w: number; cls: "pos" | "neg" | "zero"; size?: "md"; title: string }) {
  return (
    <span className={`cbar ${size ?? ""}`} aria-hidden title={title}>
      {cls !== "zero" && <i className={cls} style={{ width: `${w}%` }} />}
    </span>
  );
}

/** Escape hides the explain popover of a row while the pointer rests on the row (or the popover) or focus is inside
 * it (WCAG 1.4.13 dismissible); it shows again once the pointer leaves and focus moves out. Spread `props` on the row,
 * add `xoff` to its class while `hidden`. */
export function useExplainDismiss() {
  const [hidden, setHidden] = useState(false);
  const [hover, setHover] = useState(false);
  useEffect(() => {
    if (!hover || hidden) return;
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") setHidden(true); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [hover, hidden]);
  return {
    hidden,
    props: {
      onMouseEnter: () => setHover(true),
      onMouseLeave: () => { setHover(false); setHidden(false); },
      onKeyDown: (e: KeyboardEvent) => { if (e.key === "Escape") setHidden(true); },
      onBlur: (e: FocusEvent<HTMLElement>) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHidden(false); },
    },
  };
}

/** Hover / focus explanation card under a macro row (P7 design 2.2): a head line, a paragraph of 3-6 sentences, the
 * metrics as label / value pairs. CSS shows it (`.mrow:hover .mx`, `.mrow:focus-within .mx`); the last two rows
 * of a list open it upwards (CSS). Read-only; the pointer can rest on it (it is part of the row's hover) and Escape
 * hides it (`useExplainDismiss`). */
export function Explain({ id, head, tone: t, text, metrics }: { id: string; head: string; tone: string; text: string; metrics: MacroMetric[] }) {
  return (
    <div className="mx" role="tooltip" id={id}>
      <div className={`xh ${t}`}>{head}</div>
      <p className="xt">{text}</p>
      {metrics.length > 0 && (
        <div className="xm">{metrics.slice(0, 3).map((m, i) => <Fragment key={i}><span className="l">{m.label}</span><b className={m.stale ? "stale" : ""} title={metricTitle(m)}>{m.text}</b></Fragment>)}</div>
      )}
    </div>
  );
}

/** One topic row (P9): the name on its own line (never truncated), the tickers as a muted subtitle, for held topics
 * the contribution bar and pp on the right, then up to 3 brief lines (headline + muted date; the first also its `why`
 * in one muted line). No trend numbers. Watched-only and brief-only rows (no member, P9 MED-6) are muted with empty
 * bar / pp slots (brief-only: no tickers line either); a new row (held now,
 * no exposure at the window start) has the empty slots but is not muted. Under the name the topic's market view
 * (P11, `Ocena teraz` / `Perspektywa`, one line each, full text in the tooltip) before the briefs. The name opens the
 * topic drawer. */
export function TopicRow({ r, kind, bar, syms, stale, first, right, last, onOpen }: {
  r: DisplayRow; kind: TopicKind; bar: { w: number; cls: PpTone; title: string }; syms: string[]; stale: string[];
  /** first watched-only row (dashed group rule), right sub-column (left rule), bottom of the left sub-column (no border). */
  first: boolean; right: boolean; last: boolean; onOpen: () => void;
}) {
  const lines = briefLines(r);
  const draft = thesisDraft(r.thesis);
  const view = topicView(r.thesis);
  return (
    <div className={`trow${kind === "watched" || kind === "none" ? " wo" : ""}${first ? " grp" : ""}${right ? " c2" : ""}${last ? " last" : ""}`} data-topic={r.key}>
      <div className="tl">
        <div className="nm">
          <button className="nm" onClick={onOpen} title={kindTitle(kind)}>{r.label}</button>
          {draft && <span className="tag warn" title={S.agentThesis}>{S.toConfirm}</span>}
          {r.unread > 0 && <Mark kind="notes" title={S.nNewNotes(r.unread)} />}
        </div>
        {syms.length > 0 && <div className="sym">{symbolsText(syms, Infinity)}</div>}
      </div>
      {kind === "held" ? <ContribBar {...bar} /> : <span />}
      <div className="r">{kind === "held"
        ? <span className={`pp ${ppTone(r.contribution)}${stale.length ? " stale" : ""}`} title={staleTitle(stale)}>{ppOf(r.contribution)}</span>
        : <span />}</div>
      {view && (
        <div className="tv" data-topic-view={r.key}>
          {view.assessment && <div title={view.assessment}><span className="k">{S.assessmentNow}</span>{view.assessment}</div>}
          {view.outlook && <div title={view.publishers ? `${view.outlook}\n${view.publishers}` : view.outlook}><span className="k">{S.outlook}</span>{view.outlook}</div>}
        </div>
      )}
      {lines.length > 0 && (
        <ul className="tb">
          {lines.map((l) => (
            <li key={l.id} data-brief={l.id}>
              <span className="bh">{l.headline}</span>{l.date && <span className="dt"> · {l.date}</span>}
              {l.why && <div className="bw" title={l.why}>{l.why}</div>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Summary text with numbers and quoted thesis words in bold (rendered as text nodes, never as HTML). */
export function richSummary(text: string): ReactNode[] {
  const re = /(„[^”"]{1,80}[”"]|[+\-−]?\d+(?:[.,]\d+)?\s?(?:%|pp|pb|mld\s?\$|mln\s?\$|mld\s?z\u0142|mln\s?z\u0142|z\u0142|\$|€)(?:\s?r\/r|\s?m\/m)?)/g;
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
  /** Instrument display name + symbol, or the segment label (`rynek`) / old theme (`temat`), shown in list context. */
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
        <span className={`pd ${polarityCls(n.polarity)}`} title={S.polarity(POLARITY_WORD[n.polarity] ?? n.polarity)} />
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
          {onDismiss && !dismissed && <button className="icon-btn" title={S.dismissNote} aria-label={S.dismissNoteAria(n.title)} onClick={() => onDismiss(n)}>✕</button>}
        </span>
      </div>
      <div className="nt">{n.title}</div>
      {body && <div className={`ns ${open ? "open" : ""}`} onClick={() => setOpen((v) => !v)} title={open ? S.collapse : S.expand}>{richSummary(open ? body : body.split(/\n\s*\n/)[0])}</div>}
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
        {n.signal_id != null && (signalText ? <span>{signalText}</span> : <span className={`tag solid ${n.polarity === "negative" ? "neg" : n.polarity === "positive" ? "pos" : "muted"}`}>{S.signal}</span>)}
        {dismissed ? (
          <span>{S.dismissedOn(dm(n.dismissed_at))}{onRestore && canRestore && <> · <button className="lnk" onClick={() => onRestore(n)}>{S.restore}</button></>}</span>
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
    <span className="nrr">{S.dismissedOn(dm(n.dismissed_at))} · <button className="lnk" onClick={(e) => { e.stopPropagation(); onRestore(n); }}>{S.restore}</button></span>
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
              {n.sources.length > 0 && <button className="lnk" aria-expanded={src} onClick={() => setSrc((v) => !v)}>{S.sourcesN(n.sources.length)}</button>}
              {n.sources.length > 0 && onDismiss && !dismissed && <span aria-hidden>·</span>}
              {onDismiss && !dismissed && <button className="lnk" onClick={() => onDismiss(n)}>{S.dismiss}</button>}
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
  const srcLine = S.srcLine(n.sources.length, dm(n.observed_at));
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
          <div><span className="tag solid muted">{S.candDismissedOn(dm(n.dismissed_at))}</span></div>
          <div className="cc">{n.title}{context ? ` · ${context}` : ""}{back ? S.returnsEarliest(dm(back)) : ""}</div>
          {onRestore && canRestore && <div><button className="lnk" onClick={() => onRestore(n)}>{S.restore}</button></div>}
        </>
      ) : compact ? (
        <div className="cc">
          {crit.total > 0 ? <>{S.criteria} <b>{S.metOf(crit.met, crit.total)}</b>{crit.items.filter((c) => c.met).map((c, k) => <Fragment key={k}> · {richSummary(c.text)}</Fragment>)}</> : n.title}
          {context && !crit.total ? ` · ${context}` : ""}
        </div>
      ) : (
        <>
          {crit.total > 0 ? (
            <div className="crit">
              {crit.items.map((c, k) => <span key={k} className={c.met ? "" : "miss"}><i aria-label={c.met ? S.met : S.notMet}>{c.met ? "✓" : "·"}</i>{criterionText(c)}</span>)}
            </div>
          ) : <div className="cc">{n.title}</div>}
          {context && <div className="cc">{context}</div>}
        </>
      )}
      {!dismissed && (
        <div className="cact">
          {state?.agent ? <span className="tag agent"><i aria-hidden>A</i>{S.addedByAgent}</span>
            : watched ? <span className="tag solid muted">{S.watchedSince(dm(state?.watchedSince ?? acceptedAt(n) ?? today))}</span>
            : <>
              <button className="btn sm primary" disabled={busy} onClick={() => onWatch?.(n)} title={S.watchTitle}>{S.watch}</button>
              <button className="btn sm" disabled={busy} onClick={() => onDismiss?.(n)} title={S.dismissTitle}>{S.dismissBtn}</button>
            </>}
          <span className="spacer" />
          <span className="src">{srcLine}</span>
        </div>
      )}
    </div>
  );
}

/** Monospace command + `Kopiuj polecenie` (the app copies, Claude Code runs it; design answer 3). */
export function CopyCommand({ cmd, label = S.copyCommand, primary = true, showCmd = true, sm, done = S.copiedPaste, title }: {
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
      <div><b>{L.routineMenu}</b>{S.schedule}<code className="cmd wrap">{path}</code>{S.prompt}<code className="cmd">{ROUTINE_PROMPT}</code></div>
      <div className="acts">
        <CopyCommand cmd={ROUTINE_PROMPT} label={S.copyRoutine} primary={false} showCmd={false} sm done={S.copiedPasteApp} title={S.localRoutineTitle} />
        <CopyCommand cmd={path} label={S.copyFolder} primary={false} showCmd={false} sm done={S.copied} />
        {onSettings && <button className="lnk" onClick={onSettings}>{S.settingsLink}</button>}
      </div>
    </div>
  );
}
