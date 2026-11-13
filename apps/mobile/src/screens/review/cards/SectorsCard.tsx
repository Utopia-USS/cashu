// The sectors card: each sector's (and the exchange rates') contribution to the week's result in
// percentage points, with its weight.
import { Delta, ListRow, Percent } from "@cashu/ui/native";
import { Text, View } from "react-native";
import { S } from "../Review.strings";
import type { SectorsCard as SectorsModel } from "../useReviewDeck";

export function SectorsCard({ body }: { body: SectorsModel }) {
  return (
    <View>
      {body.rows.map((row, index) => (
        <ListRow
          key={row.key}
          first={index === 0}
          name={row.label}
          value={<Delta kind="percent" value={row.contribution} weight="strong" />}
          {...(row.weight === null
            ? {}
            : {
                sub: (
                  <View className="flex-row items-center gap-1">
                    <Text className="text-caption text-fg-muted">{S.weight}</Text>
                    <Percent value={row.weight} size="caption" tone="muted" fractionDigits={0} />
                  </View>
                ),
              })}
        />
      ))}
      <Text className="pt-2 text-caption text-fg-muted">{S.contributionHint}</Text>
    </View>
  );
}
