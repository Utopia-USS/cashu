// The alert sheet (formSheet from Today's "worth a look", the Signals view and the position page,
// `/sheet/alert/<signal gid>`).
import { lang } from "@cashu/i18n";
import { useLocalSearchParams, useRouter } from "expo-router";
import { AlertSheetView } from "../../../src/screens/alert/AlertSheetView";
import { useAlertSheet } from "../../../src/screens/alert/useAlertSheet";
import { useNow } from "../../../src/shell/useNow";

export { ErrorBoundary } from "expo-router";

export default function AlertSheetRoute() {
  const router = useRouter();
  const { gid } = useLocalSearchParams<{ gid: string }>();
  const { today, now } = useNow();
  const props = useAlertSheet({ gid, lang: lang(), today, now, close: () => router.back() });
  return <AlertSheetView {...props} />;
}
