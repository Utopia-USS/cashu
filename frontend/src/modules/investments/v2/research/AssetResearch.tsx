// Research in the asset drawer (research.md 1 + 3-5, implementation-plan item 32), plugged into FE-INT's
// slots (v2/assetSlots.ts): the `Research` widget in the right column (health summary, 8-week sentiment with
// date labels, note cards of this instrument, older notes behind `pokaż`, boundaries in the footer), the health
// pill in the Teza header, a relation chip after the thesis field a note touches, the header's research note
// and research entries in the "Sygnały i decyzje" timeline. `?note=<id>` scrolls to and highlights the card.
import { useEffect, useMemo, useState } from "react";
import { Widget } from "../../../../widgets";
import type { AssetSlotProps, AssetTimelineEntry, ThesisField } from "../assetSlots";
import { dm } from "../../labels";
import { canRestore, useInstrumentNotes, useResearchActions } from "./data";
import {
  addDays, BOUNDARY, chipsFromFields, countsText, direction, DIRECTION_LABEL, DIRECTION_TONE, fieldChips, healthOf, healthStale, isExpired, lastNonEmpty, latestRun, nNotes,
  normField, normRelation, POLARITY_WORD, signalWord, RELATION_LABEL, relationCounts, runTag, sentiment8w, thesisHealth, weekLabels, weekStarts, windowStart,
} from "./logic";
import { HealthPill, NoteCard, RelationChip, SentimentBars } from "./primitives";
import type { HealthKey, ResearchNote } from "./types";
import { localDay } from "../../../../time";

const todayIso = () => {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
};

/** Health of the drawer's position: the summary's value, else derived from the notes (30 days, reset on edit). */
function useAssetHealth(p: AssetSlotProps) {
  const d = useInstrumentNotes(p.slug, p.instrumentId);
  const today = d.summary?.as_of?.slice(0, 10) ?? todayIso();
  const notes = d.notes ?? [];
  const from = windowStart(today, p.thesis?.updated_at ?? null);
  const window = notes.filter((n) => !n.dismissed_at && !isExpired(n, today) && (localDay(n.observed_at) ?? "") >= from && n.kind !== "candidate");
  const researchedAt = d.row?.last_researched_at ?? null;
  const health: HealthKey = d.row?.health ? healthOf(d.row, today)
    : thesisHealth({ hasThesis: !!p.thesis, notes, today, thesisEditedAt: p.thesis?.updated_at ?? null, researchedAt });
  return { ...d, today, window, health, ran: (d.runs?.length ?? 0) > 0 };
}

/** `Research · <symbol>` widget (right column of the drawer). */
export function AssetResearch(p: AssetSlotProps) {
  const r = useAssetHealth(p);
  const actions = useResearchActions(p.slug, p.onChanged);
  const [older, setOlder] = useState(false);
  const notes = useMemo(() => [...(r.notes ?? [])].sort((a, b) => b.observed_at.localeCompare(a.observed_at)), [r.notes]);
  const cutoff = addDays(r.today, -30);
  const recent = notes.filter((n) => (localDay(n.observed_at) ?? "") >= cutoff && !isExpired(n, r.today) && (!n.dismissed_at || canRestore(n)));
  const old = notes.filter((n) => !recent.includes(n) && !n.dismissed_at);
  const hlId = p.noteId ? Number(p.noteId) : null;

  // Deep link: open older notes when the target is among them, then scroll it into view.
  useEffect(() => {
    if (hlId == null || !r.notes) return;
    if (old.some((n) => n.id === hlId)) setOlder(true);
    const t = setTimeout(() => document.getElementById(`note-${hlId}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 120);
    return () => clearTimeout(t);
  }, [hlId, !!r.notes]); // eslint-disable-line react-hooks/exhaustive-deps

  const title = <>Research</>;
  if (!r.ran) {
    return (
      <Widget title={title} tags={<span className="tag">jeszcze nie działał</span>} body="tight" footer={<span>{BOUNDARY}</span>}>
        <div className="muted" style={{ fontSize: 13 }}>Brak notatek.</div>
      </Widget>
    );
  }
  const last = latestRun(r.runs ?? []);
  const tag = runTag(r.runs ?? [], r.today);
  const inLast = last ? notes.filter((n) => n.run_id === last.id && !n.dismissed_at).length : 0;
  const weeks = r.summary?.week_starts?.length === 8 ? r.summary.week_starts : weekStarts(r.today);
  const values = r.row?.sentiment_8w?.length ? r.row.sentiment_8w : sentiment8w(notes, r.today);
  const dir = r.row?.direction ? r.row.direction : direction(values);
  const latest = notes.find((n) => !n.dismissed_at);
  const counts = r.row?.counts ?? relationCounts(r.window);
  const lastScore = lastNonEmpty(values);
  const dirKey = (["up", "down", "flat"].includes(String(dir)) ? dir : direction(values)) as "up" | "down" | "flat";
  const muted = healthStale(r.runs ?? [], r.today);
  const oldRel = relationCounts(old);
  return (
    <Widget title={title} id="asset-research" className="rsch"
      tags={<span className={`tag ${tag.state === "fresh" ? "" : tag.tone}`}>{tag.state === "fresh" && last ? `${tag.text.split(" · ")[0]} · ${nNotes(inLast)}` : tag.text}</span>}
      controls={notes.length > recent.length ? <button className="lnk" onClick={() => setOlder((v) => !v)}>{older ? "tylko 30 dni" : `wszystkie (${notes.filter((n) => !n.dismissed_at).length})`}</button> : undefined}
      body="tight"
      footer={<span>{BOUNDARY}</span>}>
      <div className="hsum">
        <div className="facts">
          <div className="fact"><div className="l">Teza</div><div className="v sm" style={{ marginTop: 3 }}><HealthPill state={r.health} muted={muted} /></div>
            <div className="d">{[countsText(r.health, counts, { notes: r.window.length, latestPolarity: latest?.polarity }), r.health === "no_thesis" ? null : "30 dni"].filter(Boolean).join(" · ")}</div></div>
          <div className="fact"><div className="l">Sentyment 8 tyg.</div><div className={`v sm ${DIRECTION_TONE[dirKey]}`}>{DIRECTION_LABEL[dirKey]}</div>
            <div className="d">{latest ? `ostatnio ${POLARITY_WORD[latest.polarity] ?? latest.polarity} · siła ${latest.strength}` : lastScore != null ? `ostatni tydzień ${lastScore > 0 ? "+" : ""}${lastScore.toFixed(1)}` : "brak notatek"}</div></div>
        </div>
        <div>
          <div className="fact" style={{ marginBottom: 4 }}><div className="l">Tydzień po tygodniu</div></div>
          <SentimentBars values={values} labels={weekLabels(weeks)} size="lg" />
        </div>
      </div>
      {!recent.length && !older ? <div className="muted" style={{ fontSize: 13, padding: "8px 0" }}>Brak notatek (30 dni){r.row?.last_researched_at ? ` · research ${dm(r.row.last_researched_at)}` : ""}</div> : null}
      {(older ? [...recent, ...old] : recent).map((n) => (
        <NoteCard key={n.id} note={n} today={r.today} context="instrument" hl={hlId === n.id} onDismiss={actions.dismiss} onRestore={actions.restore} canRestore={canRestore(n)}
          signalText={signalWord(n)} />
      ))}
      {!older && old.length > 0 && (
        <div className="note dim" style={{ paddingTop: 8 }}>
          <div className="nh"><span className="muted">starsze: {nNotes(old.length)} z {old.slice(0, 2).map((n) => dm(n.observed_at)).join(" i ")}{oldRel.supports ? ` (${oldRel.supports} wzmacnia)` : oldRel.weakens ? ` (${oldRel.weakens} osłabia)` : ""} ·</span>
            <button className="lnk" onClick={() => setOlder(true)}>pokaż</button></div>
        </div>
      )}
    </Widget>
  );
}

/** Health pill in the Teza header (only after research ran; `aktualna` shows here only). */
export function ThesisHealth(p: AssetSlotProps) {
  const r = useAssetHealth(p);
  if (!r.ran || !p.held) return null;
  return <HealthPill state={r.health} muted={healthStale(r.runs ?? [], r.today)} />;
}

/** `1 notatka osłabia` after the thesis field the notes touch. */
export function ThesisFieldChip(p: AssetSlotProps & { field: ThesisField }) {
  const r = useAssetHealth(p);
  const chips = useMemo(() => (r.row?.fields ? chipsFromFields(r.row.fields) : fieldChips(r.window)), [r.row, r.window]);
  const c = chips.get(normField(p.field) ?? p.field);
  if (!c) return null;
  return <RelationChip relation={c.relation} text={c.text} />;
}

/** Header polarity line: `research osłabia tezę`. */
export function ResearchHeaderNote(p: AssetSlotProps) {
  const r = useAssetHealth(p);
  if (!r.ran || !p.held) return null;
  const word = r.health === "inv" ? "podważa tezę" : r.health === "weak" ? "osłabia tezę" : r.health === "sup" ? "wzmacnia tezę" : null;
  if (!word) return null;
  return <> · <span className={`pd ${r.health === "sup" ? "pos" : "neg"}`} aria-hidden /> research {word}</>;
}

/** Timeline rows: research notes that created signals or bear on the thesis (`Research: osłabia tezę`). */
export function useResearchTimeline(p: AssetSlotProps): AssetTimelineEntry[] {
  const d = useInstrumentNotes(p.slug, p.instrumentId);
  const today = d.summary?.as_of?.slice(0, 10) ?? todayIso();
  return useMemo(() => (d.notes ?? []).filter((n) => !n.dismissed_at && (n.signal_id != null || ["supports", "weakens", "invalidates"].includes(normRelation(n.thesis_relation))))
    .map((n: ResearchNote): AssetTimelineEntry => {
      const rel = normRelation(n.thesis_relation);
      const tail = [`siła ${n.strength}`, signalWord(n), isExpired(n, today) && n.expires_at ? `wygasła ${dm(n.expires_at)}` : null].filter(Boolean).join(" · ");
      return {
        at: n.observed_at, dot: n.polarity === "positive" ? "pos" : n.polarity === "negative" ? "neg" : "",
        head: `Research: ${rel === "none" || rel === "neutral" ? "notatka" : RELATION_LABEL[rel]}`, main: n.title, tail,
        action: { label: "notatka", onClick: () => document.getElementById(`note-${n.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }) },
      };
    }), [d.notes, today]);
}
