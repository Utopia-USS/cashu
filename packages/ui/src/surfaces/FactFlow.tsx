import { Fact, type FactProps } from "./Fact.js";

export interface FlowFact extends FactProps {
  /** Stable key of the step. */
  id: string;
}

export interface FactFlowProps {
  /** Two or more facts, read left to right; an arrow sits between each pair. */
  items: readonly FlowFact[];
  /** Layout only (margin). */
  className?: string;
}

const ARROW = "→";

/** Facts joined by arrows (old `.flow`: centred columns `1fr auto 1fr ...`, gap 8px, muted 16px arrows, fact
 * values 16px), e.g. surplus -> contribution -> what stays. */
export function FactFlow({ items, className = "" }: FactFlowProps) {
  const columns = items.map(() => "minmax(0,1fr)").join(" auto ");
  return (
    <div
      className={`grid items-center gap-2 text-center ${className}`}
      style={{ gridTemplateColumns: columns }}
    >
      {items.map((fact, index) => (
        <FlowStep key={fact.id} fact={fact} arrow={index > 0} />
      ))}
    </div>
  );
}

function FlowStep({ fact, arrow }: { fact: FlowFact; arrow: boolean }) {
  const { id: _id, ...props } = fact;
  return (
    <>
      {arrow && (
        <span aria-hidden="true" className="text-base-plus text-fg-muted">
          {ARROW}
        </span>
      )}
      <Fact {...props} size="md" />
    </>
  );
}
