import { D } from "@cashu/domain";
import { Amount, Percent } from "@cashu/ui";
import type { researchValuationFacts } from "./presentation.js";
import { S } from "./Research.strings.js";

type Facts = ReturnType<typeof researchValuationFacts>;

/** Render only figures present in the latest sourced topic valuation note. */
export function ResearchValuationFacts({ facts }: { facts: Facts }) {
  if (
    facts.pe === null &&
    facts.forwardPe === null &&
    facts.epsGrowth === null &&
    facts.peAverage5y === null &&
    !facts.basis
  )
    return null;
  return (
    <span className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-text-muted">
      {facts.pe !== null && (
        <span className="flex gap-1">
          {S.pe}: <Amount value={D(String(facts.pe))} fractionDigits={1} />
        </span>
      )}
      {facts.forwardPe !== null && (
        <span className="flex gap-1">
          {S.forwardPe}: <Amount value={D(String(facts.forwardPe))} fractionDigits={1} />
        </span>
      )}
      {facts.epsGrowth !== null && (
        <span className="flex gap-1">
          {S.epsGrowth}: <Percent value={D(String(facts.epsGrowth))} />
        </span>
      )}
      {facts.peAverage5y !== null && (
        <span className="flex gap-1">
          {S.peAverage5y}: <Amount value={D(String(facts.peAverage5y))} fractionDigits={1} />
        </span>
      )}
      {facts.basis && <span>{facts.basis}</span>}
    </span>
  );
}
