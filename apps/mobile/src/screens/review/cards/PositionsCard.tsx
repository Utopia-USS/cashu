// The positions card: the week's movers down, then up, each with its week's return.
import { Delta, ListRow } from "@cashu/ui/native";
import { Text, View } from "react-native";
import { S } from "../Review.strings";
import type { PositionsCard as PositionsModel } from "../useReviewDeck";

function Group({ title, rows }: { title: string; rows: PositionsModel["down"] }) {
  if (rows.length === 0) return null;
  return (
    <View>
      <Text className="pb-1 text-caption font-demi text-fg-muted">{title}</Text>
      {rows.map((row, index) => (
        <ListRow
          key={row.id}
          first={index === 0}
          name={row.label}
          value={<Delta kind="percent" value={row.ret} weight="strong" />}
        />
      ))}
    </View>
  );
}

export function PositionsCard({ body }: { body: PositionsModel }) {
  return (
    <View className="gap-3">
      <Group title={S.down} rows={body.down} />
      <Group title={S.up} rows={body.up} />
    </View>
  );
}
