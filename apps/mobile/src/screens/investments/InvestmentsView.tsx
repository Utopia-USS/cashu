// Pure Investments tab shell (prototype `portfolio / signals / strategy`): the tab header, the weekly
// review slot (the big button on top), the full-width top tabs with the count of signals waiting for a
// decision, then the current view's section.
import { Button, Icon, Seg, Tile } from "@cashu/ui/native";
import { ScrollView, Text, View } from "react-native";
import { TabHeader } from "../../shell/TabHeader";
import { S } from "./Investments.strings";
import type {
  InvestmentsViewName,
  InvestmentsViewProps,
  ReviewSlot,
} from "./investments-contracts";

function Review({
  slot,
  onPressed,
  onUndo,
}: {
  slot: ReviewSlot;
  onPressed: () => void;
  onUndo: () => unknown;
}) {
  if (slot.kind === "done")
    return (
      <Tile>
        <View className="flex-row items-center gap-3">
          <View className="size-9 items-center justify-center rounded-full bg-positive-bg">
            <Icon name="check" size={16} className="text-positive" />
          </View>
          <View className="min-w-0 flex-1 gap-0.5">
            <Text className="text-body font-demi text-fg">{S.reviewDone}</Text>
            <Text className="text-caption text-fg-muted">{slot.sub}</Text>
          </View>
          {slot.canUndo && (
            <Button variant="link" label={S.undoReview} onPress={onUndo}>
              {S.undo}
            </Button>
          )}
        </View>
      </Tile>
    );
  return (
    <Tile>
      <View className="flex-row items-center gap-3">
        <View className="size-11.5 items-center justify-center rounded-tile bg-accent-muted">
          <Icon name="calendar" size={24} className="text-accent" />
        </View>
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="text-title font-heavy text-fg">{slot.title}</Text>
          <Text className="text-caption text-fg-muted">{slot.meta}</Text>
        </View>
      </View>
      {slot.teaser !== null && (
        <Text className="mt-3 text-body text-fg-secondary">{slot.teaser}</Text>
      )}
      <View className="mt-4">
        <Button variant="primary" size="lg" block onPress={onPressed}>
          {S.startReview}
        </Button>
      </View>
    </Tile>
  );
}

export function InvestmentsView(props: InvestmentsViewProps) {
  const items: [string, InvestmentsViewName][] = [
    [S.portfolio, "portfolio"],
    [props.signalsCount > 0 ? `${S.signals} · ${props.signalsCount}` : S.signals, "signals"],
    [S.strategy, "strategy"],
  ];
  return (
    <ScrollView className="flex-1 bg-surface">
      <TabHeader {...props.header} title={S.title} />
      <View className="gap-3 px-4 pb-4">
        {props.review !== null && (
          <Review
            slot={props.review}
            onPressed={props.onReviewPressed}
            onUndo={props.onReviewUndo}
          />
        )}
        <Seg items={items} value={props.view} onChange={props.onViewChanged} full label={S.views} />
        {props.children}
      </View>
    </ScrollView>
  );
}
