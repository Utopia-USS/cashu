// A closed month, pushed from Spending's "{Month} closed" link (`/today/closed?month=YYYY-MM`): the
// same month-closed content as Today's first days, under a native header back to Spending.
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { MonthClosedView } from "../../../src/screens/monthClosed/MonthClosedView";
import {
  lastClosedMonth,
  useMonthClosedScreen,
} from "../../../src/screens/monthClosed/useMonthClosedScreen";
import { useNow } from "../../../src/shell/useNow";

export { ErrorBoundary } from "expo-router";

export default function MonthClosedRoute() {
  const router = useRouter();
  const { month } = useLocalSearchParams<{ month?: string }>();
  const { today } = useNow();
  const closed = month && /^\d{4}-\d{2}$/u.test(month) ? month : lastClosedMonth(today);
  const screen = useMonthClosedScreen({
    today,
    month: closed,
    chrome: "pushed",
    openProfile: () => router.push("/sheet/profile"),
    onShowRunning: null,
  });
  return (
    <>
      <Stack.Screen options={{ title: screen.view.title }} />
      <MonthClosedView {...screen.view} />
    </>
  );
}
