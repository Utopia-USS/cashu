// The overview of an investments-only profile (ab24ab6 core/Overview.tsx -> v2/Overview.tsx MinimalOverview): the
// page box with its toasts (the plan toast and its undo), the hero skeleton while the reads load, then the view.

import { Page, Skeleton, ToastProvider } from "@cashu/ui";
import { Suspense } from "react";
import { S } from "../../Desktop.strings.js";
import { MinimalOverviewView } from "./MinimalOverviewView.js";
import { useMinimalOverview } from "./useMinimalOverview.js";

type Props = Parameters<typeof useMinimalOverview>[0];

export function MinimalOverviewScreen(props: Props) {
  return (
    <ToastProvider>
      <Page width="narrow" label={S.overview}>
        <Suspense fallback={<Skeleton height={92} radius="widget" />}>
          <Bound {...props} />
        </Suspense>
      </Page>
    </ToastProvider>
  );
}

function Bound(props: Props) {
  return <MinimalOverviewView state={useMinimalOverview(props)} />;
}
