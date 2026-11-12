// The Activity tab root (`/activity?filter=&category=&q=`). The filter, the category from Spending and
// the search text live in the route params; a row opens the payment sheet, the Cash button the cash sheet.
import { useLocalSearchParams, useRouter } from "expo-router";
import { ActivityView } from "../../../src/screens/activity/ActivityView";
import { useActivityScreen } from "../../../src/screens/activity/useActivityScreen";
import { useNow } from "../../../src/shell/useNow";

export { ErrorBoundary } from "expo-router";

export default function ActivityRoute() {
  const router = useRouter();
  const { today } = useNow();
  const params = useLocalSearchParams<{ filter?: string; category?: string; q?: string }>();
  const props = useActivityScreen({
    params,
    today,
    openPayment: (gid) => router.push({ pathname: "/sheet/payment/[gid]", params: { gid } }),
    openCash: () => router.push("/sheet/cash"),
    openProfile: () => router.push("/sheet/profile"),
    setParams: (next) => router.setParams(next),
  });
  return <ActivityView {...props} />;
}
