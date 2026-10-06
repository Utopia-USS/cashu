// Research in the asset detail (asset-detail.md 5-6, F9; replaces research.md 1 + 3-4 for the instrument context),
// plugged into the slots (v2/assetSlots.ts): the `Research` widget in the right column (one summary row with the
// 8-week sentiment, then one row per note: relation icon + title, a click expands the summary and the sources),
// and the health pill in the Teza header (its tooltip carries the counts). `?note=<id>` opens and highlights the
// row. No boundary footer and no recommendation UI on this page (Q24).
import { useEffect, useMemo, useRef, useState } from "react";
import { Widget } from "../../../../widgets";
import type { AssetSlotProps } from "../assetSlots";
import { wdm } from "../../labels";
import { bumpResearch, canRestore, useInstrumentNotes, useResearchActions } from "./data";
import { postResearchRead } from "./api";
import {
  addDays, countsText, direction, DIRECTION_LABEL, DIRECTION_TONE, healthOf, healthStale, isExpired, latestRun, nNotes, relationCounts, runTag,
  sentiment8w, thesisHealth, weekLabels, weekStarts, windowStart,
} from "./logic";
import { HealthPill, NoteRow, SentimentBars } from "./primitives";
import type { HealthKey } from "./types";
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

/** Watched instruments show the Research block only when they have notes (asset-detail.md 10); held ones always. */
export function useResearchShown(p: AssetSlotProps): boolean {
  const r = useAssetHealth(p);
  // Live notes only: dismissed or expired ones alone do not bring the block back.
  return p.held || (r.notes ?? []).some((n) => !n.dismissed_at && !isExpired(n, r.today));
}

/** `Research` widget (right column of the asset detail). */
export function AssetResearch(p: AssetSlotProps) {
  const r = useAssetHealth(p);
  const actions = useResearchActions(p.slug, p.onChanged);
  const [older, setOlder] = useState(false);
  const hlId = p.noteId ? Number(p.noteId) : null;
  const [openId, setOpenId] = useState<number | null>(hlId);
  const notes = useMemo(() => [...(r.notes ?? [])].sort((a, b) => b.observed_at.localeCompare(a.observed_at)), [r.notes]);
  const cutoff = addDays(r.today, -30);
  const recent = notes.filter((n) => (localDay(n.observed_at) ?? "") >= cutoff && !isExpired(n, r.today) && (!n.dismissed_at || canRestore(n)));
  const old = notes.filter((n) => !recent.includes(n) && !n.dismissed_at);
  // Q10: opening the Research section marks the instrument's unread agent notes read (once per mount; a failed
  // call is silent and the marker stays). A real mark re-reads the research views (strip rows, the chip).
  const marked = useRef(false);
  useEffect(() => {
    if (marked.current || !r.notes || !r.notes.some((n) => n.unread === true)) return;
    marked.current = true;
    postResearchRead(p.slug, { instrument_id: p.instrumentId })
      .then((res) => { p.onRead?.(p.instrumentId); if (res.marked > 0) bumpResearch(p.slug); })
      .catch(() => undefined);
  }, [r.notes]); // eslint-disable-line react-hooks/exhaustive-deps

  // Deep link: open older notes when the target is among them, open its row and scroll it into view.
  useEffect(() => {
    if (hlId == null || !r.notes) return;
    if (old.some((n) => n.id === hlId)) setOlder(true);
    setOpenId(hlId);
    const t = setTimeout(() => document.getElementById(`note-${hlId}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 120);
    return () => clearTimeout(t);
  }, [hlId, !!r.notes]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!r.ran) {
    return (
      <Widget title="Research" id="asset-research" className="rsch" tags={<span className="tag">jeszcze nie działał</span>} body="tight">
        <div className="muted" style={{ fontSize: 13 }}>Brak notatek.</div>
      </Widget>
    );
  }
  const last = latestRun(r.runs ?? []);
  const tag = runTag(r.runs ?? [], r.today);
  const weeks = r.summary?.week_starts?.length === 8 ? r.summary.week_starts : weekStarts(r.today);
  const values = r.row?.sentiment_8w?.length ? r.row.sentiment_8w : sentiment8w(notes, r.today);
  const dir = r.row?.direction ? r.row.direction : direction(values);
  const dirKey = (["up", "down", "flat"].includes(String(dir)) ? dir : direction(values)) as "up" | "down" | "flat";
  const live = recent.filter((n) => !n.dismissed_at);
  const all = notes.filter((n) => !n.dismissed_at).length;
  const shown = older ? [...recent, ...old] : recent;
  return (
    <Widget title="Research" id="asset-research" className="rsch"
      tags={tag.state === "fresh" && last
        ? <span className="sub">{nNotes(live.length)} · {wdm(last.finished_at ?? last.started_at)}</span>
        : <span className={`tag ${tag.tone}`}>{tag.text}</span>}
      controls={notes.length > recent.length && old.length > 0 ? <button className="lnk" onClick={() => setOlder((v) => !v)}>{older ? "tylko 30 dni" : `wszystkie (${all})`}</button> : undefined}
      body="tight">
      <div className="rsum">
        <div className="fact"><div className="l">Sentyment 8 tyg.</div><div className={`v sm ${DIRECTION_TONE[dirKey]}`}>{DIRECTION_LABEL[dirKey]}</div></div>
        <SentimentBars values={values} labels={weekLabels(weeks)} size="lg" />
      </div>
      {!shown.length ? <div className="muted" style={{ fontSize: 13, padding: "8px 0" }}>Brak notatek (30 dni)</div> : shown.map((n) => (
        <NoteRow key={n.id} note={n} today={r.today} hl={hlId === n.id} open={openId === n.id} onToggle={() => setOpenId((v) => (v === n.id ? null : n.id))}
          onDismiss={actions.dismiss} onRestore={actions.restore} canRestore={canRestore(n)} />
      ))}
    </Widget>
  );
}

/** Health pill in the Teza header (only after research ran): the only thesis status on the page; its tooltip
 * carries the counts (`2 osłabiają · 30 dni`). */
export function ThesisHealth(p: AssetSlotProps) {
  const r = useAssetHealth(p);
  if (!r.ran || !p.held) return null;
  const latest = (r.notes ?? []).find((n) => !n.dismissed_at);
  const counts = r.row?.counts ?? relationCounts(r.window);
  const title = [countsText(r.health, counts, { notes: r.window.length, latestPolarity: latest?.polarity }), r.health === "no_thesis" ? null : "30 dni"].filter(Boolean).join(" · ");
  return <HealthPill state={r.health} muted={healthStale(r.runs ?? [], r.today)} pre={!!r.row?.health_predates_thesis} title={title || undefined} />;
}
