// Sunday review: the `Co mówi research` block (research.md 1, implementation-plan item 33; span 3 between Co
// się zmieniło and Sygnały): theses whose health changed since the last review (`była aktualna`), themes
// with a direction change (`z rośnie na słabnie`), candidates since the last review with actions; the rest
// collapsed. A week without a run turns it into the not-run line with the copyable command. Also the
// `Research` row of Co się zmieniło and the decision form's `research z soboty: …` line.
import { type ReactNode, useState } from "react";
import { Widget } from "../../../../widgets";
import { dm, hm, plural, wdm } from "../../labels";
import { canRestore, useResearchActions } from "./data";
import {
  BOUNDARY, countsText, directionChange, HEALTH_LABEL, healthOf, latestRun, latestTitle, normDirection, normHealth, nNotes, researchCommand, runMinutes, runNotes, runTag,
} from "./logic";
import { CandidateCard } from "./primitives";
import { NotRun, type StripCtx, ThemeRow, ThesisRow, themeSub } from "./Strip";
import type { DigestResearch, ResearchNote, ResearchRun, ResearchSummary } from "./types";
import { localDay } from "../../../../time";

export function ReviewResearch({ ctx, runs, summary, candidates, digest, since, onSettings }: {
  ctx: StripCtx; runs: ResearchRun[]; summary: ResearchSummary | null | undefined; candidates: ResearchNote[] | null | undefined;
  digest: DigestResearch | null | undefined; since: string; onSettings: () => void;
}) {
  const [rest, setRest] = useState(false);
  const actions = useResearchActions(ctx.slug, ctx.onChanged);
  const tag = runTag(runs, ctx.today);
  const last = latestRun(runs);
  const ranInPeriod = digest?.ran_in_period ?? (!!last && (localDay(last.started_at) ?? "") >= since);
  if (!ranInPeriod) {
    const n = last ? runNotes(last) : null;
    return (
      <Widget title="Co mówi research" className="rsch" tags={<span className={`tag ${tag.tone || "warn"}`}>{tag.state === "stale" ? tag.text : `brak w tym tygodniu${last ? ` · ostatni ${dm(last.finished_at ?? last.started_at)}` : ""}`}</span>}
        controls={last ? <button className="lnk" onClick={() => ctx.onOpenResearch()}>notatki z {dm(last.started_at)}{n != null ? ` (${n})` : ""}</button> : undefined} body="tight"
        footer={<><span>rutyna: <b>sobota 07:00</b> · Claude Code · <button className="lnk" onClick={onSettings}>Ustawienia › Agent AI</button></span><span className="spacer" /><span>{BOUNDARY}</span></>}>
        <NotRun ctx={ctx} runs={runs} cmd={researchCommand(ctx.workspace?.path, ctx.slug)} />
      </Widget>
    );
  }
  const changed = digest?.theses_changed ?? [];
  const rows = (summary?.instruments ?? []).filter((s) => ctx.held.has(s.instrument_id));
  const changedRows = changed.map((c) => ({ c, s: rows.find((s) => s.instrument_id === c.instrument_id) })).filter((x) => x.s);
  const others = rows.filter((s) => !changed.some((c) => c.instrument_id === s.instrument_id));
  const noThesis = others.filter((s) => healthOf(s, ctx.today) === "no_thesis");
  const noNotes = others.filter((s) => !s.notes && !s.counts.supports && !s.counts.weakens && !s.counts.invalidates && !s.counts.neutral);
  const themesChanged = digest?.themes_changed ?? [];
  const themes = (summary?.themes ?? []).filter((t) => themesChanged.some((c) => c.theme === t.theme));
  const restThemes = (summary?.themes ?? []).filter((t) => !themesChanged.some((c) => c.theme === t.theme));
  const candIds = new Set(digest?.candidates ?? []);
  const cands = (candidates ?? []).filter((n) => candIds.size ? candIds.has(n.id) : (localDay(n.observed_at) ?? "") >= since);
  const newC = cands.filter((n) => !n.dismissed_at).length, dismissedC = cands.filter((n) => n.dismissed_at).length;
  const run = digest?.run ?? last!;
  const mins = runMinutes(run);
  const name = (id: number, fallback?: string | null) => ctx.held.get(id)?.name ?? fallback ?? `#${id}`;
  const sym = (id: number, fallback?: string | null) => ctx.held.get(id)?.symbol ?? fallback ?? null;
  return (
    <Widget title="Co mówi research" className="rsch" id="inv-review-research"
      tags={<span className="tag">{wdm(run.started_at)} · {nNotes(digest?.notes_count ?? runNotes(run) ?? 0)} · od {dm(since)}</span>}
      controls={<button className="lnk" onClick={() => ctx.onOpenResearch()}>wszystkie notatki i tematy</button>} body="tight"
      footer={<>
        <span>{wdm(run.started_at)} {hm(run.started_at)}{mins ? ` · ${mins} min` : ""}</span>
        <span><b>{digest?.notes_count ?? runNotes(run) ?? 0}</b> notatek</span>
        {typeof run.counts?.sources_checked === "number" && <span><b>{run.counts.sources_checked}</b> źródeł</span>}
        {digest?.counts && <span><b>{digest.counts.community}</b> ze społeczności (szum)</span>}
        {digest?.signals_count != null && <span><b>{digest.signals_count}</b> {plural(digest.signals_count, "sygnał", "sygnały", "sygnałów").replace(/^\d+ /, "")} z researchu</span>}
        <span className="spacer" /><span>{BOUNDARY}</span>
      </>}>
      <div className="rsch3">
        <div>
          <div className="rsec">Tezy <span className="cnt">· {changedRows.length ? `${plural(changedRows.length, "zmiana", "zmiany", "zmian")} od ostatniego przeglądu` : "bez zmian od ostatniego przeglądu"}</span></div>
          {changedRows.map(({ c, s }) => {
            const from = normHealth(c.from);
            const h = healthOf(s!, ctx.today);
            return (
              <ThesisRow key={c.instrument_id} s={s!} health={normHealth(c.to) ?? h} name={name(c.instrument_id, c.label ?? s!.label)} symbol={sym(c.instrument_id, c.symbol ?? s!.symbol)}
                sub={<>{from ? `była ${HEALTH_LABEL[from]}` : "nowa ocena"}{latestTitle(s!) ? ` · ${latestTitle(s!)}` : ""}</>}
                right={countsText(normHealth(c.to) ?? h, c.counts ?? s!.counts, { notes: s!.notes, latestPolarity: s!.latest_polarity })}
                onOpen={() => ctx.onOpenAsset(c.instrument_id)} />
            );
          })}
          {rest && others.map((s) => <ThesisRow key={s.instrument_id} s={s} health={healthOf(s, ctx.today)} name={name(s.instrument_id, s.label)} symbol={sym(s.instrument_id, s.symbol)} onOpen={() => ctx.onOpenAsset(s.instrument_id)} />)}
          {others.length > 0 && !rest && (
            <div className="rrow" style={{ gridTemplateColumns: "minmax(0, 1fr) auto" }}>
              <div><div className="nm">Pozostałe {plural(others.length, "pozycja", "pozycje", "pozycji")}</div>
                <div className="sub">{["bez zmian", noThesis.length ? `${noThesis.map((s) => sym(s.instrument_id, s.symbol) ?? name(s.instrument_id)).slice(0, 3).join(" i ")} bez tezy` : null, noNotes.length ? `${noNotes.length} bez notatek` : null].filter(Boolean).join(" · ")}</div></div>
              <button className="lnk" onClick={() => setRest(true)}>pokaż</button>
            </div>
          )}
        </div>
        <div>
          <div className="rsec">Tematy i trendy <span className="cnt">· {themesChanged.length ? `${plural(themesChanged.length, "zmiana", "zmiany", "zmian")} kierunku` : "bez zmian kierunku"}</span></div>
          {[...themes, ...restThemes].slice(0, 5).map((t) => {
            const ch = themesChanged.find((c) => c.theme === t.theme);
            const word = ch ? directionChange(ch.from, ch.to ?? t.direction) : null;
            const sub: ReactNode = word ? <>{themeSub(t, ctx.symOf).split(" · ").slice(0, 2).join(" · ")} · <b>{word}</b></> : undefined;
            return <ThemeRow key={t.theme} t={{ ...t, direction: ch?.to ?? normDirection(t.direction) }} sub={sub} symOf={ctx.symOf} onOpen={() => ctx.onOpenResearch(`theme=${encodeURIComponent(t.theme)}`)} />;
          })}
          {!summary?.themes.length && <div className="empty-line">Brak tematów w tym okresie.</div>}
        </div>
        <div>
          <div className="rsec">Kandydaci <span className="cnt">· {[newC ? plural(newC, "nowy", "nowe", "nowych") : "brak nowych", dismissedC ? plural(dismissedC, "odrzucony", "odrzucone", "odrzuconych") : null].filter(Boolean).join(" · ")}</span></div>
          {cands.filter((n) => !n.dismissed_at).slice(0, 3).map((n) => (
            <CandidateCard key={n.id} note={n} today={ctx.today} state={ctx.watched(n)} busy={actions.busy === n.id}
              onWatch={actions.watch} onDismiss={actions.dismiss} onRestore={actions.restore} canRestore={canRestore(n)} />
          ))}
          {!newC && <div className="empty-line">Brak nowych kandydatów{ctx.strategyVersion != null ? ` · kryteria strategii v${ctx.strategyVersion}` : ""}</div>}
        </div>
      </div>
    </Widget>
  );
}

/** `Research` row of Co się zmieniło: `14 notatek · 2 tezy osłabione (CDR, EIMI), 1 wzmocniona (KGH) · 2
 * kandydatów · niżej`. Null when no run happened in the period. */
export function researchChanges(o: { digest: DigestResearch | null | undefined; held: StripCtx["held"]; onJump: () => void }): ReactNode | null {
  const d = o.digest;
  if (!d || (!(d.ran_in_period ?? !!d.run) && !d.notes_count)) return null;
  const sym = (c: { instrument_id: number; symbol?: string | null; label?: string | null }) => o.held.get(c.instrument_id)?.symbol ?? c.symbol ?? c.label ?? `#${c.instrument_id}`;
  const weak = d.theses_changed.filter((c) => ["weak", "inv"].includes(normHealth(c.to) ?? ""));
  const sup = d.theses_changed.filter((c) => normHealth(c.to) === "sup");
  const parts = [
    weak.length ? `${plural(weak.length, "teza osłabiona", "tezy osłabione", "tez osłabionych")} (${weak.map(sym).join(", ")})` : null,
    sup.length ? `${plural(sup.length, "wzmocniona", "wzmocnione", "wzmocnionych")} (${sup.map(sym).join(", ")})` : null,
  ].filter(Boolean).join(", ");
  return (
    <>
      <b>{nNotes(d.notes_count)}</b>
      <span className="s">{parts ? ` · ${parts}` : ""}{d.candidates.length ? ` · ${plural(d.candidates.length, "kandydat", "kandydatów", "kandydatów")}` : ""} · </span>
      <button className="lnk" onClick={o.onJump}>niżej</button>
    </>
  );
}

/** Decision form effect line: `research z soboty: 2 notatki osłabiają tezę (premiera 2028, Q3) · otwórz notatki`. */
export function researchEffectLine(o: {
  instrumentId: number; digest: DigestResearch | null | undefined; summary: ResearchSummary | null | undefined; runs: ResearchRun[] | null | undefined; today: string;
}): { text: string; weekday: string } | null {
  const row = o.summary?.instruments.find((s) => s.instrument_id === o.instrumentId);
  const last = latestRun(o.runs ?? []);
  if (!row || !last) return null;
  const changed = o.digest?.theses_changed.find((c) => c.instrument_id === o.instrumentId);
  const c = row.counts;
  const rel = c.invalidates ? `${plural(c.invalidates, "notatka podważa", "notatki podważają", "notatek podważa")} tezę`
    : c.weakens ? `${plural(c.weakens, "notatka osłabia", "notatki osłabiają", "notatek osłabia")} tezę`
    : c.supports ? `${plural(c.supports, "notatka wzmacnia", "notatki wzmacniają", "notatek wzmacnia")} tezę` : null;
  if (!rel && !changed) return null;
  const day = new Date(`${localDay(last.started_at)}T12:00:00`).getDay();
  const weekday = day === 6 ? "z soboty" : `z ${dm(last.started_at)}`;
  return { text: `research ${weekday}: ${rel ?? "bez zmian"}${latestTitle(row) ? ` (${latestTitle(row)})` : ""}`, weekday };
}
