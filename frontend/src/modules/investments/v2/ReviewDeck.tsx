// The weekly review as a deck of cards over the home (reviewDeckLogic.ts has the logic): one context per card, from
// "is the world falling apart" down to the calendar, then a summary that closes the review. Swipe right (→, "Jasne,
// dalej") moves on, swipe left (←, "Wróć do tego") puts the card on the agenda for the research agent; every card
// takes a note for the agent. "Czytaj więcej" opens three bullets on the card, a note opens in full in a sheet.
// The deck is built once from the data at hand, so decisions taken on it do not reshuffle the cards.
import { type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { errorText } from "../../../core/messages";
import { useAsync } from "../../../hooks";
import { useModal, useToast } from "../../../ui";
import { postAcknowledge, postDecision, postSnooze } from "../api";
import { dm, money, pct, pp } from "../labels";
import { C } from "../../../common.strings.ts";
import { S } from "./ReviewDeck.strings.ts";
import { type DigestV2, getCalendar, invKey, type Performance, type SignalV2 } from "./api";
import { benchmarkLabel, changeSince, staleBenchmark } from "./logic";
import { getResearch } from "./research/api";
import { useMacro, useResearchActions, useResearchOverview, useSegments } from "./research/data";
import { noteSubject } from "./research/logic";
import type { DigestResearch, ResearchNote } from "./research/types";
import {
  CARD_ORDER, CARD_TITLE, type CardId, type DecideItem, deckCards, decideItems, openIdeas, sectorRows, sectorsTitle, summaryTitle, type Tone, topMovers,
  type ProposalLike, weekEvents, weeklySigma, worldVerdict,
} from "./reviewDeckLogic";
import "./reviewDeck.css";

type Verdict = "keep" | "flag";
export interface DeckStats {
  cards: { id: CardId; verdict: Verdict }[];
  agenda: { card: CardId; title: string; note: string | null }[];
  decisions: { subject: string; choice: string }[];
  skipped: CardId[];
}
type Card = CardId | "summary";
interface More { lead?: string; items: { text: ReactNode; noteId?: number; segment?: string | null }[] }

export type ReviewDeckData = ReturnType<typeof useReviewDeckData>;

/** Everything the deck shows, loaded on the home so the review button can count the cards; the calendar is
 * fetched only once the deck is open (`open`). `cards` follow the owner's strategy.yaml `review.cards`. */
export function useReviewDeckData({ slug, nonce, digest, perfWeek, perfYear, signals, proposals, names, open }: {
  slug: string; nonce: number; digest: DigestV2 | null | undefined; perfWeek: Performance | null | undefined; perfYear: Performance | null | undefined;
  signals: SignalV2[]; proposals: ProposalLike[]; names: Map<number, string>; open: boolean;
}) {
  const since = digest?.since ?? null;
  const seg = useSegments(slug, "1w", nonce);
  const macro = useMacro(slug, nonce);
  const research = useResearchOverview(slug, nonce);
  const notesQ = useAsync(() => (since ? getResearch(slug, { since, limit: 200 }) : Promise.resolve([] as ResearchNote[])), [slug, since],
    { key: since ? invKey(slug, "research", "since", since) : undefined });
  const cal = useAsync(() => (open ? getCalendar(slug) : Promise.resolve(null)), [slug, open]);
  const digestResearch = ((digest as { research?: DigestResearch | null } | null | undefined)?.research ?? null);
  const order = useMemo(() => {
    const own = (digest?.review?.cards ?? []).filter((c): c is CardId => (CARD_ORDER as string[]).includes(c));
    return own.length ? own : CARD_ORDER;
  }, [digest]);

  const week = changeSince(perfWeek?.points ?? [], since ?? "");
  const benchStale = staleBenchmark(perfWeek?.benchmark);
  const bench = benchStale ? null : week.bench;
  const sigma = useMemo(() => weeklySigma(perfYear?.points ?? []), [perfYear]);
  const verdict = worldVerdict(week.pct, bench, sigma);
  const ddNow = perfYear?.points.length ? perfYear.points[perfYear.points.length - 1].drawdown : null;
  const ddMax = perfYear?.summary?.max_drawdown?.depth ?? null;
  const sectors = useMemo(() => sectorRows(seg.data), [seg.data]);
  const movers = useMemo(() => topMovers(seg.data, names), [seg.data, names]);
  const events = useMemo(() => weekEvents(notesQ.data ?? []), [notesQ.data]);
  const macroChanges = useMemo(() => digestResearch?.macro_changes ?? [], [digestResearch]);
  const ready = !!digest && perfWeek !== undefined && perfYear !== undefined && !seg.loading && !notesQ.loading && !research.loading;
  const live = useMemo(() => {
    const d = decideItems(signals, digestResearch, names, proposals);
    const ideas = openIdeas(research.candidates ?? []);
    const { cards, skipped } = deckCards({ movers, sectors, events, macroChanges, decide: d.items, ideas }, order);
    return { cards, skipped, decide: d.items, more: d.more, ideas };
  }, [signals, digestResearch, names, proposals, research.candidates, movers, sectors, events, macroChanges, order]);
  return { seg, macro, research, notesQ, cal, digestResearch, week, benchStale, bench, sigma, verdict, ddNow, ddMax, sectors, movers, events, macroChanges, ready, live };
}

/** The review's entry in the portfolio hero: the deck glyph in a round button, a red notification badge with the
 * deck's card count while the review is due; the label says when it was done / comes next otherwise. */
export function ReviewButton({ name, due, count, last, next, onOpen }: {
  name: string; due: boolean; count: number; last: string | null; next: string | null; onOpen: () => void;
}) {
  const label = due ? `${name} · ${S.hdrCards(count)}` : `${name} · ${last ? S.hdrDone(dm(last)) : S.hdrOpen}`;
  return (
    <button className={`rv-btn${due ? " due" : ""}`} aria-label={label} onClick={onOpen}
      title={due ? `${name}: ${S.hdrCardsToReview(count)}` : `${name}${last ? ` · ${S.hdrDone(dm(last))}` : ""}${next ? ` · ${S.hdrNext(dm(next))}` : ""}`}>
      <DeckGlyph />
      {due && count > 0 && <span className="rv-badge" aria-hidden>{count}</span>}
    </button>
  );
}

/** The review's glyph: a hand of three cards, the front one upright (each card covers the one behind). */
export function DeckGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="rv-ico">
      <rect x="8.25" y="3.5" width="7.5" height="11.5" rx="1.6" transform="rotate(-24 12 21)" />
      <rect x="8.25" y="3.5" width="7.5" height="11.5" rx="1.6" transform="rotate(24 12 21)" />
      <rect x="8.25" y="2.5" width="7.5" height="11.5" rx="1.6" />
    </svg>
  );
}

export function ReviewDeck({ slug, data, digest, perfWeek, busy, suspended, note, onNote, onClose, onDone, onChanged, onOpenProposal }: {
  slug: string; data: ReviewDeckData; digest: DigestV2; perfWeek: Performance | null | undefined; busy?: boolean;
  /** A drawer opened from a card lies over the home: the deck hides meanwhile and keeps its place. */
  suspended?: boolean;
  /** The closing note (the caller keeps the draft for this window and sends it with the review). */
  note: string; onNote: (v: string) => void;
  onClose: () => void; onDone: (deck: DeckStats) => void; onChanged: () => void; onOpenProposal: (id: number) => void;
}) {
  const toast = useToast();
  const { seg, macro, research, notesQ, cal, week, benchStale, bench, sigma, verdict, ddNow, ddMax, sectors, movers, events, macroChanges } = data;
  const actions = useResearchActions(slug, onChanged);
  const title = digest.review?.name ?? S.weeklyReview;

  // ---- the deck, built once when the data has arrived (decisions taken on it do not reshuffle the cards) ----
  const [built, setBuilt] = useState<{ cards: Card[]; skipped: { id: CardId; why: string }[]; decide: DecideItem[]; more: number; ideas: ResearchNote[] } | null>(null);
  useEffect(() => {
    if (built || !data.ready) return;
    setBuilt({ ...data.live, cards: [...data.live.cards, "summary"] });
  }, [data.ready]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- deck state ---------------------------------------------------------------------------------------------
  const [i, setI] = useState(0);
  const [hist, setHist] = useState<number[]>([]);
  const [verdicts, setVerdicts] = useState<Partial<Record<CardId, Verdict>>>({});
  const [notes, setNotes] = useState<Partial<Record<CardId, string>>>({});
  const [noteOpen, setNoteOpen] = useState<Partial<Record<CardId, boolean>>>({});
  const [detail, setDetail] = useState(false);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<string | null>(null);
  const [sheet, setSheet] = useState<ResearchNote | "loading" | null>(null);
  const [flying, setFlying] = useState<Verdict | null>(null);
  const cards = built?.cards ?? [];
  const current = cards[i] as Card | undefined;

  const panel = useRef<HTMLDivElement>(null);
  useModal(panel, true, () => { if (sheet) setSheet(null); else if (detail) setDetail(false); else onClose(); }, { focus: "panel" });

  const advance = (v: Verdict) => {
    if (!current || current === "summary" || flying) return;
    setFlying(v);
    window.setTimeout(() => {
      setVerdicts((m) => ({ ...m, [current]: v }));
      setHist((h) => [...h, i]);
      setI((k) => k + 1);
      setDetail(false);
      setFlying(null);
      panel.current?.focus();
    }, matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 240);
  };
  const undo = () => {
    if (!hist.length) return;
    const k = hist[hist.length - 1];
    setHist((h) => h.slice(0, -1));
    setVerdicts((m) => { const n = { ...m }; delete n[cards[k] as CardId]; return n; });
    setI(k);
    setDetail(false);
  };

  const openNote = async (noteId: number, segment?: string | null) => {
    const local = (notesQ.data ?? []).find((n) => n.id === noteId) ?? (research.candidates ?? []).find((n) => n.id === noteId);
    if (local) { setSheet(local); return; }
    setSheet("loading");
    try {
      const list = await getResearch(slug, segment ? { segment, include_expired: true } : { include_expired: true, limit: 500 });
      setSheet(list.find((n) => n.id === noteId) ?? null);
    } catch (e) { setSheet(null); toast(S.noteLoadFailed(errorText(e)), 4000); }
  };

  const decide = async (item: DecideItem, action: string, label: string) => {
    if (pending) return;
    if (item.kind === "proposal") { onOpenProposal(item.proposalId!); return; }
    if (item.kind === "thesis") { setChoices((c) => ({ ...c, [item.key]: label })); return; }
    setPending(item.key);
    try {
      if (action === "snooze") {
        const until = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
        await postSnooze(slug, item.signalId!, until);
      } else if (action === "ack") await postAcknowledge(slug, item.signalId!);
      else await postDecision(slug, item.signalId!, { action, reason: S.decisionReason });
      setChoices((c) => ({ ...c, [item.key]: label }));
      onChanged();
    } catch (e) { toast(S.decisionFailed(errorText(e)), 5000); } finally { setPending(null); }
  };

  const finish = () => {
    if (!built) return;
    const shown = built.cards.filter((c): c is CardId => c !== "summary");
    const agenda = shown.filter((id) => verdicts[id] === "flag" || (notes[id] ?? "").trim())
      .map((id) => ({ card: id, title: CARD_TITLE[id], note: (notes[id] ?? "").trim() || null }));
    const decisions = built.decide.filter((d) => choices[d.key]).map((d) => ({ subject: d.title, choice: choices[d.key] }));
    onDone({
      cards: shown.map((id) => ({ id, verdict: verdicts[id] ?? "keep" })), agenda, decisions, skipped: built.skipped.map((s) => s.id),
    });
  };

  const onKey = (e: ReactKeyboardEvent) => {
    if ((e.target as HTMLElement).closest("textarea, input")) return;
    if (sheet) return;
    if (e.key === "ArrowRight") { e.preventDefault(); advance("keep"); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); advance("flag"); }
    else if (e.key === "ArrowUp" && current !== "summary") { e.preventDefault(); setDetail(true); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setDetail(false); }
    else if (e.key === "z" || e.key === "Backspace") { e.preventDefault(); undo(); }
    else if (e.key === "n" && current && current !== "summary") { e.preventDefault(); setNoteOpen((m) => ({ ...m, [current]: !m[current] })); }
  };

  // ---- card content -----------------------------------------------------------------------------------------
  const sigmaText = sigma != null ? S.typicalWeek(pct(sigma)) : null;
  const cardFor = (id: CardId): { tone: Tone; pill: string; title: string; body: ReactNode; more: More | null } => {
    switch (id) {
      case "world": {
        const max = Math.max(Math.abs(week.pct ?? 0), Math.abs(bench ?? 0), 0.0001);
        const risk = macro.data?.regimes.find((r) => r.key === "risk");
        const briefs = (seg.data?.segments ?? []).filter((s) => s.weight > 0 && s.briefs?.length).sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution)).slice(0, 2);
        const items: More["items"] = [];
        if (risk?.brief) items.push({ text: <><b>{risk.brief.headline}.</b> {risk.brief.why}</>, noteId: risk.brief.note_id, segment: "macro_risk" });
        else if (risk?.summary) items.push({ text: <><b>{risk.label}: {risk.state_label}.</b> {risk.summary}</> });
        for (const ch of macroChanges.slice(0, 2)) items.push({ text: <><b>{ch.label}:</b> {ch.from_label} → {ch.to_label} ({S.since(dm(ch.since))})</> });
        for (const s of briefs) { const b = s.briefs![0]; items.push({ text: <><b>{s.label}: {b.headline}.</b> {b.why}</>, noteId: b.note_id, segment: s.segment }); }
        return {
          tone: verdict.tone, pill: verdict.pill, title: verdict.title,
          body: (
            <>
              <div className="rd-big">
                <span className={`v ${week.pct == null ? "" : week.pct >= 0 ? "pos" : "neg"}`}>{week.pct != null ? pct(week.pct, true) : "-"}</span>
                {week.money != null && <span className={`m ${week.money >= 0 ? "pos" : "neg"}`}>{money(week.money, perfWeek?.base_currency ?? "PLN", true)}</span>}
                <span className="muted">{S.since(dm(digest.since))}</span>
              </div>
              <div className="rd-cmp">
                <CmpRow label={S.yourPortfolio} v={week.pct} max={max} />
                {benchStale ? <div className="muted" title={benchStale.title}>{benchStale.label}</div> : bench != null && <CmpRow label={benchmarkLabel(perfWeek?.benchmark)} v={bench} max={max} bench />}
              </div>
              <div className="rd-ctx">
                {ddNow != null && <>{S.fromHigh} <b>{pct(ddNow)}</b>{ddMax != null && <>{S.maxDrawdownYear}<b>{pct(ddMax)}</b></>}. </>}
                {sigmaText}
              </div>
            </>
          ),
          more: items.length ? { lead: S.marketLead, items } : null,
        };
      }
      case "sectors": {
        const t = sectorsTitle(sectors, week.pct);
        const max = Math.max(...sectors.map((r) => Math.abs(r.contribution)), 0.0001);
        const items = (seg.data?.segments ?? []).filter((s) => s.briefs?.length && sectors.some((r) => r.key === s.segment)).slice(0, 3)
          .map((s) => ({ text: <><b>{s.label}: {s.briefs![0].headline}.</b> {s.briefs![0].why}</>, noteId: s.briefs![0].note_id, segment: s.segment }));
        return {
          ...t,
          body: (
            <>
              <div className="rd-div">
                {sectors.map((r) => (
                  <div className="r" key={r.key}>
                    <span className="n">{r.label}<small>{r.currency ? S.fxVsPln : `${r.weight != null ? S.weight(pct(r.weight)) : ""}${r.ret != null ? ` · ${pct(r.ret, true)}` : ""}`}</small></span>
                    <span className="tr"><i className={`${r.contribution >= 0 ? "pos" : "neg"}${r.currency ? " cur" : ""}`} style={{ width: `${(Math.abs(r.contribution) / max) * 50}%` }} /></span>
                    <span className={`p ${r.contribution >= 0 ? "pos" : "neg"}`}>{pp(r.contribution * 100)}</span>
                  </div>
                ))}
              </div>
              <div className="rd-hint">{S.ppHint}</div>
            </>
          ),
          more: items.length ? { lead: S.sectorsLead, items } : null,
        };
      }
      case "positions": {
        const col = (h: string, l: typeof movers.down) => (
          <div><h4>{h}</h4><div className="rd-mv">{l.length ? l.map((m) => <div className="r" key={m.id}><span>{m.label}</span><b className={m.ret >= 0 ? "pos" : "neg"}>{pct(m.ret, true)}</b></div>) : <div className="muted">{S.none}</div>}</div></div>
        );
        const worst = movers.down[0], best = movers.up[0];
        const title = worst && (!best || Math.abs(worst.ret) >= Math.abs(best.ret)) ? S.fellMost(worst.label) : best ? S.roseMost(best.label) : S.noBigMoves;
        return {
          tone: "info", pill: S.positions(movers.all.length), title,
          body: <div className="rd-cols">{col(S.down, movers.down)}{col(S.up, movers.up)}</div>,
          more: movers.all.length > movers.down.length + movers.up.length
            ? { lead: S.allPositionsLead, items: [...movers.all].reverse().map((m) => ({ text: <>{m.label} <b className={m.ret >= 0 ? "pos" : "neg"}>{pct(m.ret, true)}</b> · {pp(m.contribution * 100)}{S.ofResult}</> })) }
            : null,
        };
      }
      case "events": {
        const rows = events.map((e) => ({ e, s: noteSubject(e.note) }));
        return {
          tone: "warn", pill: S.events(rows.length + macroChanges.length),
          title: rows.length ? `${rows[0].e.note.title}.` : S.marketChanged,
          body: (
            <div className="rd-tl">
              {macroChanges.map((c) => <div className="r" key={`m:${c.key}`}><div className="d"><b>{dm(c.since)}</b></div><div><div className="t">{c.label}: {c.to_label}</div><div className="i">{S.before}{c.from_label}</div></div></div>)}
              {rows.map(({ e, s }) => (
                <div className="r" key={e.note.id}>
                  <div className="d"><b>{dm(e.note.observed_at)}</b></div>
                  <div><div className="t">{e.note.title}</div><div className="i">{s.name}{e.note.thesis_relation === "invalidates" ? S.relInvalidates : e.note.thesis_relation === "weakens" ? S.relWeakens : e.note.thesis_relation === "supports" ? S.relSupports : ""}</div></div>
                </div>
              ))}
            </div>
          ),
          more: rows.length ? { lead: S.detailsLead, items: rows.map(({ e }) => ({ text: <><b>{e.note.title}.</b> {clip(e.note.summary, 220)}</>, noteId: e.note.id })) } : null,
        };
      }
      case "decide": {
        const list = built?.decide ?? [];
        const done = list.filter((d) => choices[d.key]).length;
        return {
          tone: "warn", pill: S.items(list.length),
          title: list.length === 1 ? S.oneWaits : S.manyWait(list.length),
          body: (
            <>
              <div className="rd-dec">
                {list.map((d) => (
                  <div className={`it${choices[d.key] ? " done" : ""}`} key={d.key}>
                    <div className="h"><span className={`k ${d.tone}`}>{d.tag}</span>{choices[d.key] && <span className="st">✓ {choices[d.key]}</span>}</div>
                    <div className="t">{d.title}</div>
                    <div className="w">{d.why}</div>
                    <div className="acts">
                      {d.actions.map((a, k) => (
                        <button key={a.action} className={choices[d.key] === a.label ? "on" : k === 0 && !choices[d.key] ? "pri" : ""} disabled={(!!choices[d.key] && d.kind !== "proposal") || pending === d.key}
                          onClick={() => decide(d, a.action, a.label)}>{a.label}</button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              <div className="rd-hint">{S.resolved(done, list.length)}{built?.more ? S.moreInSignals(built.more) : ""}{S.noTrade}</div>
            </>
          ),
          more: null,
        };
      }
      case "ideas": {
        const list = built?.ideas ?? [];
        return {
          tone: "info", pill: S.candidates(list.length),
          title: list.length === 1 ? S.oneIdea : S.manyIdeas(list.length),
          body: (
            <div className="rd-dec">
              {list.map((n) => {
                const s = noteSubject(n);
                const state = choices[`i:${n.id}`];
                return (
                  <div className={`it${state ? " done" : ""}`} key={n.id}>
                    <div className="h"><span className="k pos">{S.candidate}{n.details?.entry_type ? ` · ${n.details.entry_type === "trend" ? S.trend : n.details.entry_type === "sentiment_correction" ? S.sentimentCorrection : S.specialSituation}` : ""}</span>{state && <span className="st">✓ {state}</span>}</div>
                    <div className="t">{s.name}{s.sym ? <span className="muted"> · {s.sym}</span> : null}</div>
                    <div className="w">{n.details?.context ?? clip(n.summary, 160)}</div>
                    <div className="acts">
                      <button className={state ? "" : "pri"} disabled={!!state || actions.busy === n.id} onClick={async () => { await actions.watch(n); setChoices((c) => ({ ...c, [`i:${n.id}`]: S.watching })); }}>{S.watch}</button>
                      <button disabled={!!state || actions.busy === n.id} onClick={async () => { await actions.dismiss(n); setChoices((c) => ({ ...c, [`i:${n.id}`]: S.dismissed })); }}>{S.notInterested}</button>
                    </div>
                  </div>
                );
              })}
            </div>
          ),
          more: { lead: S.ideasLead, items: list.map((n) => ({ text: <><b>{noteSubject(n).name}:</b> {clip(n.summary, 220)}</>, noteId: n.id })) },
        };
      }
      case "calendar": {
        const evs = (cal.data?.events ?? []).slice(0, 8);
        const mine = evs.filter((e) => e.instrument_id != null);
        return {
          tone: "info", pill: cal.data ? S.until(dm(cal.data.to)) : "...",
          title: cal.loading ? S.loadingCalendar : !evs.length ? S.calmTwoWeeks : mine.length ? S.nextTwoWeeksOf(mine.slice(0, 2).map((e) => e.title.replace(/^(?:Wyniki kwartalne|Quarterly results) /, S.resultsShort)).join(", ")) : S.nextTwoWeeks,
          body: cal.loading ? <div className="skeleton" style={{ height: 160 }} /> : (
            <>
              <div className="rd-tl">
                {evs.map((e, k) => (
                  <div className="r" key={k}>
                    <div className="d"><b>{dm(e.date)}</b>{e.time ?? ""}</div>
                    <div><div className="t">{e.title}</div>
                      <div className="i">
                        {e.country_label && <span className="tag">{e.country_label}</span>}
                        {e.held === true && <span className="tag mine">{S.yourPosition}</span>}
                        {e.held === false && <span className="tag mine">{S.watched}</span>}
                        {e.kind === "research" && <span className="tag">{S.fromResearch}</span>}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              {(cal.data?.stale || cal.error) && <div className="rd-hint">{cal.error ? S.calendarUnavailable(String(cal.error)) : S.calendarStale}</div>}
              <div className="rd-hint">{S.calendarSources}</div>
            </>
          ),
          more: null,
        };
      }
    }
  };

  // ---- render -----------------------------------------------------------------------------------------------
  const left = cards.length ? cards.length - 1 - i : 0;
  return createPortal(
    <div className={`rd${suspended ? " suspended" : ""}`} role="dialog" aria-modal="true" aria-label={title} ref={panel} tabIndex={-1} onKeyDown={onKey}>
      <div className="rd-top">
        <button className="x" onClick={onClose} aria-label={S.closeNoSave} title={S.closeTitle}>×</button>
        <div className="c"><div className="t">{!built ? title : current === "summary" ? S.lastCard : S.left(left)}</div>
          <div className="s">{title} · {dm(digest.since)} - {dm(digest.as_of)}</div></div>
        <button className="u" onClick={undo} disabled={!hist.length}>{C.undo}</button>
      </div>
      <div className="rd-dots" aria-hidden>{cards.map((c, k) => <i key={k} className={k === i ? "on" : c !== "summary" && verdicts[c] ? verdicts[c] : ""} />)}</div>
      <div className="rd-deck">
        {!built ? <div className="rd-card"><div className="rd-load"><div className="skeleton" style={{ height: 28, width: "60%" }} /><div className="skeleton" style={{ height: 140 }} /><div className="muted">{S.building}</div></div></div>
          : cards.slice(i, i + 3).reverse().map((c) => {
            const k = cards.indexOf(c);
            const depth = k - i;
            // The next card shows through while the top one flies off (no buttons: it cannot be used yet).
            if (depth > 1 || (depth === 1 && c === "summary")) return <div key={c} className={`rd-card back${depth}`} aria-hidden />;
            if (depth === 1 && c !== "summary") {
              const n = cardFor(c);
              return (
                <div key={c} className="rd-card back1" aria-hidden>
                  <div className="rd-ch"><span className="eyebrow">{CARD_TITLE[c]}</span><span className={`pill ${n.tone}`}>{n.pill}</span></div>
                  <h2>{n.title}</h2>
                  {c !== "decide" && c !== "ideas" && <div className="rd-cb">{n.body}</div>}
                </div>
              );
            }
            if (c === "summary") return <SummaryCard key={c} built={built} verdicts={verdicts} notes={notes} choices={choices} closing={note} setClosing={onNote} busy={busy} onFinish={finish} />;
            const d = cardFor(c);
            return (
              <SwipeCard key={c} flying={flying} onSwipe={advance}>
                <div className="rd-ch"><span className="eyebrow">{CARD_TITLE[c]}</span><span className={`pill ${d.tone}`}>{d.pill}</span></div>
                <h2>{d.title}</h2>
                {!detail || !d.more ? <div className="rd-cb">{d.body}</div> : (
                  <div className="rd-cb more">
                    {d.more.lead && <b>{d.more.lead}</b>}
                    <ul>{d.more.items.map((it, k) => <li key={k}>{it.text}{it.noteId != null && <> <button className="lnk" onClick={() => openNote(it.noteId!, it.segment)}>{S.fullNote}</button></>}</li>)}</ul>
                  </div>
                )}
                {noteOpen[c] && <div className="rd-note"><textarea autoFocus aria-label={S.agentNote} placeholder={S.agentNotePlaceholder} value={notes[c] ?? ""} onChange={(e) => setNotes((m) => ({ ...m, [c]: e.target.value }))} /></div>}
                <div className="rd-cf">
                  {d.more && (detail ? <button className="lnk" onClick={() => setDetail(false)}>{S.backArrow}</button> : <button className="lnk" onClick={() => setDetail(true)}>{S.readMore}</button>)}
                  <button className={`lnk note${(notes[c] ?? "").trim() ? " has" : ""}`} onClick={() => setNoteOpen((m) => ({ ...m, [c]: !m[c] }))}>{(notes[c] ?? "").trim() ? S.agentNoteEdit : S.agentNoteAdd}</button>
                </div>
              </SwipeCard>
            );
          })}
      </div>
      {built && current !== "summary" && (
        <div className="rd-btns">
          <button className="f" onClick={() => advance("flag")}>{S.flag}</button>
          <button className="k" onClick={() => advance("keep")}>{S.keep}</button>
        </div>
      )}
      <div className="rd-keys"><kbd>←</kbd>{S.keyFlag}<kbd>→</kbd>{S.keyNext}<kbd>↑</kbd>{S.keyMore}<kbd>N</kbd>{S.keyNote}<kbd>Z</kbd>{S.keyUndo}</div>
      {sheet && (
        <div className="rd-sheet" onClick={(e) => { if (e.target === e.currentTarget) setSheet(null); }}>
          <div className="in" role="document">
            <button className="close" onClick={() => setSheet(null)}>{C.close}</button>
            {sheet === "loading" ? <div className="skeleton" style={{ height: 160 }} /> : (
              <>
                <span className="eyebrow">{S.researchNote(dm(sheet.observed_at))}</span>
                <h3>{sheet.title}</h3>
                {sheet.summary.split(/\n{2,}/).map((p, k) => <p key={k}>{p}</p>)}
                {sheet.sources.length > 0 && (
                  <div className="srcs"><b>{S.sources}</b>{sheet.sources.map((s, k) => <a key={k} href={s.url} target="_blank" rel="noreferrer">{s.publisher ? `${s.publisher}: ` : ""}{s.title ?? s.url}</a>)}</div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n).replace(/\s+\S*$/, "")}…` : s);

function CmpRow({ label, v, max, bench }: { label: string; v: number | null; max: number; bench?: boolean }) {
  const w = v == null ? 0 : (Math.abs(v) / max) * 100;
  return (
    <div className="r">
      <span className={bench ? "muted" : ""}>{label}</span>
      <div className={`bar${v != null && v >= 0 ? " up" : ""}`}><i className={bench ? "bench" : v != null && v >= 0 ? "pos" : "neg"} style={{ width: `${w}%` }} /></div>
      <span className={`p${bench ? " muted" : ""}`}>{v != null ? pct(v, true) : "-"}</span>
    </div>
  );
}

/** The top card: drag sideways to answer (120 px), the stamp shows which way it goes. */
function SwipeCard({ flying, onSwipe, children }: { flying: Verdict | null; onSwipe: (v: Verdict) => void; children: ReactNode }) {
  const el = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; dx: number; on: boolean } | null>(null);
  const [dx, setDx] = useState(0);
  const down = (e: ReactPointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button, textarea, input, a")) return;
    drag.current = { x: e.clientX, y: e.clientY, dx: 0, on: false };
  };
  const move = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    d.dx = e.clientX - d.x;
    if (!d.on && Math.abs(d.dx) > 8 && Math.abs(d.dx) > Math.abs(e.clientY - d.y)) { d.on = true; el.current?.setPointerCapture(e.pointerId); }
    if (d.on) setDx(d.dx);
  };
  const up = () => {
    const d = drag.current;
    drag.current = null;
    if (!d?.on) return;
    if (Math.abs(d.dx) > 120) onSwipe(d.dx > 0 ? "keep" : "flag");
    else setDx(0);
  };
  const out = flying ? (flying === "keep" ? 1 : -1) * Math.max(window.innerWidth, 700) : dx;
  const style = out ? { transform: `translateX(${out}px) rotate(${out / 18}deg)`, ...(flying ? { opacity: 0 } : {}) } : undefined;
  return (
    <div ref={el} className={`rd-card top${drag.current?.on ? "" : " anim"}`} style={style} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      <div className="stamp k" style={{ opacity: flying === "keep" ? 1 : Math.max(0, Math.min(1, dx / 120)) }}>{S.stampKeep}</div>
      <div className="stamp f" style={{ opacity: flying === "flag" ? 1 : Math.max(0, Math.min(1, -dx / 120)) }}>{S.stampFlag}</div>
      {children}
    </div>
  );
}

function SummaryCard({ built, verdicts, notes, choices, closing, setClosing, busy, onFinish }: {
  built: { cards: Card[]; skipped: { id: CardId; why: string }[]; decide: DecideItem[] };
  verdicts: Partial<Record<CardId, Verdict>>; notes: Partial<Record<CardId, string>>; choices: Record<string, string>;
  closing: string; setClosing: (v: string) => void; busy?: boolean; onFinish: () => void;
}) {
  const shown = built.cards.filter((c): c is CardId => c !== "summary");
  const agenda = shown.filter((id) => verdicts[id] === "flag" || (notes[id] ?? "").trim());
  const decided = built.decide.filter((d) => choices[d.key]);
  return (
    <div className="rd-card top">
      <div className="rd-ch"><span className="eyebrow">{S.summary}</span></div>
      <h2>{summaryTitle(agenda.length)}</h2>
      <div className="rd-cb">
        <div className="rd-stat">
          <div><b>{shown.length}</b><span>{S.statCards(shown.length)}</span></div><div><b>{decided.length}</b><span>{S.statDecisions(decided.length)}</span></div><div><b>{agenda.length}</b><span>{S.statAgent}</span></div>
        </div>
        {agenda.length > 0 && <><h4>{S.discussWithAgent}</h4>{agenda.map((id) => <div className="rd-ln" key={id}><b>{CARD_TITLE[id]}</b>{(notes[id] ?? "").trim() ? <> · <q>{notes[id]!.trim()}</q></> : S.noNote}</div>)}</>}
        {decided.length > 0 && <><h4>{S.decisions}</h4>{decided.map((d) => <div className="rd-ln" key={d.key}>{d.title} · <b>{choices[d.key]}</b></div>)}</>}
        {built.skipped.length > 0 && <div className="rd-hint">{S.skipped(built.skipped.map((s) => `${CARD_TITLE[s.id]} (${s.why})`).join(", "))}</div>}
        <h4>{S.reviewNote}</h4>
        <textarea id="inv-review-note" aria-label={S.reviewNote} placeholder={S.reviewNotePlaceholder} value={closing} onChange={(e) => setClosing(e.target.value)} />
        <button className="rd-close" onClick={onFinish} disabled={busy}>{S.closeReview}</button>
        <div className="rd-hint">{S.agentHint}</div>
      </div>
    </div>
  );
}
