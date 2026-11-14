// The pairing modal: full screen, no swipe-down (a cancel goes through the flow, which closes the link
// and keeps nothing). Opened from the profile sheet ("Pair another profile") and by the shell on first
// run; presented again by the shell after the services reopened over the new vault (role, first sync).
import { profileIdentity } from "@cashu/store/core/profile";
import { Stack, useRouter } from "expo-router";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { defaultDeviceName } from "../../src/platform/deviceName";
import { PairView } from "../../src/screens/pair/PairView";
import { pairingPorts } from "../../src/screens/pair/pairingPorts";
import { usePairScreen } from "../../src/screens/pair/usePairScreen";
import { useServices } from "../../src/services/ServicesProvider";
import { setPairedVaultRole } from "../../src/services/services";

export { ErrorBoundary } from "expo-router";

export default function PairRoute() {
  const router = useRouter();
  const services = useServices();
  const insets = useSafeAreaInsets();
  const props = usePairScreen({
    defaultName: defaultDeviceName(),
    ports: () => pairingPorts(services),
    close: () => {
      if (router.canGoBack()) router.back();
      else router.replace("/(tabs)/today");
    },
    saveRole: setPairedVaultRole,
    profileName: (vault) => {
      const store = services.vaults.get(vault)?.store;
      if (store === undefined) return null;
      return profileIdentity.run(store.read.bind(store), undefined)?.name ?? null;
    },
  });
  return (
    <View
      className="flex-1 bg-surface"
      style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
    >
      <Stack.Screen
        options={{ presentation: "fullScreenModal", headerShown: false, gestureEnabled: false }}
      />
      <PairView {...props} />
    </View>
  );
}
