// The app-switcher cover: while the app is not active (inactive while the switcher opens, background),
// an opaque surface with the app name hides every amount from the switcher's snapshot. No blur.
// It sits above every sheet and modal (`AboveAll`).
import { useSyncExternalStore } from "react";
import { AppState, Text, View } from "react-native";
import { AboveAll } from "./AboveAll";
import { S } from "./Shell.strings";

const subscribe = (onChange: () => void) => {
  const subscription = AppState.addEventListener("change", onChange);
  return () => subscription.remove();
};
const snapshot = () => AppState.currentState;

export function PrivacyCover() {
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  if (state === "active" || state === "unknown") return null;
  return (
    <AboveAll>
      <View
        testID="privacy-cover"
        className="absolute inset-0 items-center justify-center bg-surface"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Text className="text-title text-fg-muted">{S.appName}</Text>
      </View>
    </AboveAll>
  );
}
