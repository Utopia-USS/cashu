// The home rail next to the review deck (railLogic.ts has the logic): Sygnały tells what is new since the last
// review and what the review put off, then points to the review for the decisions; Alerty lists only the alerts
// close to their level or fired lately. Every row is one line of a ticker tile, a bold subject and plain text, with
// a tag or icon buttons at the right (the candidates widget in research/Strip.tsx uses the same row).
import type { KeyboardEvent, ReactNode } from "react";
import { Skeleton } from "../../../ui";
import { Widget } from "../../../widgets";
import { dm } from "../labels";
import type { Alert } from "./api";
import { InstTile } from "./InstLabel";
import type { InstLike } from "./logic";
import { railAlerts, railSignals } from "./railLogic";
import { type DecideGroup, type DecideItem, type DecideRest, GROUP_LABEL } from "./reviewDeckLogic";
import { S } from "./HomeRail.strings.ts";
import "./homeRail.css";

/** A subject without an instrument (a portfolio rule) gets a neutral tile. */
const PORTFOLIO: InstLike = { id: "portfolio", label: "Σ", symbol: "Σ", name: "Σ" };

/** One rail row: a plain tile (no health ring: the section header carries the colour), the bold subject and the
 * text; `right` holds a tag or icon buttons. A row with `onOpen` is a link (click or Enter). */
export function RailRow({ inst, title, text, note, right, onOpen }: {
  inst: InstLike | null; title: ReactNode; text?: ReactNode; note?: ReactNode; right?: ReactNode; onOpen?: () => void;
}) {
  const key = (e: KeyboardEvent) => { if (onOpen && e.target === e.currentTarget && e.key === "Enter") { e.preventDefault(); onOpen(); } };
  return (
    <div className={`hr-row${onOpen ? " hr-link" : ""}`} role={onOpen ? "link" : undefined} tabIndex={onOpen ? 0 : undefined}
      onClick={onOpen ? (e) => { if (!(e.target as HTMLElement).closest("button")) onOpen(); } : undefined} onKeyDown={key}>
      <span className={`il cmp${inst ? "" : " hr-pf"}`}><InstTile inst={inst ?? PORTFOLIO} plain /></span>
      <span className="hr-tx"><b>{title}</b>{text && <> <span className="hr-m">{text}</span></>}{note && <span className="hr-n"> · {note}</span>}</span>
      {right && <span className="hr-r">{right}</span>}
    </div>
  );
}

const ROW_GROUPS: DecideGroup[] = ["risk", "chance", "mixed", "plan"];
const MAX_ROWS = 6;

export function SignalsBrief({ items, deck, rest, total, loading, reviewDue, reviewName, lastReviewAt, nextOn, insts, onOpenAsset, onOpenReview, onAll }: {
  /** `decideItems(..., { includeSnoozed: true })`: the subjects the rail sorts into new and put off. */
  items: DecideItem[];
  /** The deck's own Do decyzji items (counted in the review box). */
  deck: DecideItem[];
  rest: DecideRest;
  /** Every open signal (the footer's "Wszystkie (n)"). */
  total: number;
  loading?: boolean;
  reviewDue: boolean; reviewName: string; lastReviewAt: string | null; nextOn: string | null;
  insts: Map<number, InstLike>;
  onOpenAsset: (id: number) => void; onOpenReview: () => void; onAll: (focusId?: number | null) => void;
}) {
  const { fresh, left } = railSignals(items, lastReviewAt);
  const leftKeys = new Set(left.map((d) => d.key));
  // At most six rows; the lead counts all of them, the rest is behind "Wszystkie".
  const shown = [...fresh, ...left].slice(0, MAX_ROWS);
  const lead = fresh.length && left.length ? `${S.leadLeft(left.length)}${S.andNew(fresh.length)}`
    : fresh.length ? `${S.leadNewDue(fresh.length)}${reviewDue && deck.length ? S.decisionsWait : ""}`
    : left.length ? `${S.leadLeft(left.length)}`
    : `${S.nothingNew}${reviewDue ? S.reviewWaits : nextOn ? S.nextReview(dm(nextOn)) : ""}`;
  const count = (g: DecideGroup) => deck.filter((d) => d.group === g && d.kind !== "proposal").reduce((n, d) => n + (g === "fix" ? d.signalIds?.length ?? 1 : 1), 0);
  const proposals = deck.filter((d) => d.kind === "proposal").length;
  const pills: [string, string, number][] = [
    ["risk", S.pillRisk(count("risk")), count("risk")], ["chance", S.pillChance(count("chance")), count("chance")],
    ["mixed", S.pillMixed(count("mixed")), count("mixed")], ["plan", S.pillPlan(count("plan")), count("plan")],
    ["plan", S.pillProposal(proposals), proposals], ["fix", S.pillFix(count("fix")), count("fix")],
  ];
  const decideN = deck.filter((d) => d.kind !== "rules").length;
  return (
    <Widget title={S.signals} id="inv-signals" body="tight" className="hrail"
      footer={<>{rest.review > 0 && <span>{S.unchanged(rest.review)}</span>}<span className="spacer" /><button className="lnk" onClick={() => onAll()} disabled={!total}>{S.all(total)}</button></>}>
      {loading ? <Skeleton h={120} /> : (
        <>
          <p className="hlead">{lead}</p>
          {ROW_GROUPS.filter((g) => shown.some((d) => d.group === g)).map((g) => (
            <div key={g} className="hgrp">
              <div className={`hsect hr-${g}`}>{GROUP_LABEL[g]}</div>
              {shown.filter((d) => d.group === g).map((d) => {
                const inst = d.instrumentId != null ? insts.get(d.instrumentId) ?? { id: d.instrumentId, label: d.title, name: d.title } : null;
                const note = d.snoozedUntil ? S.snoozedTo(dm(d.snoozedUntil)) : leftKeys.has(d.key) ? S.undecided : null;
                return (
                  <RailRow key={d.key} inst={inst} title={d.title} text={d.why} note={note}
                    onOpen={() => (d.instrumentId != null ? onOpenAsset(d.instrumentId) : onAll(d.signalIds?.[0] ?? null))} />
                );
              })}
            </div>
          ))}
          {reviewDue && deck.length > 0 && (
            <div className="hdeck">
              <div className="hr-dt"><b>{reviewName}</b>{decideN > 0 && <span>{S.reviewItems(decideN)}</span>}</div>
              <div className="hr-pills">{pills.filter(([, , n]) => n > 0).map(([cls, text]) => <span key={text} className={`hr-pill hr-${cls}`}>{text}</span>)}</div>
              <div><button className="btn primary sm" onClick={onOpenReview}>{S.openReview}</button></div>
            </div>
          )}
        </>
      )}
    </Widget>
  );
}

export function AlertsBrief({ alerts, near, sinceAt, onManage, onNew }: {
  alerts: Alert[] | null; near: { near_price_pct?: number | null; near_pp?: number | null } | null | undefined;
  sinceAt: string | null; onManage: () => void; onNew: () => void;
}) {
  const all = alerts ?? [];
  const live = all.filter((a) => a.status === "active" || a.status === "triggered");
  const rows = railAlerts(all, near ? { pricePct: near.near_price_pct ?? null, pp: near.near_pp ?? null } : null, sinceAt);
  return (
    <Widget title={S.alerts} id="inv-alerts" body="tight" className="hrail" controls={<button className="btn sm" onClick={onNew}>{S.addNew}</button>}
      footer={<>
        <span className="hlegend"><span><i className="hr-near" />{S.close}</span><span><i className="hr-met" />{S.fired}</span></span>
        <span className="spacer" /><button className="lnk" onClick={onManage}>{S.all(live.length)}</button>
      </>}>
      {!alerts ? <Skeleton h={80} /> : !rows.length ? <p className="hlead hr-soft">{S.noneClose(live.length)}</p>
        : rows.map((r) => (
          <RailRow key={r.id} inst={r.inst} title={r.title} note={r.extra}
            right={<span className={`htag hr-${r.state}`} aria-label={S.stateAria(r.tag, r.state === "met" ? S.fired : S.close)}>{r.tag}</span>} />
        ))}
    </Widget>
  );
}
