// Spending, pushed from Today (`/today/spending?month=YYYY-MM`). A category opens Activity filtered to it.
import { useLocalSearchParams, useRouter } from "expo-router";
import { SpendingView } from "../../../src/screens/spending/SpendingView";
import { useSpendingScreen } from "../../../src/screens/spending/useSpendingScreen";
import { useNow } from "../../../src/shell/useNow";

export { ErrorBoundary } from "expo-router";

export default function SpendingRoute() {
  const router = useRouter();
  const { month } = useLocalSearchParams<{ month?: string }>();
  const { today } = useNow();
  const props = useSpendingScreen({
    today,
    month: month ?? null,
    onCategoryPicked: (category) =>
      router.navigate({ pathname: "/(tabs)/activity", params: { category } }),
    onMonthClosePressed: (closed) =>
      router.push({ pathname: "/(tabs)/today/closed", params: { month: closed } }),
  });
  return <SpendingView {...props} />;
}
