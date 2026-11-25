// The investments header tag mount (old Shell.tsx `HeaderTag` per enabled, not empty module): its own Suspense so
// the header never waits for the portfolio read.
import { Suspense } from "react";
import { InvestmentsHeaderTagView } from "./InvestmentsHeaderTagView.js";
import { useInvestmentsHeaderTag } from "./useInvestmentsHeaderTag.js";

export function InvestmentsHeaderTag({ onOpen }: { onOpen(): void }) {
  return (
    <Suspense fallback={null}>
      <Bound onOpen={onOpen} />
    </Suspense>
  );
}

function Bound({ onOpen }: { onOpen(): void }) {
  return <InvestmentsHeaderTagView state={useInvestmentsHeaderTag(onOpen)} />;
}
