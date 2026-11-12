// The categorize deck: a full-screen modal over the tabs, closed with its X. From Today it is scoped to
// what Today's line counts (`/modal/triage?month=YYYY-MM&currency=PLN`); from Activity it holds every
// uncategorized payment of the vault.
import { lang } from "@cashu/i18n";
import { useLocalSearchParams, useRouter } from "expo-router";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { TriageView } from "../../src/screens/triage/TriageView";
import { useTriageScreen } from "../../src/screens/triage/useTriageScreen";
import { useNow } from "../../src/shell/useNow";

export { ErrorBoundary } from "expo-router";

export default function TriageRoute() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { today } = useNow();
  const { month, currency } = useLocalSearchParams<{ month?: string; currency?: string }>();
  const scope = month && /^\d{4}-\d{2}$/u.test(month) && currency ? { month, currency } : null;
  const props = useTriageScreen({ lang: lang(), today, scope, close: () => router.back() });
  return (
    <View
      className="flex-1 bg-surface"
      style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
    >
      <TriageView {...props} />
    </View>
  );
}
