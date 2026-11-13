// The root's full-screen state while "Remove this phone" runs (the app's tree is unmounted meanwhile),
// and the fatal state when the copy could not be removed and rebuilt safely: only a restart helps then.
// Rendered above the services, so plain views and tokens only (no store, no privacy environment).
import { Text, View } from "react-native";
import { S } from "./Shell.strings";
import { S as W } from "./Wipe.strings";

export interface WipeStateViewProps {
  phase: "wiping" | "failed";
}

export function WipeStateView({ phase }: WipeStateViewProps) {
  return (
    <View testID="wipe-state" className="flex-1 items-center justify-center gap-3 bg-surface px-4">
      <Text role="heading" className="text-title text-fg">
        {S.appName}
      </Text>
      <Text
        accessibilityLiveRegion="polite"
        className={`text-center text-body ${phase === "failed" ? "text-negative" : "text-fg-muted"}`}
      >
        {phase === "failed" ? W.failed : W.wiping}
      </Text>
    </View>
  );
}
