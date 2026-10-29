// P6 macro regimes ("Makro", design/P6/macro-design.md; P7 strip-design.md 2.1; P9 briefs): the home column Makro (five
// rows: title, toned state, `od <miesiąc rok>`, one basic number, then the brief "for dummies": the headline in bold, why,
// `Co sprzyja` / `Na co uważać`; the BE's plain sentence until the first brief; hover / focus opens the explain popover;
// the title opens the regime's drawer with its notes) and the Sunday review lines (regimes whose state changed in the
// digest period). P9: no research page widget any more. Pure logic lives in macro.ts.
import { useId } from "react";
import { Skeleton } from "../../../../ui";
import { Mark, Widget } from "../../../../widgets";
import { dm } from "../../labels";
import { useMacro } from "./data";
import {
  explainHead, explainText, hasExplain, historyTitle, macroAsOf, macroHeadline, macroNoteKey, macroNumber, sinceMonth, staleText, stateParts, toneCls,
} from "./macro";
import { Explain, useExplainDismiss } from "./primitives";
import type { StripCtx } from "./Strip";
import type { MacroChange, MacroRegime } from "./types";
import { S } from "./MacroWidgets.strings.ts";

type LineCtx = Pick<StripCtx, "slug" | "nonce" | "onOpenTopic">;

/** Home column `Makro`: five rows. Nothing (not even the header) without the endpoint or without regimes. */
export function MacroColumn({ ctx }: { ctx: LineCtx }) {
  const q = useMacro(ctx.slug, ctx.nonce ?? 0);
  if (!q.data && !q.loading) return null;
  if (q.data && !q.data.regimes.length) return null;
  const asOf = macroAsOf(q.data);
  return (
    <div className="mcol">
      <div className="rsec">{S.macro} {asOf && <span className="cnt" title={S.lastSession}>· {S.stateOn(dm(asOf))}</span>}</div>
      {q.data ? <MacroRows regimes={q.data.regimes} onOpen={ctx.onOpenTopic} /> : <Skeleton h={190} r={8} />}
    </div>
  );
}

export function MacroRows({ regimes, onOpen, wide }: { regimes: MacroRegime[]; onOpen: (noteKey: string) => void; wide?: boolean }) {
  return <div className={`mrows${wide ? " wide" : ""}`} role="list" aria-label={S.macro}>{regimes.map((r) => <MacroRow key={r.key} r={r} onOpen={onOpen} />)}</div>;
}

export function MacroRow({ r, onOpen }: { r: MacroRegime; onOpen: (noteKey: string) => void }) {
  const xid = useId();
  const parts = stateParts(r.state_label);
  const tone = toneCls(r.tone);
  const since = sinceMonth(r), stale = staleText(r), hist = historyTitle(r);
  const num = macroNumber(r);
  const explain = hasExplain(r);
  const dismiss = useExplainDismiss();
  const b = r.missing ? null : r.brief ?? null;
  return (
    <div className={`mrow${r.missing ? " off" : ""}${dismiss.hidden ? " xoff" : ""}`} role="listitem" data-macro={r.key} {...(explain ? dismiss.props : {})}>
      <div className="mh">
        <button className="t" aria-describedby={explain ? xid : undefined} onClick={() => onOpen(macroNoteKey(r.key))}>{r.label}</button>
        {r.missing
          ? <b className="st off">{S.noData}</b>
          : parts.map((p, i) => <b key={i} className={`st ${i === 0 ? tone : "warn"}`}>{p}</b>)}
        {(since || stale) && <span className="since" title={hist ?? undefined}>{since}{since && stale ? " · " : ""}{stale && <span className="warn" title={S.lastQuote}>{stale}</span>}</span>}
        {num && <span className="since num" title={num.title}>{num.text}</span>}
        {r.unread > 0 && <Mark kind="notes" title={S.nNewNotes(r.unread)} />}
      </div>
      <div className="bh" data-brief={b?.note_id}>{macroHeadline(r)}</div>
      {b?.why && <div className="bw">{b.why}</div>}
      {b && b.supports.length > 0 && <BriefList k={S.supports} items={b.supports} cls="sup" />}
      {b && b.risks.length > 0 && <BriefList k={S.risks} items={b.risks} cls="rsk" />}
      {explain && <Explain id={xid} head={explainHead(r)} tone={tone} text={explainText(r)!} metrics={r.missing ? [] : r.metrics} />}
    </div>
  );
}

/** `Co sprzyja` / `Na co uważać`: a small label and up to 3 short bullets. */
export function BriefList({ k, items, cls }: { k: string; items: string[]; cls: "sup" | "rsk" }) {
  return (
    <div className={`bl ${cls}`}>
      <span className="k">{k}</span>
      <ul>{items.map((t, i) => <li key={i}>{t}</li>)}</ul>
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
    <Widget title={S.macro} id="inv-macro" body="tight" tags={asOf ? <span className="tag" title={S.lastSession}>{S.stateOn(dm(asOf))}</span> : undefined}>
      <MacroRows wide regimes={q.data.regimes} onOpen={ctx.onOpenTopic} />
    </Widget>
  );
}

/** Review column (P6 design 4): regimes whose state changed in the digest period, one bold line each; the
 * label opens the regime's drawer. Nothing when none changed. */
export function MacroChanges({ changes, onOpen }: { changes: MacroChange[]; onOpen: (noteKey: string) => void }) {
  if (!changes.length) return null;
  return (
    <>
      <div className="rsec">{S.macro} <span className="cnt">· {S.nChanges(changes.length)}</span></div>
      <MacroChangeRows changes={changes} onOpen={onOpen} />
    </>
  );
}

/** The review before the first research run (no research block yet): the changed regimes as a small widget. */
export function MacroChangesWidget({ changes, onOpen }: { changes: MacroChange[]; onOpen: (noteKey: string) => void }) {
  if (!changes.length) return null;
  return (
    <Widget title={S.macro} id="inv-review-macro" count={S.nChanges(changes.length)} body="tight">
      <MacroChangeRows changes={changes} onOpen={onOpen} />
    </Widget>
  );
}

function MacroChangeRows({ changes, onOpen }: { changes: MacroChange[]; onOpen: (noteKey: string) => void }) {
  return (
    <>
      {changes.map((c) => (
        <div key={c.key} className="mchg">
          <div className="v"><button className="nm" onClick={() => onOpen(macroNoteKey(c.key))}>{c.label}</button>{S.fromTo(c.from_label)}<b>{c.to_label}</b></div>
          {c.since && <span className="when">{S.since(dm(c.since))}</span>}
        </div>
      ))}
    </>
  );
}
