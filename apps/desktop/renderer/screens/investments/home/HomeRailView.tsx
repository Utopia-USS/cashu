// The home rail next to the review deck (ab24ab6 v2/HomeRail.tsx + homeRail.css, research/Strip.tsx
// CandidatesRail): Sygnały (new since the review, put off by it, the review box), Alerty (close to their level or
// fired lately), Kandydaci (open research candidates). One row grammar: a ticker tile, a bold subject and plain
// text, a tag or icon buttons at the right. Pure: every text and row comes from railModel.ts.
import { S } from "@cashu/i18n/investments/v2/HomeRail.strings";
import { S as P } from "@cashu/i18n/investments/v2/research/primitives.strings";
import { S as C } from "@cashu/i18n/investments/v2/research/Strip.strings";
import { Button, InstTile, Pill, Skeleton, Widget } from "@cashu/ui";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";

/** One rail row as the model hands it over (the tile's monogram, the bold subject, the muted text and note). */
export interface RailRowData {
  key: string;
  monogram: string;
  /** A subject without an instrument (a portfolio rule): the quiet Σ tile. */
  portfolio?: boolean;
  title: string;
  text?: string | null;
  note?: string | null;
  onOpen?: () => void;
}

/** One rail row (old `.hr-row`): `first` drops the top rule (old `.hgrp .hr-row:first-of-type`). */
function RailRow({ row, right, first }: { row: RailRowData; right?: ReactNode; first?: boolean }) {
  const { onOpen } = row;
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    if (onOpen && event.target === event.currentTarget && event.key === "Enter") {
      event.preventDefault();
      onOpen();
    }
  };
  const click = (event: MouseEvent<HTMLDivElement>) => {
    if (!(event.target as HTMLElement).closest("button")) onOpen?.();
  };
  const link = onOpen
    ? "cursor-pointer rounded-sm hover:bg-subtle focus-visible:outline-2 focus-visible:outline-info focus-visible:-outline-offset-2"
    : "";
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a link row (old role=link, Enter opens) holding buttons.
    <div
      role={onOpen ? "link" : undefined}
      tabIndex={onOpen ? 0 : undefined}
      onClick={onOpen ? click : undefined}
      onKeyDown={onOpen ? key : undefined}
      className={`flex items-start gap-2.5 py-2 ${first ? "" : "border-t border-border"} ${link}`}
    >
      <span className="mt-px flex-none">
        <InstTile monogram={row.monogram} density="compact" quiet={row.portfolio} />
      </span>
      <span className="min-w-0 flex-1 text-sm leading-cozy">
        <b className="font-heavy">{row.title}</b>
        {row.text ? (
          <>
            {" "}
            <span className="text-fg-muted">{row.text}</span>
          </>
        ) : null}
        {row.note ? <span className="text-xs text-fg-muted"> · {row.note}</span> : null}
      </span>
      {right != null && <span className="ml-auto flex flex-none items-center gap-1">{right}</span>}
    </div>
  );
}

const lead = "mt-0.5 mb-2 text-md leading-cozy";
const sect = {
  risk: "text-negative",
  chance: "text-positive",
  mixed: "text-fg-muted",
  plan: "text-info",
} as const;
const pillTone = {
  risk: "negative",
  chance: "positive",
  mixed: "info",
  plan: "info",
  fix: "warning",
} as const;

export type RailGroup = keyof typeof sect;
export type RailPill = keyof typeof pillTone;

export interface SignalsBriefProps {
  loading: boolean;
  lead: string;
  groups: readonly { group: RailGroup; label: string; rows: readonly RailRowData[] }[];
  /** The review box (only while the review is due and the deck has items). */
  review: {
    name: string;
    items: string | null;
    pills: readonly { tone: RailPill; text: string }[];
    onOpen(): void;
  } | null;
  unchanged: string | null;
  all: string;
  allDisabled: boolean;
  onAll(): void;
}

export function SignalsBrief(props: SignalsBriefProps) {
  return (
    <Widget
      title={S.signals}
      id="inv-signals"
      tight
      footer={
        <>
          {props.unchanged != null && <span>{props.unchanged}</span>}
          <span className="flex-1" />
          <Button variant="link" size="md" onPress={props.onAll} disabled={props.allDisabled}>
            {props.all}
          </Button>
        </>
      }
    >
      {props.loading ? (
        <Skeleton height={120} />
      ) : (
        <>
          <p className={`${lead} font-strong`}>{props.lead}</p>
          {props.groups.map((g) => (
            <div key={g.group}>
              <div
                className={`mt-1.5 mb-0.5 flex items-center gap-2 text-2xs font-bold uppercase tracking-eyebrow ${sect[g.group]}`}
              >
                {g.label}
                <span className="h-px flex-1 bg-border" />
              </div>
              {g.rows.map((row, index) => (
                <RailRow key={row.key} row={row} first={index === 0} />
              ))}
            </div>
          ))}
          {props.review && (
            <div className="mt-2 mb-1 grid gap-2 rounded-md bg-subtle px-3 py-2.5">
              <div className="flex flex-wrap items-baseline gap-2">
                <b>{props.review.name}</b>
                {props.review.items != null && (
                  <span className="text-sm text-fg-muted">{props.review.items}</span>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {props.review.pills.map((pill) => (
                  <Pill key={pill.text} tone={pillTone[pill.tone]} size="sm">
                    {pill.text}
                  </Pill>
                ))}
              </div>
              <div>
                <Button variant="primary" size="sm" onPress={props.review.onOpen}>
                  {S.openReview}
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </Widget>
  );
}

const htag = {
  near: "bg-warning-bg text-warning",
  met: "bg-positive-bg text-positive",
} as const;
const dot = { near: "bg-warning", met: "bg-positive" } as const;

interface AlertRailRow extends RailRowData {
  tag: string;
  state: "near" | "met";
  aria: string;
}

export interface AlertsBriefProps {
  loading: boolean;
  /** The empty line (`Nic blisko progu...`) when no alert is close or fired. */
  empty: string | null;
  rows: readonly AlertRailRow[];
  all: string;
  onManage(): void;
  onNew(): void;
}

export function AlertsBrief(props: AlertsBriefProps) {
  return (
    <Widget
      title={S.alerts}
      id="inv-alerts"
      tight
      controls={
        <Button size="sm" onPress={props.onNew}>
          {S.addNew}
        </Button>
      }
      footer={
        <>
          <span className="inline-flex gap-3 text-xs text-fg-muted">
            <span>
              <i className={`mr-1.25 inline-block size-2 rounded-full ${dot.near}`} />
              {S.close}
            </span>
            <span>
              <i className={`mr-1.25 inline-block size-2 rounded-full ${dot.met}`} />
              {S.fired}
            </span>
          </span>
          <span className="flex-1" />
          <Button variant="link" size="md" onPress={props.onManage}>
            {props.all}
          </Button>
        </>
      }
    >
      {props.loading ? (
        <Skeleton height={80} />
      ) : props.empty != null ? (
        <p className={`${lead} font-regular text-fg-muted`}>{props.empty}</p>
      ) : (
        props.rows.map((row) => (
          <RailRow
            key={row.key}
            row={row}
            right={
              <span
                className={`whitespace-nowrap rounded-full px-2.25 py-0.5 text-xs font-strong ${htag[row.state]}`}
              >
                <span aria-hidden="true">{row.tag}</span>
                <span className="sr-only">{row.aria}</span>
              </span>
            }
          />
        ))
      )}
    </Widget>
  );
}

const icon = {
  base: "inline-grid size-7 cursor-pointer place-items-center rounded-sm-plus border p-0 leading-control disabled:cursor-default disabled:opacity-45",
  idle: "border-border bg-transparent text-fg-muted",
  on: "border-transparent bg-info-bg text-info",
  hover: "enabled:hover:border-fg-muted enabled:hover:text-fg",
  ok: "enabled:hover:border-positive enabled:hover:text-positive",
  no: "enabled:hover:border-negative enabled:hover:text-negative",
} as const;

interface CandidateRailRow {
  row: RailRowData;
  noteId: number;
  name: string;
  whyOpen: boolean;
  watched: boolean;
  busy: boolean;
  /** The criteria lines under the row (`✓ ...` / `· ...`, the context, else the title). */
  why: readonly string[];
  onWhy(): void;
  onWatch(): void;
  onDismiss(): void;
}

export interface CandidatesRailProps {
  loading: boolean;
  lead: string | null;
  /** `wszyscy (N)` when more than three are open. */
  all: string | null;
  onAll(): void;
  rows: readonly CandidateRailRow[];
}

export function CandidatesRail(props: CandidatesRailProps) {
  return (
    <Widget
      title={C.candidates}
      id="inv-candidates"
      tight
      controls={
        props.all != null ? (
          <Button variant="link" size="md" onPress={props.onAll}>
            {props.all}
          </Button>
        ) : undefined
      }
    >
      {props.loading ? (
        <Skeleton height={96} />
      ) : props.rows.length ? (
        <>
          {props.lead != null && <p className={`${lead} font-strong`}>{props.lead}</p>}
          {props.rows.map((c) => (
            <div key={c.noteId} data-note={c.noteId}>
              <RailRow
                row={c.row}
                right={
                  <>
                    <button
                      type="button"
                      className={`${icon.base} ${c.whyOpen ? icon.on : `${icon.idle} ${icon.hover}`}`}
                      title={C.whyFits}
                      aria-label={C.whyFitsAria(c.name)}
                      aria-expanded={c.whyOpen}
                      onClick={c.onWhy}
                    >
                      {ICON_WHY}
                    </button>
                    <button
                      type="button"
                      className={`${icon.base} ${c.watched ? icon.on : `${icon.idle} ${icon.ok}`}`}
                      title={c.watched ? C.watching : P.watch}
                      aria-label={`${P.watch}: ${c.name}`}
                      disabled={c.busy || c.watched}
                      onClick={c.onWatch}
                    >
                      {ICON_WATCH}
                    </button>
                    <button
                      type="button"
                      className={`${icon.base} ${icon.idle} ${icon.no}`}
                      title={C.dismissTitle}
                      aria-label={`${C.dismissTitle}: ${c.name}`}
                      disabled={c.busy}
                      onClick={c.onDismiss}
                    >
                      {ICON_DISMISS}
                    </button>
                  </>
                }
              />
              {c.whyOpen && (
                <div className="mt-0 mb-2 ml-11.5 grid gap-0.5 text-xs text-fg-muted">
                  {c.why.map((line, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: the criteria lines are a fixed list.
                    <span key={index}>{line}</span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </>
      ) : (
        <div className="px-3 py-4.5 text-center text-sm text-fg-muted">{C.noCandidates}</div>
      )}
    </Widget>
  );
}

const svg = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  className: "size-3.75",
} as const;
const ICON_WHY = (
  <svg {...svg} aria-hidden="true" strokeLinejoin="round">
    <circle cx="12" cy="12" r="9" />
    <path d="M9.5 9.5a2.5 2.5 0 0 1 4.8 1c0 1.7-2.3 2.2-2.3 3.5" />
    <path d="M12 17h.01" />
  </svg>
);
const ICON_WATCH = (
  <svg {...svg} aria-hidden="true" strokeLinejoin="round">
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);
const ICON_DISMISS = (
  <svg {...svg} aria-hidden="true">
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);
