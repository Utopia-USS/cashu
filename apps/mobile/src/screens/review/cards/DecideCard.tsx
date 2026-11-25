// The decide card: each item that waits for the owner, with why and its facts. An item with a lead
// signal takes a decision (Nothing / Buy more / Sell, nothing preselected) and an optional reason; a
// proposal waits on the Mac; a decision already written is locked. A decision never places a trade.
import { NoteLine, Seg, Tag, TextField } from "@cashu/ui/native";
import { Text, View } from "react-native";
import { S } from "../Review.strings";
import type { DecideCard as DecideModel } from "../useReviewDeck";

export function DecideCard({ body }: { body: DecideModel }) {
  const many = body.rows.length > 1;
  return (
    <View className="gap-4">
      {body.rows.map((row) => (
        <View key={row.key} className="gap-2">
          {many && <Text className="text-body font-strong text-fg">{row.title}</Text>}
          <Text className="text-body text-fg-secondary">{row.why}</Text>
          {row.facts.map((fact) => (
            <Text key={fact} className="text-caption text-fg-muted">
              {fact}
            </Text>
          ))}
          {row.mode === "mac" && (
            <View className="flex-row">
              <Tag>{S.waitsOnMac}</Tag>
            </View>
          )}
          {row.mode === "choose" && (
            <>
              <Seg<DecideModel["choices"][number][1] | null>
                full
                label={S.yourDecision}
                items={body.choices}
                value={row.choice}
                disabled={row.saved}
                {...(row.saved ? { title: S.saved } : {})}
                onChange={(value) => {
                  if (value !== null) row.onChoose(value);
                }}
              />
              {!row.saved && (
                <TextField
                  label={S.reason}
                  labelHidden
                  placeholder={S.reason}
                  value={row.reason}
                  onChange={row.onReason}
                  multiline
                  rows={2}
                  maxLength={500}
                />
              )}
            </>
          )}
        </View>
      ))}
      <NoteLine icon="shield">{S.decisionIsANote}</NoteLine>
    </View>
  );
}
