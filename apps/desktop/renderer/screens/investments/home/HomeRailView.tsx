// The home rail next to the main column (ab24ab6 v2/HomeRail.tsx + homeRail.css, research/Strip.tsx CandidatesRail,
// laid out as design V5): ONE quiet card with three sections, Sygnały (its header, then the rows new since the review
// by category and those put off in it; no lead sentence, no unchanged count), Alerty (close to their level or fired lately, with the close / fired counts) and Kandydaci (open research
// candidates, their actions shown on hover or focus, Why as a popover from its button). One row grammar: a ticker
// tile, a bold subject and quiet text, a tag or icon buttons at the right. The review itself is the hero's button
// (its breakdown in the button's popover). Pure: every text and row comes from railModel.ts.
import { S } from "@cashu/i18n/investments/v2/HomeRail.strings";
import { S as P } from "@cashu/i18n/investments/v2/research/primitives.strings";
import { S as C } from "@cashu/i18n/investments/v2/research/Strip.strings";
import { RailRow, type RailRowData, Skeleton, Widget, WidgetSection } from "@cashu/ui";

const lead = "m-0 mb-1 text-sm-plus font-medium leading-widget text-fg";
const dot = {
  risk: "bg-negative",
  chance: "bg-positive",
  mixed: "bg-fg-muted",
  plan: "bg-info",
  left: "bg-fg-muted",
} as const;

export type RailGroup = keyof typeof dot;

/** The quiet `All (n)` link of a section header (design V5: secondary ink with a chevron, no underline). */
function AllLink({
  text,
  onPress,
  disabled,
}: {
  text: string;
  onPress(): void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onPress}
      disabled={disabled}
      className="group/all inline-flex cursor-pointer items-center gap-0.5 border-0 bg-transparent p-0 text-xs-plus text-fg-secondary hover:text-fg disabled:cursor-default disabled:text-fg-muted"
    >
      {text}
      <svg
        viewBox="0 0 16 16"
        aria-hidden="true"
        className="size-3.25 fill-none stroke-current transition-transform duration-200 group-hover/all:translate-x-0.5"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M6.5 4.5 10 8l-3.5 3.5" />
      </svg>
    </button>
  );
}

export interface SignalsBriefProps {
  loading: boolean;
  /** New since the review (by category), then put off in the review: the label says which. */
  groups: readonly { group: RailGroup; label: string; rows: readonly RailRowData[] }[];
  /** Nothing to list: the quiet line in place of the groups. */
  empty: string | null;
  all: string;
  allDisabled: boolean;
  onAll(): void;
}

export function SignalsBrief(props: SignalsBriefProps) {
  return (
    <WidgetSection
      title={S.signals}
      id="inv-signals"
      controls={<AllLink text={props.all} onPress={props.onAll} disabled={props.allDisabled} />}
    >
      {props.loading ? (
        <Skeleton height={120} />
      ) : props.empty != null ? (
        <p className="m-0 text-sm-plus leading-widget text-fg-secondary">{props.empty}</p>
      ) : (
        props.groups.map((g) => (
          <div key={g.group} className="group/g">
            <div className="mt-3 mb-0.5 flex items-center gap-1.75 text-2xs-plus text-fg-muted group-first/g:mt-1">
              <i aria-hidden="true" className={`size-1.5 rounded-full ${dot[g.group]}`} />
              {g.label}
            </div>
            {g.rows.map((row) => (
              <RailRow key={row.key} row={row} quiet />
            ))}
          </div>
        ))
      )}
    </WidgetSection>
  );
}

const kind = {
  near: "bg-warning-bg text-warning",
  met: "bg-positive-bg text-positive",
} as const;
const stateDot = { near: "bg-warning", met: "bg-positive" } as const;

interface AlertRailRow extends RailRowData {
  tag: string;
  state: "near" | "met";
  aria: string;
}

export interface AlertsBriefProps {
  loading: boolean;
  /** `1 close` / `0 fired` of the rows shown. */
  counts: { close: string; fired: string };
  /** The empty line (`Nic blisko progu...`) when no alert is close or fired. */
  empty: string | null;
  rows: readonly AlertRailRow[];
  all: string;
  onManage(): void;
}

export function AlertsBrief(props: AlertsBriefProps) {
  return (
    <WidgetSection
      title={S.alerts}
      id="inv-alerts"
      footer={
        <>
          <span className="inline-flex items-center gap-1.5">
            <i aria-hidden="true" className={`size-1.5 rounded-full ${stateDot.near}`} />
            {props.counts.close}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <i aria-hidden="true" className={`size-1.5 rounded-full ${stateDot.met}`} />
            {props.counts.fired}
          </span>
          <span className="flex-1" />
          <AllLink text={props.all} onPress={props.onManage} />
        </>
      }
    >
      {props.loading ? (
        <Skeleton height={80} />
      ) : props.empty != null ? (
        <p className="m-0 text-sm-plus leading-widget text-fg-secondary">{props.empty}</p>
      ) : (
        props.rows.map((row) => (
          <RailRow
            key={row.key}
            row={row}
            quiet
            right={
              <span
                className={`whitespace-nowrap rounded-full px-2 py-0.5 text-2xs-plus ${kind[row.state]}`}
              >
                <span aria-hidden="true">{row.tag}</span>
                <span className="sr-only">{row.aria}</span>
              </span>
            }
          />
        ))
      )}
    </WidgetSection>
  );
}

const icon = {
  base: "inline-grid size-7 cursor-pointer place-items-center rounded-sm-plus border-0 bg-transparent p-0 leading-control transition-colors duration-150 disabled:cursor-default disabled:opacity-45",
  idle: "text-fg-muted enabled:hover:bg-chip enabled:hover:text-fg",
  on: "bg-info-bg text-info",
  ok: "text-fg-muted enabled:hover:bg-chip enabled:hover:text-positive",
  watched: "text-positive",
  no: "text-fg-muted enabled:hover:bg-chip enabled:hover:text-negative",
} as const;
// The candidate's actions: over the row's right end on a fade (the note never collides), hidden until the row is
// hovered or focused; they stay while the row is watched or its Why is open.
const acts =
  "absolute top-1.5 right-0 flex gap-0.5 bg-linear-to-r from-transparent via-surface-raised via-30% to-surface-raised pl-7 transition duration-150 ease-out";
const actsHidden =
  "translate-x-1 opacity-0 group-hover/cand:translate-x-0 group-hover/cand:opacity-100 group-focus-within/cand:translate-x-0 group-focus-within/cand:opacity-100";

interface CandidateRailRow {
  row: RailRowData;
  noteId: number;
  name: string;
  whyOpen: boolean;
  watched: boolean;
  busy: boolean;
  /** The criteria lines in the Why popover (`✓ ...` / `· ...`, the context, else the title). */
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
    <WidgetSection
      title={C.candidates}
      id="inv-candidates"
      controls={props.all != null ? <AllLink text={props.all} onPress={props.onAll} /> : undefined}
    >
      {props.loading ? (
        <Skeleton height={96} />
      ) : props.rows.length ? (
        <>
          {props.lead != null && <p className={lead}>{props.lead}</p>}
          {props.rows.map((c) => (
            <div key={c.noteId} data-note={c.noteId} className="group/cand relative">
              <RailRow row={c.row} quiet clamp={2} />
              <span className={`${acts} ${c.watched || c.whyOpen ? "" : actsHidden}`}>
                <span className="relative inline-flex">
                  <button
                    type="button"
                    className={`${icon.base} ${c.whyOpen ? icon.on : icon.idle}`}
                    title={C.whyFits}
                    aria-label={C.whyFitsAria(c.name)}
                    aria-expanded={c.whyOpen}
                    onClick={c.onWhy}
                  >
                    {ICON_WHY}
                  </button>
                  {c.whyOpen && (
                    // The Why popover grows from its button (design V5 `.pop`): the criteria lines.
                    <span
                      role="dialog"
                      aria-label={C.whyFits}
                      className="absolute top-full -right-16 z-20 mt-1.5 grid w-62.5 origin-top-right gap-0.5 rounded-md border border-border-strong bg-surface-overlay px-3.5 py-3 text-xs-plus leading-normal text-fg-secondary shadow-tip"
                    >
                      {c.why.map((line, index) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: the criteria lines are a fixed list.
                        <span key={index}>{line}</span>
                      ))}
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  className={`${icon.base} ${c.watched ? icon.watched : icon.ok}`}
                  title={c.watched ? C.watching : P.watch}
                  aria-label={`${P.watch}: ${c.name}`}
                  disabled={c.busy || c.watched}
                  onClick={c.onWatch}
                >
                  {c.watched ? ICON_CHECK : ICON_WATCH}
                </button>
                <button
                  type="button"
                  className={`${icon.base} ${icon.no}`}
                  title={C.dismissTitle}
                  aria-label={`${C.dismissTitle}: ${c.name}`}
                  disabled={c.busy}
                  onClick={c.onDismiss}
                >
                  {ICON_DISMISS}
                </button>
              </span>
            </div>
          ))}
        </>
      ) : (
        <p className="m-0 text-sm-plus leading-widget text-fg-secondary">{C.noCandidates}</p>
      )}
    </WidgetSection>
  );
}

/** The rail as one quiet card: the sections in order (the candidates only after a research run). */
export function HomeRailCard({
  signals,
  alerts,
  candidates,
}: {
  signals: SignalsBriefProps;
  alerts: AlertsBriefProps;
  candidates: CandidatesRailProps | null;
}) {
  return (
    <Widget variant="quiet" title={null} label={S.rail}>
      <SignalsBrief {...signals} />
      <AlertsBrief {...alerts} />
      {candidates && <CandidatesRail {...candidates} />}
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
const ICON_CHECK = (
  <svg {...svg} aria-hidden="true" strokeLinejoin="round">
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </svg>
);
const ICON_DISMISS = (
  <svg {...svg} aria-hidden="true">
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);
