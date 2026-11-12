// The app-switcher cover: while the app is not active (inactive while the switcher opens, background),
// an opaque surface with the app name hides every amount from the switcher's snapshot. No blur.
// Sheets (formSheet) and triage (fullScreenModal) are native view controllers presented above the root
// view, so on iOS the cover lives in `FullWindowOverlay` (its own window above every presentation);
// elsewhere it is an absolute layer over the root.
import type { ReactNode } from "react";
import { useSyncExternalStore } from "react";
import { AppState, Platform, Text, View } from "react-native";
import { FullWindowOverlay } from "react-native-screens";
import { S } from "./Shell.strings";

const subscribe = (onChange: () => void) => {
  const subscription = AppState.addEventListener("change", onChange);
  return () => subscription.remove();
};
const snapshot = () => AppState.currentState;

function Above({ children }: { children: ReactNode }) {
  return Platform.OS === "ios" ? <FullWindowOverlay>{children}</FullWindowOverlay> : children;
}

export function PrivacyCover() {
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  if (state === "active" || state === "unknown") return null;
  return (
    <Above>
      <View
        testID="privacy-cover"
        className="absolute inset-0 items-center justify-center bg-surface"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Text className="text-title text-fg-muted">{S.appName}</Text>
      </View>
    </Above>
  );
}
