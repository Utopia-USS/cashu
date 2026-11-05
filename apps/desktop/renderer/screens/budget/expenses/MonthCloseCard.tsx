// The "Zamknięcie miesiąca" card for the Przepływy tab (contract-E.md). Suspends on its queries: the fallback is
// the old first-load card (a 180px title line and a 54px block).
import { ChartCard, Skeleton } from "@cashu/ui";
import { Suspense } from "react";
import { MonthCloseView } from "./MonthCloseView.js";
import { type MonthCloseOptions, useMonthClose } from "./useMonthClose.js";

export type { MonthCloseOptions } from "./useMonthClose.js";

export function MonthCloseCard(props: MonthCloseOptions) {
  return (
    <Suspense
      fallback={
        <ChartCard>
          <Skeleton width={180} height={14} />
          <div className="h-2.5" />
          <Skeleton height={54} />
        </ChartCard>
      }
    >
      <BoundMonthClose {...props} />
    </Suspense>
  );
}

function BoundMonthClose(props: MonthCloseOptions) {
  return <MonthCloseView state={useMonthClose(props)} />;
}
