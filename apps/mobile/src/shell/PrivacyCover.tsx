// The app-switcher cover: while the app is not active (inactive while the switcher opens, background),
// an opaque surface with the app name hides every amount from the switcher's snapshot. No blur.
// It sits above every sheet and modal (`AboveAll`). Not while the app itself asks for a permission: the
// system prompt makes it inactive too, and the screen behind the prompt must stay (`systemPrompt`).
import { useSyncExternalStore } from "react";
import { AppState, Text, View } from "react-native";
import { AboveAll } from "./AboveAll";
import { S } from "./Shell.strings";
import { coversApp, systemPrompt } from "./systemPrompt";

const subscribe = (onChange: () => void) => {
  const subscription = AppState.addEventListener("change", onChange);
  return () => subscription.remove();
};
const snapshot = () => AppState.currentState;

export function PrivacyCover() {
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  const prompt = useSyncExternalStore(
    systemPrompt.subscribe,
    systemPrompt.expected,
    systemPrompt.expected,
  );
  if (!coversApp(state, prompt)) return null;
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
