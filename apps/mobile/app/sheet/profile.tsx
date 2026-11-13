// The profile sheet (formSheet from the profile pill of every tab header).
import { useRouter } from "expo-router";
import { expoScheduler } from "../../src/platform/notifications";
import { ProfileSheetView } from "../../src/screens/profile/ProfileSheetView";
import { useProfileSheet } from "../../src/screens/profile/useProfileSheet";
import { wipeThisPhone } from "../../src/services/services";

export { ErrorBoundary } from "expo-router";

export default function ProfileSheetRoute() {
  const router = useRouter();
  const props = useProfileSheet({
    close: () => router.back(),
    openNotifications: () => {
      router.back();
      router.push("/(tabs)/today/notifications");
    },
    notificationPermission: expoScheduler.permission,
    openDiagnostics: () => {
      router.back();
      router.push("/debug");
    },
    openBench: () => {
      router.back();
      router.push("/bench");
    },
    // No navigation before or after it. The wipe unmounts the app's tree with the root stack (the native
    // stack dismisses the sheet as it goes) and the rebuilt app remounts at the index, which goes to Today.
    // A `router.back()` here would only be queued: expo-router dispatches it after the next commit, which
    // is the one that unmounted the stack, so no navigator would be left to handle it. It rejects (and
    // the sheet's hook alerts "Could not delete everything") only when the rebuilt app is shown although a
    // step failed; a wipe that ends in the root's fatal state resolves, since that screen already says so.
    removePhone: wipeThisPhone,
  });
  return <ProfileSheetView {...props} />;
}
