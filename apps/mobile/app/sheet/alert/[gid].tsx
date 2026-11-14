// The alert sheet (formSheet from Today's "worth a look", the Signals view and the position page,
// `/sheet/alert/<signal gid>`).
import { lang } from "@cashu/i18n";
import { useLocalSearchParams, useRouter } from "expo-router";
import { AlertSheetView } from "../../../src/screens/alert/AlertSheetView";
import { useAlertSheet } from "../../../src/screens/alert/useAlertSheet";
import { usePinnedVault } from "../../../src/screens/profile/switchProfile";
import { useNow } from "../../../src/shell/useNow";

export { ErrorBoundary } from "expo-router";

export default function AlertSheetRoute() {
  // Pinned to the profile it opened with: nothing renders once the current profile is another one.
  const vault = usePinnedVault();
  return vault === null ? null : <AlertSheet vault={vault} />;
}

function AlertSheet({ vault }: { vault: string }) {
  const router = useRouter();
  const { gid } = useLocalSearchParams<{ gid: string }>();
  const { today, now } = useNow();
  const props = useAlertSheet({ vault, gid, lang: lang(), today, now, close: () => router.back() });
  return <AlertSheetView {...props} />;
}
