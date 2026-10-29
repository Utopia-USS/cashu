// Research view `#/{slug}/investments.portfolio/research` (research.md 1 + 7, implementation-plan item 34):
// page head with the scope and kind filters and `Uruchom teraz` (copies the command), the run strip, Kandydaci,
// Notatki (two-column cards, filters, sort, paging by 6, j / k / x / Enter), Przebiegi and Zakres i zasady. P9: no
// Makro / Tematy widgets and no `Tematy` scope (topics and regimes live on the home and in their drawer; a topic
// note's name opens that drawer); an old `?segment=` link opens the plain page. Before the first run: the empty
// state with the three steps (skill, first run, schedule).
import { useEffect, useMemo, useState } from "react";
import { useAsync } from "../../../../hooks";
import { Seg, SetupSteps, type SetupStepItem, Skeleton, Tag } from "../../../../ui";
import { Grid, type GridItem, Widget } from "../../../../widgets";
import { useShortcuts } from "../../hooks";
import { dm, hm, plural, wdm } from "../../labels";
import { getResearch } from "./api";
import { invKey } from "../api";
import type { InstLike } from "../InstLabel";
import { canRestore, useResearchActions, useResearchOverview, useSegments, useWorkspace } from "./data";
import {
  BOUNDARY, healthOf, isExpired, KIND_FILTER, latestRun, nextSaturday, normRelation,
  researchCommand, ROUTINE_PROMPT, runMinutes, runNotes, runTag, workspacePath,
} from "./logic";
import { CandidateCard, type CandidateState, CopyCommand, NoteCard, ScheduleHow } from "./primitives";
import { canonKey, exposed, hashWithSegment, isSegment, segmentLabel, withNewNote } from "./segments";
import type { ResearchNote, ResearchRun, ResearchSummary, SegmentAttribution, Workspace } from "./types";
import { isMacroKey, macroLabel } from "./macro";
import { localDay } from "../../../../time";

type Scope = "all" | "positions" | "watched" | "candidates";
const SCOPES: Scope[] = ["all", "positions", "watched", "candidates"];

export interface ResearchPageProps {
  slug: string;
  today: string;
  privacy: string;
  held: Map<number, { name: string; symbol: string | null; weight: number | null; inst?: InstLike }>;
  watchedIds: Map<number, { name: string; symbol: string | null; inst?: InstLike }>;
  watched: (n: ResearchNote) => CandidateState | undefined;
  symOf: (id: number) => string | null;
  /** P7: topic key -> watched (not held) symbols. */
  watchedTopics: Map<string, string[]>;
  strategyVersion: number | null;
  initial: URLSearchParams;
  onBack: () => void;
  onOpenAsset: (id: number, noteId?: number) => void;
  /** P9: a topic note's name opens the topic drawer over the home. */
  onOpenTopic: (key: string) => void;
  onSettings: () => void;
  onChanged: () => void;
}

const PRIVACY_SHORT: Record<string, string> = { strict: "ścisły", amounts: "z kwotami" };

export function ResearchPage(p: ResearchPageProps) {
  const [nonce, setNonce] = useState(0);
  const refresh = () => { setNonce((n) => n + 1); p.onChanged(); };
  const { runs, summary, candidates, loading } = useResearchOverview(p.slug, nonce);
  const ws = useWorkspace(p.slug);
  const seg = useSegments(p.slug, "1w", nonce);
  // An old `?segment=` / `?theme=` / `?scope=segments` link opens the plain page (P9); the stale param leaves the URL.
  const [scope, setScope] = useState<Scope>(() => {
    const s = p.initial.get("scope") as Scope | null;
    return s && SCOPES.includes(s) ? s : "all";
  });
  const [kind, setKind] = useState<string | null>(() => p.initial.get("kind"));
  useEffect(() => {
    const next = hashWithSegment(location.hash, null);
    if (next !== location.hash) { try { history.replaceState(history.state, "", next); } catch { /* ignore */ } }
  }, []);
  const cmd = researchCommand(ws.data?.path, p.slug);
  const head = (
    <>
      <nav className="crumb" aria-label="Ścieżka"><button onClick={p.onBack}>Inwestycje</button> › <span>Research</span></nav>
      <div className="pagehead">
        <h2 className="ph">Research</h2>
        {!!runs?.length && <Filters scope={scope} setScope={setScope} kind={kind} setKind={setKind} summary={summary} candidates={candidates} held={p.held} watchedIds={p.watchedIds} />}
        <span className="spacer" />
        {ws.data?.exists !== false && <CopyCommand cmd={cmd} label="Uruchom teraz" primary={false} showCmd={false} />}
      </div>
    </>
  );
  if (loading && !runs) return <>{head}<Skeleton h={160} r={12} /></>;
  if (!runs?.length) return <>{head}<Grid items={[
    { id: "empty", span: 3, node: <EmptyResearch cmd={cmd} path={workspacePath(ws.data?.path, p.slug)} ws={ws.data} onSettings={p.onSettings} /> },
  ]} /></>;

  const items: GridItem[] = [
    { id: "run", span: 3, node: <RunStrip runs={runs} summary={summary} candidates={candidates ?? []} today={p.today} strategyVersion={p.strategyVersion} privacy={p.privacy} held={p.held} segments={seg.data} /> },
    { id: "notes", span: 3, node: <NotesList slug={p.slug} today={p.today} nonce={nonce} scope={scope} kind={kind} held={p.held} watchedIds={p.watchedIds} onOpenTopic={p.onOpenTopic} onChanged={refresh} onOpenAsset={p.onOpenAsset} /> },
    { id: "runs", span: 2, node: <RunsTable runs={runs} symOf={p.symOf} /> },
    { id: "cands", span: 1, node: <CandidatesWidget slug={p.slug} today={p.today} notes={candidates ?? []} watched={p.watched} strategyVersion={p.strategyVersion} onChanged={refresh} /> },
    { id: "scope", span: 3, node: <ScopeWidget held={p.held.size} watched={p.watchedIds.size} strategyVersion={p.strategyVersion} privacy={p.privacy} path={ws.data?.path ?? `~/Documents/cashU/${p.slug}`} /> },
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
  return (
    <>
      <Seg<Scope> quiet label="Zakres" value={scope} onChange={setScope} items={[
        ["Wszystko", "all"], [`Pozycje · ${nHeld}`, "positions"], [`Obserwowane · ${nWatched}`, "watched"], [`Kandydaci · ${nCand}`, "candidates"],
      ]} />
      <Seg<string | null> quiet label="Rodzaj" value={kind} onChange={setKind} items={[["Wszystkie rodzaje", null], ...KIND_FILTER.map(([l, v]) => [l, v] as [string, string])]} />
    </>
  );
}

// ---- run strip ------------------------------------------------------------------------------------------

function RunStrip({ runs, summary, candidates, today, strategyVersion, privacy, held, segments }: {
  runs: ResearchRun[]; summary: ResearchSummary | null | undefined; candidates: ResearchNote[]; today: string; strategyVersion: number | null; privacy: string;
  held: Map<number, { name: string; symbol: string | null }>;
  /** The 1w attribution (null while loading or without the endpoint). */
  segments: SegmentAttribution | null;
}) {
  const last = latestRun(runs)!;
  const tag = runTag(runs, today);
  const at = last.finished_at ?? last.started_at;
  const day = new Date(`${localDay(last.started_at)}T12:00:00`).getDay();
  const dayName = ["niedziela", "poniedziałek", "wtorek", "środa", "czwartek", "piątek", "sobota"][day];
  const mins = runMinutes(last);
  const inst = (summary?.instruments ?? []).map((s) => ({ s, h: healthOf(s, today) }));
  const weak = inst.filter((x) => x.h === "weak" || x.h === "inv");
  const ful = inst.filter((x) => x.h === "ful");
  const sup = inst.filter((x) => x.h === "sup");
  const nSeg = segments ? exposed(segments) : null;
  const k = segments ? withNewNote(segments.segments) : 0;
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
        <div className="fact"><div className="l">Tezy</div><div className="v">{weak.length ? `${weak.length} osłabione` : ful.length ? `${ful.length} spełnione` : sup.length ? `${sup.length} wzmocnione` : "bez zmian"}</div>
          <div className="d">{[weak.slice(0, 3).map((x) => sym(x.s.instrument_id)).join(", "), sup.length && weak.length ? `${sup.length} wzmocniona` : null].filter(Boolean).join(" · ") || "-"}</div></div>
        <div className="fact"><div className="l">Tematy</div><div className="v">{nSeg ?? "-"}</div><div className="d">{segments ? (k ? plural(k, "nowa notatka", "nowe notatki", "nowych notatek") : "bez nowych notatek") : ""}</div></div>
        <div className="fact"><div className="l">Kandydaci</div><div className="v">{openC}</div><div className="d">{dismissedC ? `${plural(dismissedC, "odrzucony", "odrzuceni", "odrzuconych")}` : "0 odrzuconych"}</div></div>
        {typeof c.signals === "number" && <div className="fact" title="Z notatek o sile 3 albo podważających tezę"><div className="l">Sygnały</div><div className="v">{c.signals}</div></div>}
      </div>
      <div className="hr">
        {tag.state === "fresh" || tag.state === "none" ? <span className="tag solid pos">następny: {wdm(nextSaturday(today))} 07:00</span> : <span className={`tag ${tag.tone}`}>{tag.text}</span>}
        <div className="meta">{[strategyVersion != null ? `strategia v${strategyVersion}` : null, `poziom ${PRIVACY_SHORT[privacy] ?? privacy}`].filter(Boolean).join(" · ")}</div>
        <div className="meta">{scheduled ? "rutyna Claude Code" : "na żądanie · Claude Code"}</div>
      </div>
    </section>
  );
}

// ---- candidates -----------------------------------------------------------------------------------------

function CandidatesWidget({ slug, today, notes, watched, strategyVersion, onChanged }: {
  slug: string; today: string; notes: ResearchNote[]; watched: (n: ResearchNote) => CandidateState | undefined; strategyVersion: number | null; onChanged: () => void;
}) {
  const actions = useResearchActions(slug, onChanged);
  const list = [...notes].sort((a, b) => (a.dismissed_at ? 1 : 0) - (b.dismissed_at ? 1 : 0) || b.observed_at.localeCompare(a.observed_at));
  return (
    <Widget title="Kandydaci" count={list.filter((n) => !n.dismissed_at).length || undefined} controls={<span className="muted" style={{ fontSize: 12 }}>{strategyVersion != null ? `wg strategii v${strategyVersion}` : "wg strategii"}</span>}
      body="tight">
      {!list.length ? <div className="muted" style={{ fontSize: 13 }}>Brak kandydatów.</div>
        : list.map((n) => <CandidateCard key={n.id} note={n} today={today} state={watched(n)} busy={actions.busy === n.id} onWatch={actions.watch} onDismiss={actions.dismiss}
          onRestore={actions.restore} canRestore={canRestore(n)} />)}
    </Widget>
  );
}

// ---- notes ----------------------------------------------------------------------------------------------

type NoteSort = "date" | "strength" | "relation";
const REL_RANK: Record<string, number> = { invalidates: 0, weakens: 1, fulfills: 2, supports: 3, neutral: 4, none: 5 };

function NotesList({ slug, today, nonce, scope, kind, held, watchedIds, onOpenTopic, onChanged, onOpenAsset }: {
  slug: string; today: string; nonce: number; scope: Scope; kind: string | null;
  held: Map<number, { name: string; symbol: string | null; inst?: InstLike }>; watchedIds: Map<number, { name: string; symbol: string | null; inst?: InstLike }>;
  onOpenTopic: (key: string) => void; onChanged: () => void; onOpenAsset: (id: number, noteId?: number) => void;
}) {
  const [old, setOld] = useState(false);
  const [sort, setSort] = useState<NoteSort>("date");
  const [shown, setShown] = useState(6);
  const [cursor, setCursor] = useState<number | null>(null);
  const q = useAsync(() => getResearch(slug, { include_dismissed: true, include_expired: old }), [slug, nonce, old],
    { key: invKey(slug, "research", "notes", old ? "all" : "live") });
  const actions = useResearchActions(slug, onChanged);
  const all = q.data ?? [];
  const since = all.length ? all.map((n) => n.observed_at).sort()[0] : null;
  const list = useMemo(() => {
    const out = all.filter((n) => {
      if (!old && (n.dismissed_at || isExpired(n, today))) return false;
      if (kind && n.kind !== kind) return false;
      const id = n.instrument_id;
      switch (scope) {
        case "positions": return id != null && held.has(id) && n.kind !== "candidate";
        case "watched": return id != null && watchedIds.has(id) && !held.has(id) && n.kind !== "candidate";
        case "candidates": return n.kind === "candidate";
        default: return n.kind !== "candidate"; // candidates have their own widget
      }
    });
    return out.sort((a, b) => sort === "strength" ? b.strength - a.strength || b.observed_at.localeCompare(a.observed_at)
      : sort === "relation" ? (REL_RANK[normRelation(a.thesis_relation)] ?? 9) - (REL_RANK[normRelation(b.thesis_relation)] ?? 9) || b.observed_at.localeCompare(a.observed_at)
      : b.observed_at.localeCompare(a.observed_at));
  }, [all, old, kind, scope, sort, held, watchedIds, today]);
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
      return { name: h?.name ?? n.instrument?.label ?? n.instrument?.name ?? `#${id}`, sym: h?.symbol ?? n.instrument?.symbol ?? null, inst: h?.inst };
    }
    if (n.segment && isMacroKey(n.segment)) return { name: n.segment_label ?? macroLabel(n.segment), sym: "makro" };
    if (n.segment) return { name: canonKey(n.segment) !== n.segment ? segmentLabel(n.segment) : n.segment_label ?? segmentLabel(n.segment), sym: "temat" };
    // Old theme notes stay visible (research never dropped).
    return n.theme ? { name: n.theme, sym: "temat" } : null;
  };
  const onWho = (n: ResearchNote) => n.instrument_id != null
    ? (held.has(n.instrument_id) || watchedIds.has(n.instrument_id) ? () => onOpenAsset(n.instrument_id!, n.id) : undefined)
    : n.segment && (isMacroKey(n.segment) || isSegment(n.segment)) ? () => onOpenTopic(isMacroKey(n.segment) ? n.segment! : canonKey(n.segment)!) : undefined;
  return (
    <Widget title="Notatki" id="rsch-notes" count={`${list.length}${since ? ` · od ${dm(since)}` : ""}`}
      controls={<>
        <label className="muted" style={{ fontSize: 12.5, display: "inline-flex", gap: 5, alignItems: "center" }}><input type="checkbox" checked={old} onChange={(e) => setOld(e.target.checked)} />odrzucone i wygasłe</label>
        <select value={sort} onChange={(e) => setSort(e.target.value as NoteSort)} aria-label="Sortowanie notatek">
          <option value="date">data</option><option value="strength">siła</option><option value="relation">relacja z tezą</option>
        </select>
      </>}
      body="tight"
      footer={<><span className="muted">j / k · x odrzuca · Enter otwiera źródło</span><span className="spacer" /><span>{BOUNDARY}</span></>}>
      {q.loading && !q.data ? <Skeleton h={180} /> : !list.length ? <div className="muted" style={{ fontSize: 13 }}>Brak notatek.</div> : (
        <>
          <div className="notes2">
            {visible.map((n) => (
              <div key={n.id} onClick={() => setCursor(n.id)} style={{ display: "grid" }}>
                <NoteCard note={n} today={today} context="list" card hl={cursor === n.id} who={who(n)} onDismiss={actions.dismiss} onRestore={actions.restore} canRestore={canRestore(n)}
                  onWho={onWho(n)} />
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

/** Run scope in words (RS CONTRACT: held, watchlist, candidates, segments [keys, P5], instrument_ids [explicit]). */
function scopeText(s: ResearchRun["scope"], symOf: (id: number) => string | null): string {
  if (!s || Array.isArray(s)) return Array.isArray(s) && s.length ? s.join(", ") : "-";
  const o = s as { held?: boolean; watchlist?: boolean; candidates?: boolean; segments?: string[]; instrument_ids?: number[] };
  const ids = (o.instrument_ids ?? []).map((id) => symOf(id) ?? `#${id}`);
  const parts = [o.held && "pozycje", o.watchlist && "obserwowane", o.candidates && "kandydaci", o.segments?.length ? "tematy" : null, ids.length ? ids.join(", ") : null].filter(Boolean);
  return parts.join(", ") || "-";
}

function RunsTable({ runs, symOf }: { runs: ResearchRun[]; symOf: (id: number) => string | null }) {
  const list = [...runs].sort((a, b) => b.started_at.localeCompare(a.started_at)).slice(0, 12);
  return (
    <Widget title="Przebiegi" count={`${list.length} ost.`} body="flush tight"
      footer={<><span className="spacer" /><span>rutyna: <b>sobota 07:00</b> · Claude Code</span></>}>
      <table>
        <thead><tr><th style={{ paddingLeft: 16 }}>Data</th><th>Status</th><th>Zakres</th><th className="num">Notatki</th><th className="num" title="Sygnał powstaje, gdy notatka podważa tezę (do działania) albo ma siłę 3 (informacja)">Sygnały</th><th className="num">Czas</th><th style={{ paddingRight: 16 }}>Uruchomił</th></tr></thead>
        <tbody>
          {list.map((r) => {
            const m = runMinutes(r);
            const st = r.status === "done" ? ["zakończony", "pos"] : r.status === "running" ? ["trwa", "info"] : ["przerwany", "neg"];
            return (
              <tr key={r.id}>
                <td className="tnum" style={{ paddingLeft: 16 }}>{localDay(r.started_at)} {hm(r.started_at)}</td>
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
    <Widget title="Zakres i zasady" body="tight">
      <div className="kvl">
        <span className="k">Zakres</span><span><b>{plural(held, "pozycja", "pozycje", "pozycji")}, {plural(watched, "obserwowana", "obserwowane", "obserwowanych")}</b>, kandydaci wg kryteriów wejścia strategii{strategyVersion != null ? ` v${strategyVersion}` : ""}, tematy</span>
        <span className="k">Źródła</span><span>wiadomości, raporty, społeczność (szum), przepływy ETF, trendy</span>
        <span className="k">Nie</span><span>rekomendacje, prognozy cen, omijanie paywalli</span>
        <span className="k">Prywatność</span><span>poziom {PRIVACY_SHORT[privacy] ?? privacy} · {privacy === "amounts" ? "także kwoty, bez numerów kont" : "udziały i tezy, bez kwot i rachunków"}</span>
        <span className="k">Workspace</span><span><code className="cmd wrap">{path}</code> · dane tylko przez MCP</span>
        <span className="k">Ważność</span><span>notatka 30 dni, notatka tematu 1 na tydzień, odrzucony kandydat 90 dni</span>
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
      key: "ws", status: "on", title: <span>Utwórz workspace profilu</span>,
      actions: <button className="btn primary" onClick={onSettings}>Ustawienia › Agent AI</button>,
    } : {
      key: "skill", status: skill === true ? "done" : "on",
      title: <span>Skill <b>market-research</b> {skill === true ? "zainstalowany" : skill === false ? "do zainstalowania" : "w workspace profilu"}</span>,
      hint: skill === true ? <>w workspace <code>{path}</code></> : <>Ustawienia › Agent AI › Aktualizuj workspace (albo <code>cashu workspace update</code>)</>,
      tag: ws?.skill_installed_at ? <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>{dm(ws.skill_installed_at)}</span> : undefined,
      actions: skill === true ? undefined : <button className="btn" onClick={onSettings}>Ustawienia › Agent AI</button>,
    },
    {
      key: "run", status: noWs ? "todo" : "on", title: "Uruchom pierwszy research w Claude Code",
      hint: "ok. 30 min",
      actions: noWs ? undefined : <CopyCommand cmd={cmd} label="Kopiuj" />,
    },
    {
      key: "schedule", status: "todo", title: "Zaplanuj rutynę na soboty",
      hint: how ? undefined : <>sobota 07:00 · <code>{ROUTINE_PROMPT}</code></>,
      actions: <button className="btn" onClick={() => setHow((v) => !v)} aria-expanded={how}>Jak zaplanować</button>,
      body: how ? <div style={{ margin: "6px 0" }}><ScheduleHow path={path} onSettings={onSettings} /></div> : undefined,
    },
  ];
  return (
    <Widget title="Research" tags={<Tag>jeszcze nie działał</Tag>} body="tight" className="rsch-empty">
      <div className="lead">Co sobotę: wiadomości, raporty, sentyment i trendy dla pozycji, obserwowanych i kandydatów.</div>
      <div className="d">Bez rekomendacji i prognoz.</div>
      <SetupSteps steps={steps} />
    </Widget>
  );
}
