// The Today tab root: the running month (or, in its first days, the month just closed). The day and
// the moment come from the shell's `useNow` (they move on at midnight and on return to the app);
// navigation to triage (scoped to the month and currency Today counts), Spending, a closed month and
// the profile sheet stays here.
import { useRouter } from "expo-router";
import { TodayView } from "../../../src/screens/today/TodayView";
import { useTodayScreen } from "../../../src/screens/today/useTodayScreen";
import { useNow } from "../../../src/shell/useNow";

export { ErrorBoundary } from "expo-router";

export default function TodayRoute() {
  const router = useRouter();
  const { today, now } = useNow();
  const state = useTodayScreen({
    today,
    now,
    openTriage: (scope) => router.push({ pathname: "/modal/triage", params: { ...scope } }),
    openSpending: (month) => router.push({ pathname: "/(tabs)/today/spending", params: { month } }),
    openProfile: () => router.push("/sheet/profile"),
    openClosed: (month) => router.push({ pathname: "/(tabs)/today/closed", params: { month } }),
  });
  return <TodayView state={state} />;
}
