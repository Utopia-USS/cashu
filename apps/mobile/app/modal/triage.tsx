// The categorize deck: a full-screen modal over the tabs, closed with its X. From Today it is scoped to
// what Today's line counts (`/modal/triage?month=YYYY-MM&currency=PLN`); from Activity it holds every
// uncategorized payment of the vault.
import { lang } from "@cashu/i18n";
import { PinnedProfile } from "@cashu/store-react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { usePinnedVault } from "../../src/screens/profile/switchProfile";
import { TriageView } from "../../src/screens/triage/TriageView";
import { useTriageScreen } from "../../src/screens/triage/useTriageScreen";
import { useNow } from "../../src/shell/useNow";

export { ErrorBoundary } from "expo-router";

export default function TriageRoute() {
  // Pinned to the profile it opened with: nothing renders once the current profile is another one, and
  // everything under it reads that profile (`PinnedProfile`), never a later one.
  const vault = usePinnedVault();
  return vault === null ? null : (
    <PinnedProfile vault={vault}>
      <Triage vault={vault} />
    </PinnedProfile>
  );
}

function Triage({ vault }: { vault: string }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { today } = useNow();
  const { month, currency } = useLocalSearchParams<{ month?: string; currency?: string }>();
  const scope = month && /^\d{4}-\d{2}$/u.test(month) && currency ? { month, currency } : null;
  const props = useTriageScreen({ vault, lang: lang(), today, scope, close: () => router.back() });
  return (
    <View
      className="flex-1 bg-surface"
      style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
    >
      <TriageView {...props} />
    </View>
  );
}
