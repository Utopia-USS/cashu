import { Button } from "./Button.js";

const PREV = "‹";
const NEXT = "›";

export interface PeriodStepperProps {
  /** The shown period ("lis 2026", "Q4 2026", "2026"). */
  label: string;
  onStep(delta: -1 | 1): void;
  /** Arrows kept in the layout but invisible (old `visibility: hidden` for "Wszystko"). */
  hidden?: boolean;
  prevDisabled?: boolean;
  nextDisabled?: boolean;
  /** Accessible names of the arrows (old month close: "Poprzedni miesiąc" / "Następny miesiąc"). */
  prevLabel?: string;
  nextLabel?: string;
}

/** `‹ label ›` period navigation of the budget cards (old inline-flex, 2px gaps: `.btn` arrows around a 96px
 * centred 13px 550 label). */
export function PeriodStepper({
  label,
  onStep,
  hidden,
  prevDisabled,
  nextDisabled,
  prevLabel,
  nextLabel,
}: PeriodStepperProps) {
  const arrow = hidden ? "invisible" : "";
  return (
    <span className="inline-flex items-center gap-0.5">
      <Button
        className={arrow}
        disabled={prevDisabled}
        onPress={() => onStep(-1)}
        {...(prevLabel ? { label: prevLabel } : {})}
      >
        {PREV}
      </Button>
      <span className="min-w-24 text-center text-sm font-demi">{label}</span>
      <Button
        className={arrow}
        disabled={nextDisabled}
        onPress={() => onStep(1)}
        {...(nextLabel ? { label: nextLabel } : {})}
      >
        {NEXT}
      </Button>
    </span>
  );
}
