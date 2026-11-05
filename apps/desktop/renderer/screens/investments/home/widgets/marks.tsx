// The small marks of the Aktywa / Obserwowane rows (ab24ab6): RowMarks (Portfolio.tsx:27-35, the signal glyph
// `.flag`, the bell / page `.mk` of widgets.tsx Mark), HintChip (hints.tsx, `.hint`), AgentTag mono
// (widgets.tsx:140, `.tag.agent.mono`) and the classify icon (InstLabel.tsx ClassifyButton, `.il-cls`). Pure;
// every text comes formatted from the model. Candidates for packages/ui (instrument marks) once reused.

type FlagState = "positive" | "negative" | "neutral" | "mixed";

export interface MarksProps {
  /** One signal glyph: chance = dot, risk = diamond, review = square, mixed = half green / half red. */
  flag: { state: FlagState; label: string } | null;
  /** Bell: the nearest live alert's fact. */
  alert: string | null;
  /** Page: "n nowych notatek". */
  notes: string | null;
}

// `.flag` (7px, inline-block; `.il .ln .flag` drops the 5px left margin) with the shape rules of index.css:588-592, 988.
const flagShape: Record<FlagState, string> = {
  positive: "rounded-full bg-positive",
  negative: "rotate-45 scale-90 rounded-[calc(var(--spacing)/4)] bg-negative",
  neutral: "rounded-[calc(var(--spacing)/4)] bg-fg-muted",
  mixed:
    "rounded-full bg-[linear-gradient(90deg,var(--color-positive)_50%,var(--color-negative)_50%)]",
};

const BELL = "M3 8.5V5.5a3 3 0 0 1 6 0v3l.9 1H2.1zM4.8 10.2a1.3 1.3 0 0 0 2.4 0";
const PAGE = "M3 1.5h4l2.5 2.5v6.5h-6.5zM7 1.5V4h2.5M4.5 6.5h3M4.5 8.5h3";

/** `.mk`: a 12px box with an 11px stroked glyph (muted; notes in the info colour), 1px after the name. */
function Mark({ path, title, info }: { path: string; title: string; info?: boolean }) {
  return (
    <span
      role="img"
      aria-label={title}
      title={title}
      className={`ml-px inline-flex size-3 flex-none items-center justify-center ${info ? "text-info" : "text-fg-muted"}`}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 12 12"
        className="block size-2.75 fill-none stroke-current"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d={path} />
      </svg>
    </span>
  );
}

/** The markers after an instrument's name: one signal glyph, the bell, the page. */
export function RowMarks({ flag, alert, notes }: MarksProps) {
  return (
    <>
      {flag && (
        <span
          role="img"
          className={`inline-block size-1.75 align-middle ${flagShape[flag.state]}`}
          title={flag.label}
          aria-label={flag.label}
        />
      )}
      {alert != null && <Mark path={BELL} title={alert} />}
      {notes != null && <Mark path={PAGE} title={notes} info />}
    </>
  );
}

export interface HintChipProps {
  code: string;
  text: string;
  title: string;
  severity: "rule" | "review" | "info";
}

// `.hint` (`.tag` metrics, 1px 6px) and its severities: rule = warn solid 600, review = text in a muted outline.
const hintTone = {
  rule: "border-transparent bg-warning-bg font-strong text-warning",
  review: "border-fg-muted text-fg",
  info: "border-border text-fg-muted",
} as const;

/** The strategy hint chip (inert): the main hint's 1-4 words, its line as the title. */
export function HintChip({ code, text, title, severity }: HintChipProps) {
  return (
    <span
      data-hint={code}
      title={title}
      className={`inline-flex max-w-39.5 items-center whitespace-nowrap rounded-full border px-1.5 py-px align-middle text-2xs leading-normal tabular-nums ${hintTone[severity]}`}
    >
      <span className="min-w-0 overflow-hidden text-ellipsis">{text}</span>
    </span>
  );
}

/** `.tag.agent.mono`: the agent monogram only, the word in the title and for screen readers. */
export function AgentTag({ text }: { text: string }) {
  return (
    <span
      title={text}
      className="inline-flex items-center whitespace-nowrap rounded-full border border-transparent bg-info-bg px-0.5 text-2xs font-medium leading-normal text-info"
    >
      <i
        aria-hidden="true"
        className="size-3.25 rounded-2xs bg-info text-center font-sans text-5xs-plus font-bold not-italic leading-3.25 text-surface-raised"
      >
        A
      </i>
      <span className="sr-only">{text}</span>
    </span>
  );
}

/** `.il-cls`: the tag icon that opens the classification (warn glyph, warn tint while hovered or open). */
export function ClassifyButton({
  title,
  label,
  expanded,
  onToggle,
}: {
  title: string;
  label: string;
  expanded: boolean;
  onToggle(): void;
}) {
  return (
    <button
      type="button"
      data-classify=""
      title={title}
      aria-label={label}
      aria-haspopup="dialog"
      aria-expanded={expanded}
      onClick={onToggle}
      className="ml-px inline-flex size-6 flex-none cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent p-0 text-warning hover:bg-warning-bg aria-expanded:bg-warning-bg"
    >
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
        aria-hidden="true"
        className="block size-3.75"
      >
        <path d="M2.75 2.75h4.6c.4 0 .78.16 1.06.44l4.84 4.84a1.5 1.5 0 0 1 0 2.12l-3.1 3.1a1.5 1.5 0 0 1-2.12 0L3.19 8.41A1.5 1.5 0 0 1 2.75 7.35z" />
        <circle cx={5.75} cy={5.75} r={1} fill="currentColor" stroke="none" />
      </svg>
    </button>
  );
}

/** `.wbar` + the percentage of a `td.wcell`: a 56 x 5 bar, the fill relative to the largest weight. */
export function WeightBar({ fill, text }: { fill: number; text: string }) {
  return (
    <>
      <span
        aria-hidden="true"
        className="relative mr-1.5 inline-block h-1.25 w-14 overflow-hidden rounded-3xs bg-chip align-middle"
      >
        <i
          className="absolute inset-y-0 left-0 rounded-3xs bg-fg-muted"
          style={{ width: `${fill}%` }}
        />
      </span>
      {text}
    </>
  );
}
