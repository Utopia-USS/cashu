// The weekly review deck: a full-screen modal over the tabs (from the Investments review slot), closed
// with its X (nothing saved) or by the summary's primary (the review saved). `?step=N` opens at card N
// (dev and tests).
import { lang } from "@cashu/i18n";
import { PinnedProfile } from "@cashu/store-react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { usePinnedVault } from "../../src/screens/profile/switchProfile";
import { ReviewDeckView } from "../../src/screens/review/ReviewDeckView";
import { useReviewDeck } from "../../src/screens/review/useReviewDeck";
import { useNow } from "../../src/shell/useNow";

export { ErrorBoundary } from "expo-router";

export default function ReviewRoute() {
  // Pinned to the profile it opened with: nothing renders once the current profile is another one, and
  // everything under it reads that profile (`PinnedProfile`), never a later one.
  const vault = usePinnedVault();
  return vault === null ? null : (
    <PinnedProfile vault={vault}>
      <ReviewDeck vault={vault} />
    </PinnedProfile>
  );
}

function ReviewDeck({ vault }: { vault: string }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { today } = useNow();
  const { step } = useLocalSearchParams<{ step?: string }>();
  const parsed = step !== undefined && /^\d+$/u.test(step) ? Number(step) : null;
  const props = useReviewDeck({
    vault,
    today,
    lang: lang(),
    step: parsed,
    close: () => router.back(),
  });
  return (
    <View
      className="flex-1 bg-surface-sunken"
      style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
    >
      <ReviewDeckView {...props} />
    </View>
  );
}
