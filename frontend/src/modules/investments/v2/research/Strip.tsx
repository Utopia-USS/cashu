// Research strip on the Inwestycje home (research.md 1, implementation-plan item 30): span 3, three calm
// columns `Tezy` (thesis health per held position with 8-week sentiment) | `Tematy i trendy` (direction) |
// `Kandydaci` (compact cards with Obserwuj / Odrzuć). Rendered only after the first run (density rule).
// Header tag = the latest run; a week without a run collapses the strip to the not-run line.
import { type ReactNode, useState } from "react";
import { useAsync } from "../../../../hooks";
import { Widget } from "../../../../widgets";
import { dm, plural, wdm } from "../../labels";
import { canRestore, useResearchActions } from "./data";
import { getResearch } from "./api";
import {
  BOUNDARY, countsText, DIRECTION_LABEL, DIRECTION_TONE, healthOf, healthStale, isLive, lastDone, latestRun, nextSaturday, normDirection, nNotes,
  orderTheses, researchCommand, runNotes, runTag, workspacePath, acceptedAt, watchItemId, latestTitle,
} from "./logic";
import { CandidateCard, type CandidateState, CopyCommand, HealthPill, ScheduleHow, SentimentBars } from "./primitives";
import type { InstrumentSummary, ResearchNote, ResearchRun, ResearchSummary, ThemeSummary, Workspace } from "./types";
import { InstLabel, type InstLike } from "../InstLabel";

export interface StripCtx {
  slug: string;
  today: string;
  /** Held instruments: id -> display name, symbol, weight, the instrument (identity label). */
  held: Map<number, { name: string; symbol: string | null; weight: number | null; inst?: InstLike }>;
  /** Watched instruments: instrument id or symbol -> since / agent (candidate cards show `obserwowany od`). */
  watched: (n: ResearchNote) => CandidateState | undefined;
  strategyVersion: number | null;
  workspace: Workspace | null | undefined;
  onOpenAsset: (id: number, noteId?: number) => void;
  onOpenResearch: (query?: string) => void;
  onChanged: () => void;
  /** Ustawienia › Agent AI (workspace and the routine). */
  onSettings?: () => void;
  /** Symbol of an instrument id (theme rows list instrument ids). */
  symOf: (id: number) => string | null;
}

export function ResearchStrip({ ctx, runs, summary, candidates }: {
  ctx: StripCtx; runs: ResearchRun[]; summary: ResearchSummary | null | undefined; candidates: ResearchNote[] | null | undefined;
}) {
  const tag = runTag(runs, ctx.today);
  const last = latestRun(runs);
  const actions = useResearchActions(ctx.slug, ctx.onChanged);
  const cmd = researchCommand(ctx.workspace?.path, ctx.slug);
  if (tag.state === "stale") {
    return (
      <Widget title="Research" className="rsch" tags={<span className={`tag ${tag.tone}`}>{tag.text}</span>}
        controls={<button className="lnk" onClick={() => ctx.onOpenResearch()}>otwórz notatki</button>} body="tight"
        footer={<><span>rutyna: <b>sobota 07:00</b> · Claude Code</span><span className="spacer" /><span>{BOUNDARY}</span></>}>
        <NotRun ctx={ctx} runs={runs} cmd={cmd} />
      </Widget>
    );
  }
  const stale = healthStale(runs, ctx.today);
  const theses = orderTheses((summary?.instruments ?? []).filter((s) => ctx.held.has(s.instrument_id)).map((s) => ({
    s, health: healthOf(s, ctx.today), weight: ctx.held.get(s.instrument_id)?.weight ?? s.weight ?? null, label: ctx.held.get(s.instrument_id)?.name ?? s.label ?? "",
  })));
  const themes = summary?.themes ?? [];
  const open = (candidates ?? []).filter((n) => !n.dismissed_at);
  const fresh = open.filter((n) => !ctx.watched(n) && !acceptedAt(n) && watchItemId(n) == null);
  const c = last?.counts ?? {};
  const signals = typeof c.signals === "number" ? c.signals : null;
  const sources = typeof c.sources_checked === "number" ? c.sources_checked : null;
  const community = c.by_kind?.community ?? null;
  return (
    <Widget title="Research" className="rsch" id="inv-research" tags={<span className={`tag ${tag.tone}`}>{tag.text}</span>}
      controls={<>
        {tag.state === "failed" && <CopyCommand cmd={cmd} label="Uruchom ponownie" primary={false} showCmd={false} />}
        <button className="lnk" onClick={() => ctx.onOpenResearch()}>wszystkie</button>
      </>}
      body="tight"
      footer={<>
        {last && runNotes(last) != null && <span><b>{runNotes(last)}</b> {nNotes(runNotes(last)!).replace(/^\d+ /, "")}</span>}
        {sources != null && <span><b>{sources}</b> {plural(sources, "źródło", "źródła", "źródeł").replace(/^\d+ /, "")}</span>}
        {community != null && <span><b>{community}</b> ze społeczności (szum)</span>}
        {typeof signals === "number" && <span><b>{signals}</b> {plural(signals, "sygnał", "sygnały", "sygnałów").replace(/^\d+ /, "")} z researchu</span>}
        <span className="spacer" />
        <span>następny: <b>{wdm(nextSaturday(ctx.today))}</b> · rutyna Claude Code</span>
      </>}>
      <div className="rsch3">
        <div>
          <div className="rsec">Tezy <span className="cnt">· sentyment 8 tyg.</span></div>
          {theses.length ? theses.slice(0, 6).map(({ s, health }) => (
            <ThesisRow key={s.instrument_id} s={s} health={health} muted={stale} name={ctx.held.get(s.instrument_id)?.name ?? s.label ?? `#${s.instrument_id}`}
              symbol={ctx.held.get(s.instrument_id)?.symbol ?? s.symbol ?? null} inst={ctx.held.get(s.instrument_id)?.inst} onOpen={() => ctx.onOpenAsset(s.instrument_id)} />
          )) : <div className="empty-line">{last?.status === "running" ? "Przebieg trwa…" : "Brak notatek (30 dni)."}</div>}
          {theses.length > 6 && <div className="rsec"><button className="lnk" onClick={() => ctx.onOpenResearch("scope=positions")}>pozostałe {theses.length - 6}</button></div>}
        </div>
        <div>
          <div className="rsec">Tematy i trendy <span className="cnt">· {themes.length}</span></div>
          {themes.length ? themes.slice(0, 5).map((t) => <ThemeRow key={t.theme} t={t} symOf={ctx.symOf} onOpen={() => ctx.onOpenResearch(`theme=${encodeURIComponent(t.theme)}`)} />)
            : <div className="empty-line">Brak tematów.</div>}
        </div>
        <div>
          <div className="rsec">Kandydaci <span className="cnt">· {fresh.length ? `${plural(fresh.length, "nowy", "nowe", "nowych")} wg strategii${ctx.strategyVersion != null ? ` v${ctx.strategyVersion}` : ""}` : "0"}</span></div>
          {open.length ? (
            <div className="cands">
              {open.slice(0, 2).map((n) => (
                <CandidateCard key={n.id} note={n} compact today={ctx.today} state={ctx.watched(n)} busy={actions.busy === n.id}
                  onWatch={actions.watch} onDismiss={actions.dismiss} onRestore={actions.restore} canRestore={canRestore(n)} />
              ))}
            </div>
          ) : <div className="empty-line">Brak nowych kandydatów</div>}
          {open.length > 2 && <div className="rsec"><button className="lnk" onClick={() => ctx.onOpenResearch("scope=candidates")}>wszyscy kandydaci ({open.length})</button></div>}
        </div>
      </div>
    </Widget>
  );
}

export function ThesisRow({ s, health, name, symbol, inst, muted, sub, right, onOpen }: {
  s: InstrumentSummary; health: ReturnType<typeof healthOf>; name: string; symbol: string | null; muted?: boolean;
  /** The instrument (positions, watchlist): the identity label (compact) instead of name + symbol text. */
  inst?: InstLike;
  sub?: ReactNode; right?: ReactNode; onOpen?: () => void;
}) {
  const line = sub ?? latestTitle(s) ?? (s.last_researched_at ? `research ${dm(s.last_researched_at)}` : "bez notatek");
  return (
    <div className="rrow">
      {inst ? (
        <div style={{ minWidth: 0 }}>
          <InstLabel density="compact" inst={inst} text={name} onOpen={onOpen ? () => onOpen() : undefined} sub={<span title={latestTitle(s) ?? undefined}>{line}</span>} />
        </div>
      ) : (
        <div style={{ minWidth: 0 }}>
          <div className="nm">{onOpen ? <button className="nm" onClick={onOpen}>{name}</button> : name}{symbol && symbol !== name && <span className="sym">{symbol}</span>}</div>
          <div className="sub" title={latestTitle(s) ?? undefined}>{line}</div>
        </div>
      )}
      <SentimentBars values={s.sentiment_8w} />
      <div className="r">
        <HealthPill state={health} muted={muted} />
        <span className="cnt">{right ?? countsText(health, s.counts, { notes: s.notes, latestPolarity: s.latest_polarity })}</span>
      </div>
    </div>
  );
}

/** Instrument symbols of a theme (the server sends ids). */
export const themeSymbols = (t: ThemeSummary, symOf: (id: number) => string | null) =>
  t.instruments.map((x) => (typeof x === "number" ? symOf(x) : x)).filter((x): x is string => !!x);

export function themeSub(t: ThemeSummary, symOf: (id: number) => string | null): string {
  return [plural(t.notes, "notatka", "notatki", "notatek"), ...themeSymbols(t, symOf).slice(0, 3)].join(" · ");
}

export function ThemeRow({ t, sub, symOf, onOpen }: { t: ThemeSummary; sub?: ReactNode; symOf: (id: number) => string | null; onOpen?: () => void }) {
  const d = normDirection(t.direction);
  return (
    <div className="rrow">
      <div style={{ minWidth: 0 }}>
        <div className="nm">{onOpen ? <button className="nm" onClick={onOpen}>{t.theme}</button> : t.theme}</div>
        <div className="sub">{sub ?? themeSub(t, symOf)}</div>
      </div>
      <SentimentBars values={t.sentiment_8w} />
      <div className="r"><span className={`tag ${DIRECTION_TONE[d]}`}>{DIRECTION_LABEL[d]}</span></div>
    </div>
  );
}

/** "Research not run this week" (research.md 7): one line with what is still valid, the command,
 * `Kopiuj polecenie`, `Zaplanuj w Claude Code` (the local routine steps, never `/schedule`: a cloud routine
 * cannot reach the local MCP server). */
export function NotRun({ ctx, runs, cmd }: { ctx: Pick<StripCtx, "slug" | "today" | "workspace" | "onSettings">; runs: ResearchRun[]; cmd: string }) {
  const [how, setHow] = useState(false);
  const done = lastDone(runs);
  const notesQ = useAsync(() => getResearch(ctx.slug, {}).catch(() => [] as ResearchNote[]), [ctx.slug]);
  const live = (notesQ.data ?? []).filter((n) => isLive(n, ctx.today));
  const lastExpiry = live.map((n) => n.expires_at ?? "").sort().slice(-1)[0];
  const at = done ? done.finished_at ?? done.started_at : null;
  const n = done ? runNotes(done) : null;
  return (
    <div className="norun">
      <div className="grow">
        <b>Rutyna nie uruchomiła się.</b>
        {at && (
          <div className="d">
            ostatni research {wdm(at)}{n != null ? ` · ${nNotes(n)}` : ""}{notesQ.data ? ` · ważnych ${live.length}${lastExpiry ? ` do ${dm(lastExpiry)}` : ""}` : ""}
          </div>
        )}
      </div>
      <CopyCommand cmd={cmd} />
      <button className="btn" onClick={() => setHow((v) => !v)} aria-expanded={how}>Zaplanuj w Claude Code</button>
      {how && <ScheduleHow path={workspacePath(ctx.workspace?.path, ctx.slug)} onSettings={ctx.onSettings} />}
    </div>
  );
}
