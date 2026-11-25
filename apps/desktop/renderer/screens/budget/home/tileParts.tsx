// Small parts the budget screen's tiles share: the tile entrance wrapper, the row entrance and the quiet text
// action. Pure.
import type { CSSProperties, ReactNode } from "react";
import type { OtherSurplusState } from "./budgetHomeState.js";

const CHEVRON = "›";

/** A tile's place in the entrance order (50ms apart). */
export function Rise({ i, children }: { i: number; children: ReactNode }) {
  return (
    <div
      className="tile-enter flex min-w-0 flex-col [&>*]:flex-1"
      style={{ "--tile-i": i } as CSSProperties}
    >
      {children}
    </div>
  );
}

/** A row that rises in after the tile (30ms apart). */
export const rowIn = "motion-safe:animate-[toast-in_0.42s_var(--ease-tile)_backwards]";
export const rowDelay = (k: number): CSSProperties => ({ animationDelay: `${200 + k * 30}ms` });

/** The quiet text action of the tiles ("Pokaż wszystkie 23"). */
export function QuietLink({
  children,
  onPress,
  title,
  expanded,
}: {
  children: ReactNode;
  onPress(): void;
  title?: string | undefined;
  expanded?: boolean | undefined;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-expanded={expanded}
      onClick={onPress}
      className="inline-flex cursor-pointer items-center gap-1 border-0 bg-transparent p-0 text-xs text-fg-muted transition-colors hover:text-fg"
    >
      {children}
    </button>
  );
}

/** "Też w EUR: +12,40 €": another currency's surplus in the same period; pressing shows the budget in it. */
export function OtherSurplusLink({ other }: { other: OtherSurplusState }) {
  return (
    <QuietLink title={other.title} onPress={other.onPress}>
      {other.lead}
      <b className="ml-1 font-strong text-fg-secondary tabular-nums">{other.value}</b>
      <span aria-hidden>{CHEVRON}</span>
    </QuietLink>
  );
}
