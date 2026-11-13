// The lock screen over the whole app while the app lock is locked (prototype: the app name, the current
// profile's avatar without its name, one full-width Unlock button). The app underneath stays mounted;
// this view is modal for VoiceOver. A failed or impossible check says so above the button.
import { Button, NoteLine } from "@cashu/ui/native";
import { Text, View } from "react-native";
import { S as L } from "./Lock.strings";
import { ProfileAvatar } from "./ProfileAvatar";
import { S } from "./Shell.strings";

export interface LockScreenViewProps {
  /** The current profile's initial (null before a profile is known). */
  initial: string | null;
  /** Why the last check did not unlock; null after a cancel or before any check. */
  failure: "failed" | "unavailable" | null;
  /** Prompts Face ID / Touch ID / the passcode; the button is busy until it settles. */
  onUnlock(): Promise<void>;
}

export function LockScreenView({ initial, failure, onUnlock }: LockScreenViewProps) {
  return (
    <View
      testID="lock-screen"
      accessibilityViewIsModal
      className="absolute inset-0 justify-between bg-surface px-4 pt-24 pb-12"
    >
      <View className="items-center gap-4">
        {initial !== null && <ProfileAvatar initial={initial} />}
        <Text role="heading" className="text-title text-fg">
          {S.appName}
        </Text>
      </View>
      <View className="gap-3">
        {failure !== null && (
          <NoteLine icon="shield">{failure === "failed" ? L.failed : L.unavailable}</NoteLine>
        )}
        <Button variant="primary" block onPress={onUnlock}>
          {L.unlock}
        </Button>
      </View>
    </View>
  );
}
