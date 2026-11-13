// The weekly review deck: a full-screen modal over the tabs (from the Investments review slot), closed
// with its X (nothing saved) or by the summary's primary (the review saved). `?step=N` opens at card N
// (dev and tests).
import { lang } from "@cashu/i18n";
import { useLocalSearchParams, useRouter } from "expo-router";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ReviewDeckView } from "../../src/screens/review/ReviewDeckView";
import { useReviewDeck } from "../../src/screens/review/useReviewDeck";
import { useNow } from "../../src/shell/useNow";

export { ErrorBoundary } from "expo-router";

export default function ReviewRoute() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { today } = useNow();
  const { step } = useLocalSearchParams<{ step?: string }>();
  const parsed = step !== undefined && /^\d+$/u.test(step) ? Number(step) : null;
  const props = useReviewDeck({ today, lang: lang(), step: parsed, close: () => router.back() });
  return (
    <View
      className="flex-1 bg-surface-sunken"
      style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
    >
      <ReviewDeckView {...props} />
    </View>
  );
}
