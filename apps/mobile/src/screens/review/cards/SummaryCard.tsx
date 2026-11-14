// The summary after the last card: cards clear, the flagged cards that wait on the Mac, each decision
// (or "no decision yet") and what was skipped this week.
import { Icon } from "@cashu/ui/native";
import { Text, View } from "react-native";
import { S } from "../Review.strings";
import type { SummaryModel } from "../useReviewDeck";
import { CardShell } from "./CardShell";

function Line({
  icon,
  tone,
  text,
}: {
  icon: "check" | "bell" | "doc";
  tone: string;
  text: string;
}) {
  return (
    <View className="flex-row items-start gap-2">
      <Icon name={icon} size={16} className={tone} />
      <Text className="shrink text-body text-fg">{text}</Text>
    </View>
  );
}

export function SummaryCard({ summary }: { summary: SummaryModel }) {
  return (
    <CardShell eyebrow={S.eyebrowSummary} title={summary.title}>
      <View className="gap-2">
        <Line icon="check" tone="text-positive" text={S.cardsClear(summary.clear)} />
        {summary.waiting !== null && (
          <Line icon="bell" tone="text-warning" text={summary.waiting} />
        )}
        {summary.decisions.map((d) => (
          <Line
            key={d.title}
            icon="doc"
            tone="text-accent"
            text={S.decisionLine(d.title, d.choice)}
          />
        ))}
        {summary.skipped !== null && (
          <Text className="pt-1 text-caption text-fg-muted">{summary.skipped}</Text>
        )}
      </View>
    </CardShell>
  );
}
