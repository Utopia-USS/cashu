// Research view `#/{slug}/investments.portfolio/research` (research.md 1 + 7, implementation-plan item 34):
// page head with the scope and kind filters and `Uruchom teraz` (copies the command), the run strip, Tematy i
// trendy, Kandydaci, Notatki (two-column cards, filters, sort, paging by 6, j / k / x / Enter), Przebiegi and
// Zakres i zasady. Before the first run: the empty state with the three steps (skill, first run, schedule).
import { useMemo, useState } from "react";
import { useAsync } from "../../../../hooks";
import { Seg, SetupSteps, type SetupStepItem, Skeleton, Tag } from "../../../../ui";
import { Grid, type GridItem, Widget } from "../../../../widgets";
import { useShortcuts } from "../../hooks";
import { dm, hm, plural, wdm } from "../../labels";
import { getResearch } from "./api";
import { canRestore, useResearchActions, useResearchOverview, useWorkspace } from "./data";
import {
  BOUNDARY, DIRECTION_LABEL, DIRECTION_TONE, healthOf, isExpired, KIND_FILTER, latestRun, nextSaturday, normDirection, normRelation,
  nNotes, polarityCls, RELATION_LABEL, researchCommand, ROUTINE_MENU, ROUTINE_PROMPT, runMinutes, runNotes, runTag, workspacePath,
} from "./logic";
import { CandidateCard, type CandidateState, CopyCommand, NoteCard, ScheduleHow, SentimentBars } from "./primitives";
import { themeSymbols } from "./Strip";
import type { ResearchNote, ResearchRun, ResearchSummary, ThemeSummary, Workspace } from "./types";

type Scope = "all" | "positions" | "watched" | "candidates" | "themes";

export interface ResearchPageProps {
  slug: string;
  today: string;
  privacy: string;
  held: Map<number, { name: string; symbol: string | null; weight: number | null }>;
  watchedIds: Map<number, { name: string; symbol: string | null }>;
  watched: (n: ResearchNote) => CandidateState | undefined;
  symOf: (id: number) => string | null;
  strategyVersion: number | null;
  initial: URLSearchParams;
  onBack: () => void;
  onOpenAsset: (id: number, noteId?: number) => void;
  onSettings: () => void;
  onChanged: () => void;
}

const PRIVACY_SHORT: Record<string, string> = { strict: "ścisły", amounts: "z kwotami" };

export function ResearchPage(p: ResearchPageProps) {
  const [nonce, setNonce] = useState(0);
  const refresh = () => { setNonce((n) => n + 1); p.onChanged(); };
  const { runs, summary, candidates, loading } = useResearchOverview(p.slug, nonce);
  const ws = useWorkspace(p.slug);
  const [scope, setScope] = useState<Scope>(() => (p.initial.get("scope") as Scope) || (p.initial.get("theme") ? "themes" : "all"));
  const [kind, setKind] = useState<string | null>(() => p.initial.get("kind"));
  const [theme, setTheme] = useState<string | null>(() => p.initial.get("theme"));
  const cmd = researchCommand(ws.data?.path, p.slug);
  const head = (
    <>
      <nav className="crumb" aria-label="Ścieżka"><button onClick={p.onBack}>Inwestycje</button> › <span>Research</span></nav>
      <div className="pagehead">
        <h2 className="ph">Research</h2>
        {!!runs?.length && <Filters scope={scope} setScope={(s) => { setScope(s); if (s !== "themes") setTheme(null); }} kind={kind} setKind={setKind} summary={summary} candidates={candidates} held={p.held} watchedIds={p.watchedIds} />}
        <span className="spacer" />
        {ws.data?.exists !== false && <CopyCommand cmd={cmd} label="Uruchom teraz" primary={false} showCmd={false} />}
      </div>
    </>
  );
  if (loading && !runs) return <>{head}<Skeleton h={160} r={12} /></>;
  if (!runs?.length) return <>{head}<Grid items={[{ id: "empty", span: 3, node: <EmptyResearch cmd={cmd} path={workspacePath(ws.data?.path, p.slug)} ws={ws.data} onSettings={p.onSettings} /> }]} /></>;

  const items: GridItem[] = [
    { id: "run", span: 3, node: <RunStrip runs={runs} summary={summary} candidates={candidates ?? []} today={p.today} strategyVersion={p.strategyVersion} privacy={p.privacy} held={p.held} /> },
    { id: "themes", span: 2, node: <ThemesTable themes={summary?.themes ?? []} selected={theme} symOf={p.symOf} onSelect={(t) => { setTheme(t); setScope(t ? "themes" : "all"); setTimeout(() => document.getElementById("rsch-notes")?.scrollIntoView({ behavior: "smooth", block: "start" }), 30); }} /> },
    { id: "cands", span: 1, node: <CandidatesWidget slug={p.slug} today={p.today} notes={candidates ?? []} watched={p.watched} strategyVersion={p.strategyVersion} onChanged={refresh} /> },
    { id: "notes", span: 3, node: <NotesList slug={p.slug} today={p.today} nonce={nonce} scope={scope} kind={kind} theme={theme} held={p.held} watchedIds={p.watchedIds} onClearTheme={() => setTheme(null)} onChanged={refresh} onOpenAsset={p.onOpenAsset} /> },
    { id: "runs", span: 2, node: <RunsTable runs={runs} symOf={p.symOf} /> },
    { id: "scope", span: 1, node: <ScopeWidget held={p.held.size} watched={p.watchedIds.size} strategyVersion={p.strategyVersion} privacy={p.privacy} path={ws.data?.path ?? `~/Documents/finanse/${p.slug}`} /> },
  ];
  return <>{head}<Grid items={items} /></>;
}

function Filters({ scope, setScope, kind, setKind, summary, candidates, held, watchedIds }: {
  scope: Scope; setScope: (s: Scope) => void; kind: string | null; setKind: (k: string | null) => void; summary: ResearchSummary | null | undefined;
  candidates: ResearchNote[] | null | undefined; held: Map<number, unknown>; watchedIds: Map<number, unknown>;
}) {
  const inst = summary?.instruments ?? [];
  const nHeld = inst.filter((s) => held.has(s.instrument_id)).length;
  const nWatched = inst.filter((s) => watchedIds.has(s.instrument_id) && !held.has(s.instrument_id)).length;
  const nCand = (candidates ?? []).filter((n) => !n.dismissed_at).length;
  const nThemes = summary?.themes.length ?? 0;
  return (
    <>
      <Seg<Scope> quiet label="Zakres" value={scope} onChange={setScope} items={[
        ["Wszystko", "all"], [`Pozycje · ${nHeld}`, "positions"], [`Obserwowane · ${nWatched}`, "watched"], [`Kandydaci · ${nCand}`, "candidates"], [`Tematy · ${nThemes}`, "themes"],
      ]} />
      <Seg<string | null> quiet label="Rodzaj" value={kind} onChange={setKind} items={[["Wszystkie rodzaje", null], ...KIND_FILTER.map(([l, v]) => [l, v] as [string, string])]} />
    </>
  );
}

// ---- run strip ------------------------------------------------------------------------------------------

function RunStrip({ runs, summary, candidates, today, strategyVersion, privacy, held }: {
  runs: ResearchRun[]; summary: ResearchSummary | null | undefined; candidates: ResearchNote[]; today: string; strategyVersion: number | null; privacy: string;
  held: Map<number, { name: string; symbol: string | null }>;
}) {
  const last = latestRun(runs)!;
  const tag = runTag(runs, today);
  const at = last.finished_at ?? last.started_at;
  const day = new Date(`${last.started_at.slice(0, 10)}T12:00:00`).getDay();
  const dayName = ["niedziela", "poniedziałek", "wtorek", "środa", "czwartek", "piątek", "sobota"][day];
  const mins = runMinutes(last);
  const inst = (summary?.instruments ?? []).map((s) => ({ s, h: healthOf(s, today) }));
  const weak = inst.filter((x) => x.h === "weak" || x.h === "inv");
  const sup = inst.filter((x) => x.h === "sup");
  const themes = summary?.themes ?? [];
  const down = themes.filter((t) => normDirection(t.direction) === "down").length, up = themes.filter((t) => normDirection(t.direction) === "up").length;
  const openC = candidates.filter((n) => !n.dismissed_at).length, dismissedC = candidates.filter((n) => n.dismissed_at).length;
  const c = last.counts ?? {};
  const nHeld = inst.filter((x) => held.has(x.s.instrument_id)).length;
  const sym = (id: number) => held.get(id)?.symbol ?? inst.find((x) => x.s.instrument_id === id)?.s.symbol ?? `#${id}`;
  const scheduled = last.scheduled ?? last.created_by === "agent";
  return (
    <section className="w hero run" aria-label="Ostatni research">
      <div className="h1">
        <div className="l">Ostatni research</div>
        <div className="v sm">{dayName} {dm(last.started_at)}</div>
        <div className="d">
          <span className={`state ${last.status === "failed" ? "fail" : last.status === "running" ? "live" : ""}`}><i aria-hidden />{last.status === "running" ? "trwa" : last.status === "failed" ? "przerwany" : "zakończony"}</span>
          {" · "}{hm(last.started_at)}{last.finished_at ? ` - ${hm(at)}` : ""}{mins ? ` · ${mins} min` : ""}
        </div>
      </div>
      <div className="hf">
        <div className="fact"><div className="l">Notatki</div><div className="v">{runNotes(last) ?? "-"}</div><div className="d">{plural(nHeld, "pozycja", "pozycje", "pozycji")}{typeof c.watchlist === "number" ? ` · ${c.watchlist} obserwowane` : ""}</div></div>
        <div className="fact"><div className="l">Tezy</div><div className="v">{weak.length ? `${weak.length} osłabione` : sup.length ? `${sup.length} wzmocnione` : "bez zmian"}</div>
          <div className="d">{[weak.slice(0, 3).map((x) => sym(x.s.instrument_id)).join(", "), sup.length && weak.length ? `${sup.length} wzmocniona` : null].filter(Boolean).join(" · ") || "-"}</div></div>
        <div className="fact"><div className="l">Tematy</div><div className="v">{themes.length}</div><div className="d">{`${down} ${down === 1 ? "słabnie" : "słabną"} · ${up} ${up === 1 ? "rośnie" : "rosną"}`}</div></div>
        <div className="fact"><div className="l">Kandydaci</div><div className="v">{openC}</div><div className="d">{dismissedC ? `${plural(dismissedC, "odrzucony", "odrzuceni", "odrzuconych")}` : "nikt nie odrzucony"}</div></div>
        {typeof c.signals === "number" && <div className="fact"><div className="l">Sygnały</div><div className="v">{c.signals}</div><div className="d">z notatek o sile 3 albo podważających tezę</div></div>}
      </div>
      <div className="hr">
        {tag.state === "fresh" || tag.state === "none" ? <span className="tag solid pos">następny: {wdm(nextSaturday(today))} 07:00</span> : <span className={`tag ${tag.tone}`}>{tag.text}</span>}
        <div className="meta">{[strategyVersion != null ? `strategia v${strategyVersion}` : null, `poziom ${PRIVACY_SHORT[privacy] ?? privacy}`].filter(Boolean).join(" · ")}</div>
        <div className="meta">{scheduled ? "rutyna Claude Code" : "na żądanie · Claude Code"}</div>
      </div>
    </section>
  );
}

// ---- themes ---------------------------------------------------------------------------------------------

type ThemeSort = "change" | "notes" | "name";
function ThemesTable({ themes, selected, symOf, onSelect }: { themes: ThemeSummary[]; selected: string | null; symOf: (id: number) => string | null; onSelect: (t: string | null) => void }) {
  const [sort, setSort] = useState<ThemeSort>("change");
  const rank = (t: ThemeSummary) => ({ down: 0, up: 1, flat: 2 })[normDirection(t.direction)];
  const list = [...themes].sort((a, b) => (sort === "name" ? a.theme.localeCompare(b.theme, "pl") : sort === "notes" ? b.notes - a.notes : rank(a) - rank(b) || b.notes - a.notes));
  return (
    <Widget title="Tematy i trendy" count={`${themes.length} · sentyment 8 tyg.`}
      controls={<select value={sort} onChange={(e) => setSort(e.target.value as ThemeSort)} aria-label="Sortowanie tematów">
        <option value="change">sortuj: zmiana kierunku</option><option value="notes">sortuj: liczba notatek</option><option value="name">sortuj: nazwa</option>
      </select>}
      body="tight" footer={<><span>kierunek: siła notatek z 4 tyg. wobec poprzednich 4</span><span className="spacer" /><span>temat znika po 60 dniach bez notatek</span></>}>
      {!list.length ? <div className="muted" style={{ fontSize: 13 }}>Brak tematów. Research zapisuje tematy sektorowe i makro razem z notatkami.</div> : (
        <>
          <div className="theme head"><span>temat</span><span>8 tygodni</span><span>ostatnia notatka</span><span style={{ textAlign: "right" }}>kierunek · instrumenty</span></div>
          {list.map((t) => {
            const d = normDirection(t.direction);
            const ln = t.last_note;
            const inst = themeSymbols(t, symOf);
            return (
              <div className="theme" key={t.theme} style={selected === t.theme ? { background: "var(--chip)" } : undefined}>
                <div>
                  <div className="nm"><span className={`pd ${polarityCls(ln?.polarity ?? (d === "down" ? "negative" : d === "up" ? "positive" : "neutral"))}`} />
                    <button className="lnk" style={{ color: "var(--text)", textDecoration: "none", fontWeight: 600, fontSize: 13.5 }} onClick={() => onSelect(selected === t.theme ? null : t.theme)}>{t.theme}</button></div>
                  <div className="sub">{[nNotes(t.notes), ...inst.slice(0, 3)].join(" · ")}{t.last_observed_at ? ` · ostatnio ${dm(t.last_observed_at)}` : ""}</div>
                </div>
                <SentimentBars values={t.sentiment_8w} size="md" />
                <div className="last">{ln ? <><b>{ln.title}</b>{ln.observed_at ? ` · ${dm(ln.observed_at)}` : ""}{ln.strength ? ` · siła ${ln.strength}` : ""}
                  {ln.thesis_relation && normRelation(ln.thesis_relation) !== "none" ? ` · ${RELATION_LABEL[normRelation(ln.thesis_relation)]}${inst[0] ? ` ${inst[0]}` : ""}` : ""}</> : "-"}</div>
                <div className="r">
                  <span className={`tag ${DIRECTION_TONE[d]}`}>{DIRECTION_LABEL[d]}</span>
                  {inst.length > 0 && <div className="chips">{inst.slice(0, 3).map((x) => <span key={x} className="tag">{x}</span>)}</div>}
                  <span>{nNotes(t.notes)}</span>
                </div>
              </div>
            );
          })}
        </>
      )}
    </Widget>
  );
}

// ---- candidates -----------------------------------------------------------------------------------------

function CandidatesWidget({ slug, today, notes, watched, strategyVersion, onChanged }: {
  slug: string; today: string; notes: ResearchNote[]; watched: (n: ResearchNote) => CandidateState | undefined; strategyVersion: number | null; onChanged: () => void;
}) {
  const actions = useResearchActions(slug, onChanged);
  const list = [...notes].sort((a, b) => (a.dismissed_at ? 1 : 0) - (b.dismissed_at ? 1 : 0) || b.observed_at.localeCompare(a.observed_at));
  return (
    <Widget title="Kandydaci" count={list.filter((n) => !n.dismissed_at).length || undefined} controls={<span className="muted" style={{ fontSize: 12 }}>kryteria wejścia ze strategii{strategyVersion != null ? ` v${strategyVersion}` : ""}</span>}
      body="tight" footer={<><span><b>Obserwuj</b> dodaje do Obserwowanych z wersją roboczą tezy</span><span>odrzuceni wracają po 90 dniach</span></>}>
      {!list.length ? <div className="muted" style={{ fontSize: 13 }}>Brak kandydatów. Research proponuje tylko spółki i fundusze spełniające kryteria wejścia strategii.</div>
        : list.map((n) => <CandidateCard key={n.id} note={n} today={today} state={watched(n)} busy={actions.busy === n.id} onWatch={actions.watch} onDismiss={actions.dismiss}
          onRestore={actions.restore} canRestore={canRestore(n)} />)}
    </Widget>
  );
}

// ---- notes ----------------------------------------------------------------------------------------------

type NoteSort = "date" | "strength" | "relation";
const REL_RANK: Record<string, number> = { invalidates: 0, weakens: 1, supports: 2, neutral: 3, none: 4 };

function NotesList({ slug, today, nonce, scope, kind, theme, held, watchedIds, onClearTheme, onChanged, onOpenAsset }: {
  slug: string; today: string; nonce: number; scope: Scope; kind: string | null; theme: string | null;
  held: Map<number, { name: string; symbol: string | null }>; watchedIds: Map<number, { name: string; symbol: string | null }>;
  onClearTheme: () => void; onChanged: () => void; onOpenAsset: (id: number, noteId?: number) => void;
}) {
  const [old, setOld] = useState(false);
  const [sort, setSort] = useState<NoteSort>("date");
  const [shown, setShown] = useState(6);
  const [cursor, setCursor] = useState<number | null>(null);
  const q = useAsync(() => getResearch(slug, { include_dismissed: true, include_expired: old }), [slug, nonce, old]);
  const actions = useResearchActions(slug, onChanged);
  const all = q.data ?? [];
  const since = all.length ? all.map((n) => n.observed_at).sort()[0] : null;
  const list = useMemo(() => {
    const out = all.filter((n) => {
      if (!old && (n.dismissed_at || isExpired(n, today))) return false;
      if (kind && n.kind !== kind) return false;
      if (theme && n.theme !== theme) return false;
      const id = n.instrument_id;
      switch (scope) {
        case "positions": return id != null && held.has(id) && n.kind !== "candidate";
        case "watched": return id != null && watchedIds.has(id) && !held.has(id) && n.kind !== "candidate";
        case "candidates": return n.kind === "candidate";
        case "themes": return !!n.theme && n.kind !== "candidate";
        default: return n.kind !== "candidate"; // candidates have their own widget
      }
    });
    return out.sort((a, b) => sort === "strength" ? b.strength - a.strength || b.observed_at.localeCompare(a.observed_at)
      : sort === "relation" ? (REL_RANK[normRelation(a.thesis_relation)] ?? 9) - (REL_RANK[normRelation(b.thesis_relation)] ?? 9) || b.observed_at.localeCompare(a.observed_at)
      : b.observed_at.localeCompare(a.observed_at));
  }, [all, old, kind, theme, scope, sort, held, watchedIds, today]);
  const visible = list.slice(0, shown);
  const move = (d: number) => {
    if (!visible.length) return;
    const i = visible.findIndex((n) => n.id === cursor);
    const next = visible[Math.max(0, Math.min(visible.length - 1, i < 0 ? 0 : i + d))];
    setCursor(next.id);
    document.getElementById(`note-${next.id}`)?.scrollIntoView({ block: "nearest" });
  };
  useShortcuts({
    j: () => move(1), k: () => move(-1),
    x: () => { const n = visible.find((v) => v.id === cursor); if (n && !n.dismissed_at) void actions.dismiss(n); },
    Enter: () => { const n = visible.find((v) => v.id === cursor); const u = n?.sources.find((s) => /^https?:/i.test(s.url))?.url; if (u) window.open(u, "_blank", "noopener"); },
  });
  const who = (n: ResearchNote) => {
    const id = n.instrument_id;
    if (id != null) {
      const h = held.get(id) ?? watchedIds.get(id);
      return { name: h?.name ?? n.instrument?.label ?? n.instrument?.name ?? `#${id}`, sym: h?.symbol ?? n.instrument?.symbol ?? null };
    }
    return n.theme ? { name: n.theme, sym: "temat" } : null;
  };
  return (
    <Widget title="Notatki" id="rsch-notes" count={`${list.length}${since ? ` · od ${dm(since)}` : ""}`}
      tags={theme ? <button className="tag" style={{ cursor: "pointer", background: "transparent", font: "inherit", fontSize: 11 }} onClick={onClearTheme} title="Pokaż wszystkie tematy">{theme} ✕</button> : undefined}
      controls={<>
        <label className="muted" style={{ fontSize: 12.5, display: "inline-flex", gap: 5, alignItems: "center" }}><input type="checkbox" checked={old} onChange={(e) => setOld(e.target.checked)} />odrzucone i wygasłe</label>
        <select value={sort} onChange={(e) => setSort(e.target.value as NoteSort)} aria-label="Sortowanie notatek">
          <option value="date">sortuj: data</option><option value="strength">sortuj: siła</option><option value="relation">sortuj: relacja z tezą</option>
        </select>
      </>}
      body="tight"
      footer={<><span>każda notatka ma źródło z datą</span><span>społeczność oznaczona jako szum</span><span className="muted">j / k · x odrzuca · Enter otwiera źródło</span><span className="spacer" /><span>{BOUNDARY}</span></>}>
      {q.loading && !q.data ? <Skeleton h={180} /> : !list.length ? <div className="muted" style={{ fontSize: 13 }}>Brak notatek w tym widoku.</div> : (
        <>
          <div className="notes2">
            {visible.map((n) => (
              <div key={n.id} onClick={() => setCursor(n.id)} style={{ display: "grid" }}>
                <NoteCard note={n} today={today} context="list" card hl={cursor === n.id} who={who(n)} onDismiss={actions.dismiss} onRestore={actions.restore} canRestore={canRestore(n)}
                  onWho={n.instrument_id != null && (held.has(n.instrument_id) || watchedIds.has(n.instrument_id)) ? () => onOpenAsset(n.instrument_id!, n.id) : undefined} />
              </div>
            ))}
          </div>
          {list.length > shown && <div style={{ textAlign: "center", marginTop: 10 }}><button className="lnk" onClick={() => setShown((s) => s + 6)}>pokaż {Math.min(6, list.length - shown)} kolejnych</button></div>}
        </>
      )}
    </Widget>
  );
}

// ---- runs and scope ---------------------------------------------------------------------------------------

/** Run scope in words (RS CONTRACT: held, watchlist, candidates, themes [text], instrument_ids [explicit]). */
function scopeText(s: ResearchRun["scope"], symOf: (id: number) => string | null): string {
  if (!s || Array.isArray(s)) return Array.isArray(s) && s.length ? s.join(", ") : "-";
  const o = s as { held?: boolean; watchlist?: boolean; candidates?: boolean; themes?: string[]; instrument_ids?: number[] };
  const ids = (o.instrument_ids ?? []).map((id) => symOf(id) ?? `#${id}`);
  const parts = [o.held && "pozycje", o.watchlist && "obserwowane", o.candidates && "kandydaci", o.themes?.length ? "tematy" : null, ids.length ? ids.join(", ") : null].filter(Boolean);
  return parts.join(", ") || "-";
}

function RunsTable({ runs, symOf }: { runs: ResearchRun[]; symOf: (id: number) => string | null }) {
  const list = [...runs].sort((a, b) => b.started_at.localeCompare(a.started_at)).slice(0, 12);
  return (
    <Widget title="Przebiegi" count={`${list.length} ost.`} body="flush tight"
      footer={<><span>przerwany przebieg zachowuje zapisane notatki</span><span className="spacer" /><span>rutyna: <b>sobota 07:00</b> · Claude Code</span></>}>
      <table>
        <thead><tr><th style={{ paddingLeft: 16 }}>Data</th><th>Status</th><th>Zakres</th><th className="num">Notatki</th><th className="num">Sygnały</th><th className="num">Czas</th><th style={{ paddingRight: 16 }}>Uruchomił</th></tr></thead>
        <tbody>
          {list.map((r) => {
            const m = runMinutes(r);
            const st = r.status === "done" ? ["zakończony", "pos"] : r.status === "running" ? ["trwa", "info"] : ["przerwany", "neg"];
            return (
              <tr key={r.id}>
                <td className="tnum" style={{ paddingLeft: 16 }}>{r.started_at.slice(0, 10)} {hm(r.started_at)}</td>
                <td><span className="polt" style={{ color: "var(--text)" }}><i className={`pd ${st[1] === "info" ? "" : st[1]}`} style={st[1] === "info" ? { background: "var(--info)" } : undefined} aria-hidden /> {st[0]}</span></td>
                <td>{scopeText(r.scope, symOf)}{r.scheduled === false && r.scope && !Array.isArray(r.scope) && !(r.scope as { held?: boolean }).held ? " (na żądanie)" : ""}</td>
                <td className="num">{runNotes(r) ?? "-"}</td>
                <td className="num">{r.counts?.signals ?? "-"}</td>
                <td className="num">{m != null ? `${m} min` : "-"}</td>
                <td style={{ paddingRight: 16 }}>{r.scheduled === false || r.created_by === "user" ? "Ty · Claude Code" : `rutyna · ${r.status === "failed" ? (r.reason === "interrupted" || r.interrupted ? "przerwany" : r.reason ?? "przerwany") : "Claude Code"}`}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Widget>
  );
}

function ScopeWidget({ held, watched, strategyVersion, privacy, path }: { held: number; watched: number; strategyVersion: number | null; privacy: string; path: string }) {
  return (
    <Widget title="Zakres i zasady" body="tight" footer={<span>sygnał powstaje, gdy notatka podważa tezę (do działania) albo ma siłę 3 (informacja)</span>}>
      <div className="kvl">
        <span className="k">Zakres</span><span><b>{plural(held, "pozycja", "pozycje", "pozycji")}, {plural(watched, "obserwowana", "obserwowane", "obserwowanych")}</b>, kandydaci wg kryteriów wejścia strategii{strategyVersion != null ? ` v${strategyVersion}` : ""}, tematy sektorowe i makro</span>
        <span className="k">Źródła</span><span>wiadomości i raporty spółek; społeczność (Reddit, X, fora) jako skala i kierunek, zawsze oznaczona jako szum; przepływy ETF, siła relatywna, trendy wyszukiwań</span>
        <span className="k">Nie</span><span>rekomendacje kup / sprzedaj, prognozy cen, oceny analityków, omijanie paywalli i zabezpieczeń</span>
        <span className="k">Prywatność</span><span>poziom {PRIVACY_SHORT[privacy] ?? privacy}: {privacy === "amounts" ? "agent widzi też kwoty, nie widzi numerów kont" : "agent widzi udziały procentowe i tezy, nie widzi kwot ani rachunków"}</span>
        <span className="k">Workspace</span><span><code className="cmd wrap">{path}</code> · skill market-research i pliki robocze w <code className="cmd">research/</code>; dane tylko przez MCP</span>
        <span className="k">Ważność</span><span>notatka 30 dni, temat 60 dni bez notatek, odrzucony kandydat 90 dni</span>
      </div>
    </Widget>
  );
}

// ---- never ran (research.md 7) ----------------------------------------------------------------------------

function EmptyResearch({ cmd, path, ws, onSettings }: { cmd: string; path: string; ws: Workspace | null | undefined; onSettings: () => void }) {
  const [how, setHow] = useState(false);
  const noWs = ws?.exists === false;
  const skill = ws?.skill_installed ?? null;
  const steps: SetupStepItem[] = [
    noWs ? {
      key: "ws", status: "on", title: <span>Utwórz workspace profilu</span>, hint: "Ustawienia › Agent AI: folder z CLAUDE.md, .mcp.json i skillami tego profilu.",
      actions: <button className="btn primary" onClick={onSettings}>Ustawienia › Agent AI</button>,
    } : {
      key: "skill", status: skill === true ? "done" : "on",
      title: <span>Skill <b>market-research</b> {skill === true ? "zainstalowany" : skill === false ? "do zainstalowania" : "w workspace profilu"}</span>,
      hint: skill === true ? <>w workspace <code>{path}</code></> : <>Ustawienia › Agent AI › Aktualizuj workspace (albo <code>finanse workspace update</code>)</>,
      tag: ws?.skill_installed_at ? <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>{dm(ws.skill_installed_at)}</span> : undefined,
      actions: skill === true ? undefined : <button className="btn" onClick={onSettings}>Ustawienia › Agent AI</button>,
    },
    {
      key: "run", status: noWs ? "todo" : "on", title: "Uruchom pierwszy research w Claude Code",
      hint: "ok. 30 min, notatki pojawią się tu w trakcie",
      actions: noWs ? undefined : <CopyCommand cmd={cmd} label="Kopiuj" />,
    },
    {
      key: "schedule", status: "todo", title: "Zaplanuj rutynę na soboty",
      hint: how ? undefined : <>{ROUTINE_MENU}: sobota 07:00, folder workspace, polecenie <code>{ROUTINE_PROMPT}</code> · szczegóły w Ustawieniach › Agent AI</>,
      actions: <button className="btn" onClick={() => setHow((v) => !v)} aria-expanded={how}>Jak zaplanować</button>,
      body: how ? <div style={{ margin: "6px 0" }}><ScheduleHow path={path} onSettings={onSettings} /></div> : undefined,
    },
  ];
  return (
    <Widget title="Research" tags={<Tag>jeszcze nie działał</Tag>} body="tight" className="rsch-empty"
      footer={<span>bez researchu sygnały działają jak dotąd: reguły i alerty na twardych danych</span>}>
      <div className="lead">Co sobotę Claude przegląda wiadomości, raporty, sentyment i trendy dla Twoich pozycji, obserwowanych i kandydatów wg strategii.</div>
      <div className="d">Notatki ze źródłami trafią tutaj, do szuflady aktywa i do niedzielnego przeglądu. Fakty i sentyment, bez rekomendacji i prognoz.</div>
      <SetupSteps steps={steps} />
    </Widget>
  );
}
