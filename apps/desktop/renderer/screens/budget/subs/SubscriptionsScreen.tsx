// The Subskrypcje route body; the old SkeletonTable (8 rows) while the query loads.
import { SkeletonTable } from "@cashu/ui";
import { Suspense } from "react";
import { SubscriptionsView } from "./SubscriptionsView.js";
import { useSubscriptionsScreen } from "./useSubscriptionsScreen.js";

function Body() {
  return <SubscriptionsView state={useSubscriptionsScreen()} />;
}

export function SubscriptionsScreen() {
  return (
    <Suspense fallback={<SkeletonTable rows={8} />}>
      <Body />
    </Suspense>
  );
}
