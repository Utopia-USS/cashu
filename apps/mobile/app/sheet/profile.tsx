// The profile sheet (formSheet from the profile pill of every tab header).
import { useRouter } from "expo-router";
import { ProfileSheetView } from "../../src/screens/profile/ProfileSheetView";
import { useProfileSheet } from "../../src/screens/profile/useProfileSheet";

export { ErrorBoundary } from "expo-router";

export default function ProfileSheetRoute() {
  const router = useRouter();
  const props = useProfileSheet({
    close: () => router.back(),
    openDiagnostics: () => {
      router.back();
      router.push("/debug");
    },
    openBench: () => {
      router.back();
      router.push("/bench");
    },
  });
  return <ProfileSheetView {...props} />;
}
