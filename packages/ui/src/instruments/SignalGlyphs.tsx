import { ALERT_STATUS, POLARITY, S } from "@cashu/i18n/core/widgets.strings";

// The signal and alert glyphs of the Python app (ab24ab6 widgets.tsx PolDot, AlertIcon, AlertStatus,
// PolarityText; index.css `.pd`, `.ai`, `.status`, `.polt`): one glyph language everywhere (chance = green
// dot, risk = red diamond, review = grey square, mixed = half green / half red), the alert state ring
// (far / near / met) and the coloured-dot status words of the alerts manager.

export type GlyphState = "positive" | "negative" | "neutral" | "mixed";

const pdShape: Record<GlyphState, string> = {
  positive: "rounded-full bg-positive",
  negative: "rotate-45 scale-90 rounded-5xs bg-negative",
  neutral: "rounded-5xs bg-fg-muted",
  mixed:
    "rounded-full bg-[linear-gradient(90deg,var(--color-positive)_50%,var(--color-negative)_50%)]",
};

export interface PolDotProps {
  /** The signal's polarity (unknown values read as neutral). */
  polarity?: string | null;
  /** A subject's state over its signals; wins over `polarity` (`mixed` = half green / half red). */
  state?: GlyphState | null;
  /** Settled (decided / snoozed): the neutral square. */
  quiet?: boolean;
  /** `sm` = the 6px glyph of a dialog sub-row (old `.sub-sig .pd`). */
  size?: "md" | "sm";
  /** Makes the glyph a labelled image (else decorative). */
  title?: string;
  /** Layout only (margin, offset). */
  className?: string;
}

const known = (v: string | null | undefined): GlyphState =>
  v === "positive" || v === "negative" || v === "mixed" ? v : "neutral";

/** Old `.pd`: the 8px signal glyph. */
export function PolDot({
  polarity,
  state,
  quiet,
  size = "md",
  title,
  className = "",
}: PolDotProps) {
  const shape = pdShape[quiet ? "neutral" : known(state ?? polarity)];
  const cls = `inline-block flex-none ${size === "sm" ? "size-1.5" : "size-2"} ${shape} ${className}`;
  return title ? (
    <span className={cls} role="img" aria-label={title} title={title} />
  ) : (
    <span className={cls} aria-hidden="true" />
  );
}

type AlertGlyphState = "far" | "near" | "met";

const aiState: Record<AlertGlyphState, string> = {
  far: "text-fg-muted after:size-0",
  near: "text-warning after:size-1",
  met: "text-positive after:size-1.5",
};

export interface AlertIconProps {
  state: AlertGlyphState;
  /** Tooltip and accessible name (default: the state word). */
  title?: string;
  /** Layout only (margin). */
  className?: string;
}

/** Old `.ai`: the 10px ring (far), ring + dot (near, warn) or ring + disc (met, positive); never a word. */
export function AlertIcon({ state, title, className = "" }: AlertIconProps) {
  const label =
    title ?? (state === "met" ? S.alertMet : state === "near" ? S.alertNear : S.alertWaiting);
  return (
    <i
      role="img"
      aria-label={label}
      title={title}
      className={`relative inline-block size-2.5 flex-none rounded-full border-[1.5px] border-current align-[-1px] not-italic after:absolute after:top-1/2 after:left-1/2 after:-translate-1/2 after:rounded-full after:bg-current after:content-[''] ${aiState[state]} ${className}`}
    />
  );
}

const statusDot: Record<string, string> = {
  active: "bg-positive",
  trig: "bg-negative",
  snz: "bg-warning",
  mute: "bg-fg-muted",
};

/** Old `.status`: a 7px dot in the status colour and the status word (alerts manager, asset page). */
export function AlertStatus({ status }: { status: string }) {
  const [label, cls] = (ALERT_STATUS as Record<string, [string, string] | undefined>)[status] ?? [
    status,
    "mute",
  ];
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs">
      <i aria-hidden="true" className={`inline-block size-1.75 rounded-full ${statusDot[cls]}`} />
      {label}
    </span>
  );
}

const poltDot: Record<string, string> = {
  positive: "bg-positive",
  negative: "bg-negative",
  neutral: "bg-fg-muted",
};

/** Old `.polt`: "● szansa" in the polarity colour (alerts table, histories). */
export function PolarityText({ polarity }: { polarity: string }) {
  const p = polarity === "positive" || polarity === "negative" ? polarity : "neutral";
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs-plus">
      <i aria-hidden="true" className={`inline-block size-2 rounded-full ${poltDot[p]}`} />
      {POLARITY[p]}
    </span>
  );
}
