// P9 topic drawer (`#/{slug}/investments.portfolio/topics/<key>`, the asset drawer's panel over the home): a topic
// is treated like an asset: `Teza` (edited in place; an agent draft shows `do potwierdzenia` with `Potwierdź`; under
// it the topic's market view `Ocena teraz` / `Perspektywa` (P11), kept current by the agent, edited in the same form),
// `Notatki` (every note of the topic, briefs and others, newest first; a click expands it) and `Instrumenty` (the
// members; a click opens the asset). A macro note key (`macro_risk`) opens the regime instead: the brief, the
// explanation and its notes (no thesis, no members). Opening marks the key's unread agent notes read. No navigation
// to the research page.
import { Fragment, type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { useAsync } from "../../../../hooks";
import { Skeleton, useToast } from "../../../../ui";
import { Widget } from "../../../../widgets";
import { errorText } from "../../../../core/messages";
import { dm } from "../../labels";
import { invKey } from "../api";
import { InstLabel, type InstLike } from "../InstLabel";
import { deleteTopicThesis, getResearch, getTopicThesis, postResearchRead, putTopicThesis, putTopicView } from "./api";
import { bumpResearch, canRestore, useMacro, useResearchActions, useResearchVersion, useSegments } from "./data";
import { isExpired } from "./logic";
import { explainText, isMacroKey, macroHeadline, macroKeyOf, macroLabel, sinceMonth, stateParts, toneCls } from "./macro";
import { BriefList } from "./MacroWidgets";
import { NoteRow, richSummary } from "./primitives";
import { canonKey, segmentDisplay, segmentLabel, thesisDraft, topicMembers, topicSavePlan, topicView } from "./segments";
import type { ResearchNote, TopicThesis } from "./types";

export const THESIS_MAX = 600;
export const INVALIDATION_MAX = 400;
export const VIEW_MAX = 400;

export interface TopicDrawerProps {
  slug: string;
  topic: string;
  today: string;
  symOf: (id: number) => string | null;
  /** Name, symbol and the instrument of a held or watched instrument (the member list). */
  instOf: (id: number) => { name: string; symbol: string | null; inst?: InstLike } | null;
  watchedTopics: Map<string, string[]>;
  onOpenAsset: (id: number) => void;
  onChanged: () => void;
}

/** Crumb of the drawer: `Tematy › <topic>`, `Makro › <regime>` for a macro note key. */
export const topicCrumb = (key: string): { section: string; name: string } =>
  (isMacroKey(key) ? { section: "Makro", name: macroLabel(key) } : { section: "Tematy", name: segmentLabel(key) });

export function TopicDetail(p: TopicDrawerProps) {
  const key = isMacroKey(p.topic) ? p.topic : canonKey(p.topic) ?? p.topic;
  const macro = isMacroKey(key);
  const notes = useTopicNotes(p.slug, key);
  return (
    <div className="tdw" data-topic-drawer={key}>
      <div className="stack">
        {macro ? <RegimeState slug={p.slug} noteKey={key} /> : <TopicThesisWidget slug={p.slug} topic={key} onChanged={p.onChanged} />}
        {!macro && <Members {...p} topic={key} />}
      </div>
      <NotesWidget slug={p.slug} today={p.today} notes={notes} onChanged={p.onChanged} />
    </div>
  );
}

/** Every note of the key (dismissed ones only while restorable), newest first; marks the unread ones read once. */
function useTopicNotes(slug: string, key: string): ResearchNote[] | null {
  const v = useResearchVersion();
  const q = useAsync(() => getResearch(slug, { segment: key, include_dismissed: true, include_expired: true }), [slug, key, v],
    { key: invKey(slug, "research", "topic", key) });
  const marked = useRef(false);
  useEffect(() => {
    if (marked.current || !q.data?.some((n) => n.unread === true)) return;
    marked.current = true;
    postResearchRead(slug, { segment: key }).then((res) => { if (res.marked > 0) bumpResearch(slug); }).catch(() => undefined);
  }, [q.data]); // eslint-disable-line react-hooks/exhaustive-deps
  return q.data ?? (q.error ? [] : null);
}

function NotesWidget({ slug, today, notes, onChanged }: { slug: string; today: string; notes: ResearchNote[] | null; onChanged: () => void }) {
  const actions = useResearchActions(slug, onChanged);
  const [openId, setOpenId] = useState<number | null>(null);
  const list = useMemo(() => (notes ?? []).filter((n) => !n.dismissed_at || canRestore(n)).sort((a, b) => b.observed_at.localeCompare(a.observed_at)), [notes]);
  return (
    <Widget title="Notatki" id="topic-notes" count={list.length || undefined} body="tight">
      {notes == null ? <Skeleton h={120} />
        : !list.length ? <div className="muted" style={{ fontSize: 13 }}>Brak notatek.</div>
        : list.map((n) => (
          <NoteRow key={n.id} note={n} today={today} open={openId === n.id} onToggle={() => setOpenId((x) => (x === n.id ? null : n.id))}
            onDismiss={isExpired(n, today) ? undefined : actions.dismiss} onRestore={actions.restore} canRestore={canRestore(n)} />
        ))}
    </Widget>
  );
}

/** The topic's members: held first, then watched; a click opens the asset. */
function Members({ slug, topic, symOf, instOf, watchedTopics, onOpenAsset }: TopicDrawerProps) {
  const seg = useSegments(slug, "1w");
  const row = seg.data?.segments.find((s) => s.segment === topic);
  const members = row ? topicMembers(segmentDisplay(row), symOf, watchedTopics) : (watchedTopics.get(topic) ?? []).map((s) => ({ symbol: s, id: null, held: false }));
  return (
    <Widget title="Instrumenty" id="topic-members" count={members.length || undefined} body="tight">
      {!seg.data && seg.loading ? <Skeleton h={60} />
        : !members.length ? <div className="muted" style={{ fontSize: 13 }}>Brak instrumentów.</div>
        : <div className="tmem">{members.map((m) => {
          const known = m.id != null ? instOf(m.id) : null;
          const inst: InstLike = known?.inst ?? { id: m.id ?? m.symbol, label: known?.name ?? m.symbol, name: known?.name ?? null, symbol: m.symbol };
          return (
            <div key={m.symbol} className="tm" data-member={m.symbol}>
              <InstLabel density="compact" inst={inst} text={known?.name ?? m.symbol} onOpen={m.id != null ? () => onOpenAsset(m.id!) : undefined}
                sub={m.held ? undefined : "obserwowany"} />
            </div>
          );
        })}</div>}
    </Widget>
  );
}

/** `Teza` of a topic, edited in place: thesis (<= 600) and `Unieważnienie` (<= 400), and under it the topic's market
 * view (P11): `Ocena teraz` and `Perspektywa` (<= 400 each; the agent keeps it current, the owner may edit or clear
 * it; a blank field clears it). An agent draft carries `do potwierdzenia` and `Potwierdź` (saving the thesis as the
 * owner clears the draft; a view-only edit keeps the draft). Saving an empty thesis removes it. */
function TopicThesisWidget({ slug, topic, onChanged }: { slug: string; topic: string; onChanged: () => void }) {
  const toast = useToast();
  const v = useResearchVersion();
  const q = useAsync(() => getTopicThesis(slug, topic), [slug, topic, v], { key: invKey(slug, "research", "topic-thesis", topic) });
  // The saved answer until the re-read carries it (undefined = none yet).
  const [saved, setSaved] = useState<TopicThesis | null | undefined>(undefined);
  useEffect(() => setSaved(undefined), [q.data]);
  const t = saved !== undefined ? saved : q.data ?? null;
  type Edit = { thesis: string; invalidation: string; assessment: string; outlook: string };
  const [edit, setEdit] = useState<Edit | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const draft = thesisDraft(t);
  const view = topicView(t);
  const run = async (write: () => Promise<TopicThesis | null>, done: string) => {
    setBusy(true); setErr(null);
    try {
      setSaved(await write());
      setEdit(null);
      toast(done, 2000);
      bumpResearch(slug);
      onChanged();
    } catch (e) {
      setErr(`Nie udało się zapisać: ${errorText(e)}`);
    } finally { setBusy(false); }
  };
  const confirm = () => t && run(async () => (await putTopicThesis(slug, topic, { thesis: t.thesis, invalidation: t.invalidation })) ?? { ...t, draft: false }, "Potwierdzono tezę");
  const save = (e: Edit) => {
    const thesis = e.thesis.trim();
    if (!thesis) return run(async () => { if (t) await deleteTopicThesis(slug, topic); return null; }, "Usunięto tezę");
    const plan = topicSavePlan(t, e);
    return run(async () => {
      let r: TopicThesis | null = t;
      if (plan.thesis) r = (await putTopicThesis(slug, topic, { thesis, invalidation: e.invalidation.trim() || null })) ?? r;
      if (plan.view) r = (await putTopicView(slug, topic, { assessment: e.assessment.trim() || null, outlook: e.outlook.trim() || null })) ?? r;
      return r;
    }, plan.thesis ? "Zapisano tezę" : plan.view ? "Zapisano ocenę" : "Bez zmian");
  };
  const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setEdit(null); } };
  const field = (k: keyof Edit, label: string, rows: number, max: number, autoFocus = false) => edit && (
    <div className="field">
      <label>{label}</label>
      <textarea rows={rows} maxLength={max} aria-label={label} value={edit[k]} autoFocus={autoFocus} onKeyDown={esc}
        onChange={(ev) => setEdit({ ...edit, [k]: ev.target.value })} />
    </div>
  );
  return (
    <Widget title="Teza" id="topic-thesis" body="tight"
      tags={draft && !edit ? <span className="tag warn" title="Wersja robocza od agenta">do potwierdzenia</span> : undefined}
      controls={!edit && (!q.loading || saved !== undefined) && <>
        {draft && <button className="btn sm primary" disabled={busy} onClick={confirm}>Potwierdź</button>}
        <button className="btn sm" onClick={() => { setErr(null); setEdit({ thesis: t?.thesis ?? "", invalidation: t?.invalidation ?? "", assessment: t?.assessment ?? "", outlook: t?.outlook ?? "" }); }}>{t ? "Edytuj" : "Dodaj"}</button>
      </>}>
      {edit ? (
        <div className="form">
          {field("thesis", "Teza", 4, THESIS_MAX, true)}
          {field("invalidation", "Unieważnienie", 2, INVALIDATION_MAX)}
          {(t || edit.assessment || edit.outlook) && <>
            {field("assessment", "Ocena teraz", 3, VIEW_MAX)}
            {field("outlook", "Perspektywa", 3, VIEW_MAX)}
          </>}
          {err && <div className="neg" style={{ fontSize: 12.5 }}>{err}</div>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button className="btn sm" disabled={busy} onClick={() => setEdit(null)}>Anuluj</button>
            <button className="btn sm primary" disabled={busy} onClick={() => save(edit)}>{busy ? "Zapisuję…" : "Zapisz"}</button>
          </div>
        </div>
      ) : q.loading && saved === undefined ? <Skeleton h={60} />
        : t ? (
          <div className="tz">
            <p style={{ whiteSpace: "pre-wrap" }}>{t.thesis}</p>
            {t.invalidation && <p style={{ whiteSpace: "pre-wrap" }}><b>Unieważnienie</b>{t.invalidation}</p>}
            {view && <div className="tview" data-topic-view={topic}>
              {view.assessment && <div><span className="k">Ocena teraz</span><p>{richSummary(view.assessment)}</p></div>}
              {view.outlook && <div><span className="k">Perspektywa</span><p>{richSummary(view.outlook)}</p></div>}
              {view.sources.length > 0 && <div className="vsrc" data-view-sources={view.sources.length}>
                {view.sources.map((l, i) => (
                  <Fragment key={i}>
                    {i > 0 && <span className="sep">·</span>}
                    {l.href ? <a href={l.href} target="_blank" rel="noopener noreferrer" title={l.title}>{l.text}</a> : <span title={l.title}>{l.text}</span>}
                  </Fragment>
                ))}
              </div>}
              {view.at && <span className="at">{dm(view.at)}</span>}
            </div>}
            {err && <div className="neg" style={{ fontSize: 12.5 }}>{err}</div>}
          </div>
        ) : <div className="muted" style={{ fontSize: 13 }}>Brak tezy.</div>}
    </Widget>
  );
}

/** A macro regime in the drawer: the state, the brief (or the plain sentence), `Co sprzyja` / `Na co uważać`, the explanation. */
function RegimeState({ slug, noteKey }: { slug: string; noteKey: string }) {
  const q = useMacro(slug);
  const r = q.data?.regimes.find((x) => x.key === macroKeyOf(noteKey));
  if (!r) return <Widget title="Stan" body="tight">{q.loading ? <Skeleton h={80} /> : <div className="muted" style={{ fontSize: 13 }}>Brak danych makro.</div>}</Widget>;
  const tone = toneCls(r.tone);
  const b = r.missing ? null : r.brief ?? null;
  const ex = explainText(r);
  return (
    <Widget title="Stan" id="topic-regime" body="tight"
      tags={<>{stateParts(r.state_label).map((p, i) => <span key={i} className={`tag ${i === 0 ? tone : "warn"}`}>{p}</span>)}{sinceMonth(r) && <span className="sub">{sinceMonth(r)}</span>}</>}>
      <div className="mrow solo">
        <div className="bh">{macroHeadline(r)}</div>
        {b?.why && <div className="bw">{b.why}</div>}
        {b && b.supports.length > 0 && <BriefList k="Co sprzyja" items={b.supports} cls="sup" />}
        {b && b.risks.length > 0 && <BriefList k="Na co uważać" items={b.risks} cls="rsk" />}
        {ex && <p className="xt">{ex}</p>}
        {!r.missing && r.metrics.length > 0 && (
          <div className="xm">{r.metrics.slice(0, 3).map((m, i) => <Fragment key={i}><span className="l">{m.label}</span><b className={m.stale ? "stale" : ""}>{m.text}</b></Fragment>)}</div>
        )}
        {b?.observed_at && <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>research {dm(b.observed_at)}</div>}
      </div>
    </Widget>
  );
}
