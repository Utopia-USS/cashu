// Sync in a banner slot (Today, the profile sheet): the quiet line, or the notice that asks the owner with
// its buttons ("Remove this copy" is offered, never run by itself). Pure: `useSyncNotice` supplies the slot.
import { Button, Tile } from "@cashu/ui/native";
import { Text, View } from "react-native";
import { S as SyncS } from "./Sync.strings";
import type { SyncSlot } from "./useSyncNotice";

/** Sync in the banner slot: a quiet line, or the notice that asks the owner with its buttons. */
export function SyncSlotView({ slot }: { slot: SyncSlot }) {
  if (slot.notice !== null) {
    return (
      <Tile title={slot.notice.title}>
        <View className="gap-3">
          {slot.notice.body !== null && (
            <Text className="text-body text-fg-secondary">{slot.notice.body}</Text>
          )}
          {slot.notice.failed && (
            <Text accessibilityRole="alert" className="text-caption text-negative">
              {SyncS.couldNotRemove}
            </Text>
          )}
          {slot.notice.actions.map((action) => (
            <Button
              key={action.label}
              variant={action.tone}
              block
              label={action.label}
              onPress={action.onPress}
            >
              {action.label}
            </Button>
          ))}
        </View>
      </Tile>
    );
  }
  if (slot.line === null) return null;
  return (
    <Text
      accessibilityLiveRegion="polite"
      className={`px-1 text-caption ${slot.line.tone === "warning" ? "text-warning" : "text-fg-muted"}`}
    >
      {slot.line.text}
    </Text>
  );
}
