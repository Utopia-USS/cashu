// P6 macro regimes ("Makro", design/P6/macro-design.md; P7 strip-design.md 2.1): the research page widget (five
// regime cards, a card filters Notatki by its macro note key), the home column Makro (five rows: title, toned state,
// `od d.mm`, the one-sentence summary; hover / focus opens the explain popover) and the Sunday review lines (regimes whose state changed in the digest period). Pure logic lives in macro.ts.
import { useId } from "react";
import { Skeleton } from "../../../../ui";
import { Mark, Widget } from "../../../../widgets";
import { dm, plural } from "../../labels";
import { useMacro } from "./data";
import {
  explainHead, explainText, hasExplain, historyTitle, macroAsOf, macroNoteKey, macroSub, metricTitle, sinceText, staleText, stateParts, summaryText, toneCls,
} from "./macro";
import { Explain, useExplainDismiss } from "./primitives";
import type { StripCtx } from "./Strip";
import type { MacroChange, MacroRegime } from "./types";

const EMPTY = <div className="muted" style={{ fontSize: 13 }}>Brak danych makro.</div>;

/** `Makro` (span 3, between the run strip and Tematy): five compact regime cards; the tag = the last session in
 * the data. A card selects its macro note key (filters Notatki like a P5 segment row). */
export function MacroWidget({ slug, nonce, selected, onSelect }: {
  slug: string; nonce: number; selected: string | null; onSelect: (noteKey: string | null) => void;
}) {
  const q = useMacro(slug, nonce);
  const d = q.data;
  const asOf = macroAsOf(d);
  return (
    <Widget title="Makro" id="rsch-macro" body="tight"
      tags={asOf ? <span className="tag" title="ostatnia sesja w danych">stan {dm(asOf)}</span> : undefined}>
      {!d ? (q.loading ? <Skeleton h={132} /> : EMPTY)
        : !d.regimes.length ? EMPTY
        : <div className="mcx">{d.regimes.map((r) => <MacroCard key={r.key} r={r} selected={selected === macroNoteKey(r.key)} onSelect={onSelect} />)}</div>}
    </Widget>
  );
}

export function MacroCard({ r, selected, onSelect }: { r: MacroRegime; selected: boolean; onSelect: (noteKey: string | null) => void }) {
  const key = macroNoteKey(r.key);
  const toggle = () => onSelect(selected ? null : key);
  const parts = stateParts(r.state_label);
  const since = sinceText(r), stale = staleText(r), hist = historyTitle(r), sub = macroSub(r);
  const tone = toneCls(r.tone);
  const meaningId = useId();
  return (
    <div className={`mc${selected ? " sel" : ""}${r.missing ? " off" : ""}${r.stale && !r.missing ? " stale" : ""}`} data-macro={r.key} data-selectable="" onClick={toggle}>
      <div className="mh">
        <button className="t" aria-pressed={selected} aria-describedby={r.meaning ? meaningId : undefined} onClick={(e) => { e.stopPropagation(); toggle(); }}>{r.label}</button>
        {r.unread > 0 && <Mark kind="notes" title={plural(r.unread, "nowa notatka", "nowe notatki", "nowych notatek")} />}
      </div>
      <div className="st" title={r.meaning ?? undefined}>
        {r.missing
          ? <span className="tag solid muted">brak danych</span>
          : parts.map((p, i) => <span key={i} className={`tag ${i === 0 ? tone : "warn"}`}>{p}</span>)}
        {(since || stale) && (
          <span className="since" title={hist ?? undefined}>
            {since}{since && stale ? " · " : ""}{stale && <span className="warn" title="ostatnie notowanie w danych">{stale}</span>}
          </span>
        )}
      </div>
      <div className="ms">
        {!r.missing && r.metrics.slice(0, 3).map((m, i) => (
          <div key={i} className={`m${m.stale ? " stale" : ""}`} title={metricTitle(m)}><span className="l">{m.label}</span><b>{m.text}</b></div>
        ))}
      </div>
      <div className="n" title={sub?.title}>{sub?.text ?? ""}</div>
      {r.meaning && <span id={meaningId} className="sr-only">{r.meaning}</span>}
    </div>
  );
}

type LineCtx = Pick<StripCtx, "slug" | "nonce" | "onOpenResearch">;

/** Home column `Makro` (P7 design 2.1): five rows, each the regime title, the toned state word, `od d.mm`, and the
 * one-sentence summary (clamped to 2 lines); hover / focus opens the explain popover. The title opens the research
 * page filtered to the regime's notes. Nothing (not even the header) without the endpoint or without regimes. */
export function MacroColumn({ ctx }: { ctx: LineCtx }) {
  const q = useMacro(ctx.slug, ctx.nonce ?? 0);
  if (!q.data && !q.loading) return null;
  if (q.data && !q.data.regimes.length) return null;
  const asOf = macroAsOf(q.data);
  return (
    <div className="mcol">
      <div className="rsec">Makro {asOf && <span className="cnt" title="ostatnia sesja w danych">· stan {dm(asOf)}</span>}</div>
      {q.data ? <MacroRows regimes={q.data.regimes} onOpen={(k) => ctx.onOpenResearch(`segment=${k}`)} /> : <Skeleton h={190} r={8} />}
    </div>
  );
}

export function MacroRows({ regimes, onOpen, wide }: { regimes: MacroRegime[]; onOpen: (noteKey: string) => void; wide?: boolean }) {
  return <div className={`mrows${wide ? " wide" : ""}`} role="list" aria-label="Makro">{regimes.map((r) => <MacroRow key={r.key} r={r} onOpen={onOpen} />)}</div>;
}

export function MacroRow({ r, onOpen }: { r: MacroRegime; onOpen: (noteKey: string) => void }) {
  const xid = useId();
  const parts = stateParts(r.state_label);
  const tone = toneCls(r.tone);
  const since = sinceText(r), stale = staleText(r), hist = historyTitle(r);
  const explain = hasExplain(r);
  const dismiss = useExplainDismiss();
  return (
    <div className={`mrow${r.missing ? " off" : ""}${dismiss.hidden ? " xoff" : ""}`} role="listitem" data-macro={r.key} {...(explain ? dismiss.props : {})}>
      <div className="mh">
        <button className="t" aria-describedby={explain ? xid : undefined} onClick={() => onOpen(macroNoteKey(r.key))}>{r.label}</button>
        {r.missing
          ? <b className="st off">brak danych</b>
          : parts.map((p, i) => <b key={i} className={`st ${i === 0 ? tone : "warn"}`}>{p}</b>)}
        {(since || stale) && <span className="since" title={hist ?? undefined}>{since}{since && stale ? " · " : ""}{stale && <span className="warn" title="ostatnie notowanie w danych">{stale}</span>}</span>}
        {r.unread > 0 && <Mark kind="notes" title={plural(r.unread, "nowa notatka", "nowe notatki", "nowych notatek")} />}
      </div>
      <div className="sum">{summaryText(r)}</div>
      {explain && <Explain id={xid} head={explainHead(r)} tone={tone} text={explainText(r)!} metrics={r.missing ? [] : r.metrics} />}
    </div>
  );
}

/** The home before the first research run (no research strip yet): the same five rows side by side as a small
 * widget, since the regimes come from the daily check, not from research runs. Nothing without regimes. */
export function MacroStrip({ ctx }: { ctx: LineCtx }) {
  const q = useMacro(ctx.slug, ctx.nonce ?? 0);
  if (!q.data?.regimes.length) return null;
  const asOf = macroAsOf(q.data);
  return (
    <Widget title="Makro" id="inv-macro" body="tight" tags={asOf ? <span className="tag" title="ostatnia sesja w danych">stan {dm(asOf)}</span> : undefined}>
      <MacroRows wide regimes={q.data.regimes} onOpen={(k) => ctx.onOpenResearch(`segment=${k}`)} />
    </Widget>
  );
}

/** Review column (P6 design 4): regimes whose state changed in the digest period, one bold line each; the
 * label opens the research page filtered to that regime's notes. Nothing when none changed. */
export function MacroChanges({ changes, onOpen }: { changes: MacroChange[]; onOpen: (noteKey: string) => void }) {
  if (!changes.length) return null;
  return (
    <>
      <div className="rsec">Makro <span className="cnt">· {plural(changes.length, "zmiana", "zmiany", "zmian")}</span></div>
      <MacroChangeRows changes={changes} onOpen={onOpen} />
    </>
  );
}

/** The review before the first research run (no research block yet): the changed regimes as a small widget. */
export function MacroChangesWidget({ changes, onOpen }: { changes: MacroChange[]; onOpen: (noteKey: string) => void }) {
  if (!changes.length) return null;
  return (
    <Widget title="Makro" id="inv-review-macro" count={plural(changes.length, "zmiana", "zmiany", "zmian")} body="tight">
      <MacroChangeRows changes={changes} onOpen={onOpen} />
    </Widget>
  );
}

function MacroChangeRows({ changes, onOpen }: { changes: MacroChange[]; onOpen: (noteKey: string) => void }) {
  return (
    <>
      {changes.map((c) => (
        <div key={c.key} className="mchg">
          <div className="v"><button className="nm" onClick={() => onOpen(macroNoteKey(c.key))}>{c.label}</button>: z {c.from_label} na <b>{c.to_label}</b></div>
          {c.since && <span className="when">· od {dm(c.since)}</span>}
        </div>
      ))}
    </>
  );
}
