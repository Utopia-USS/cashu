// The ideas card: the research candidates outside the portfolio, each with Watch (only when its
// instrument is in this vault, else a note that it is watched from the Mac) and Not interested; a
// watched or dismissed idea shows its state instead of the buttons.
import { Button, Tag } from "@cashu/ui/native";
import { Text, View } from "react-native";
import { S } from "../Review.strings";
import type { IdeasCard as IdeasModel } from "../useReviewDeck";

export function IdeasCard({ body }: { body: IdeasModel }) {
  return (
    <View className="gap-4">
      {body.rows.map((row) => (
        <View key={row.id} className="gap-2">
          {body.rows.length > 1 && (
            <Text className="text-body font-strong text-fg">{row.title}</Text>
          )}
          <Text numberOfLines={6} className="text-body text-fg-secondary">
            {row.body}
          </Text>
          {row.state === "open" ? (
            <View className="flex-row flex-wrap items-center gap-2">
              {row.canWatch ? (
                <Button variant="secondary" size="sm" onPress={row.onWatch}>
                  {S.watch}
                </Button>
              ) : (
                <Text className="text-caption text-fg-muted">{S.watchOnMac}</Text>
              )}
              <Button variant="ghost" size="sm" onPress={row.onDismiss}>
                {S.notInterested}
              </Button>
            </View>
          ) : (
            <View className="flex-row">
              <Tag tone={row.state === "watching" ? "positive" : "neutral"}>
                {row.state === "watching" ? S.watching : S.dismissed}
              </Tag>
            </View>
          )}
        </View>
      ))}
      {body.error !== null && (
        <Text accessibilityLiveRegion="polite" className="text-caption text-negative">
          {body.error}
        </Text>
      )}
    </View>
  );
}
