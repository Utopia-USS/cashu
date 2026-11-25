export type HealthTone = "sup" | "weak" | "inv" | "ful" | "plain";

export interface HealthPillProps {
  /** The state word (e.g. "wzmacnia", "bez researchu"). */
  label: string;
  /** Hue: supports (positive), weakens (negative outline), invalidates (negative fill, 600), fulfilled (violet). */
  tone: HealthTone;
  /** Dashed outline (no thesis / no research). */
  dashed?: boolean;
  /** Stale research: the whole pill at 62 % opacity. */
  muted?: boolean;
  /** The dot is hollow (the state rests only on research from before the thesis change). */
  hollow?: boolean;
  title?: string;
}

const pillTone: Record<HealthTone, string> = {
  sup: "border-positive text-positive",
  weak: "border-negative text-negative",
  inv: "border-transparent bg-negative-bg font-strong text-negative",
  ful: "border-net text-net",
  plain: "border-border text-fg-muted",
};
const dotTone: Record<HealthTone, string> = {
  sup: "bg-positive",
  weak: "bg-negative",
  inv: "bg-negative",
  ful: "bg-net",
  plain: "bg-fg-muted",
};

/** Thesis health pill (old research `.health` + `.sup .weak .inv .ful .none .muted .pre`): 11px rounded pill
 * with a 6px dot and the state word. */
export function HealthPill({ label, tone, dashed, muted, hollow, title }: HealthPillProps) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1.25 whitespace-nowrap rounded-full border py-px pr-1.75 pl-1.5 text-2xs leading-normal ${pillTone[tone]} ${dashed ? "border-dashed" : ""} ${muted ? "opacity-62" : ""}`}
    >
      <i
        aria-hidden="true"
        className={`size-1.5 flex-none rounded-full ${hollow ? "bg-transparent shadow-[inset_0_0_0_1.5px_currentColor]" : dotTone[tone]}`}
      />
      {label}
    </span>
  );
}

export type RelationTone = "sup" | "weak" | "inv" | "ful" | "neu";

export interface RelationIconProps {
  tone: RelationTone;
  /** The circled glyph (+, -, ~, a check mark). */
  glyph: string;
  /** Accessible name and tooltip (e.g. "wzmacnia tezę"). */
  label: string;
}

const relTone: Record<RelationTone, string> = {
  sup: "border-current text-positive",
  weak: "border-current text-negative",
  inv: "border-negative bg-negative text-surface-raised",
  ful: "border-current text-net",
  neu: "border-current text-fg-muted",
};

/** A note's effect on the thesis (old research `.ri`): a 16px circle with a 1.5px ring and a bold glyph. */
export function RelationIcon({ tone, glyph, label }: RelationIconProps) {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={`mt-px box-border inline-flex size-4 flex-none items-center justify-center rounded-full border-[1.5px] font-system leading-none font-bold ${tone === "ful" ? "text-3xs" : "text-xs"} ${relTone[tone]}`}
    >
      {glyph}
    </span>
  );
}
