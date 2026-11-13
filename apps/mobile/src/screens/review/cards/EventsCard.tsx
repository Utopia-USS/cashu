// The events card: the week's notes on held instruments with what each does to the thesis, and the
// market risk brief when the research has one.
import { ListRow, Tag } from "@cashu/ui/native";
import { Text, View } from "react-native";
import { S } from "../Review.strings";
import type { EventsCard as EventsModel } from "../useReviewDeck";

export function EventsCard({ body }: { body: EventsModel }) {
  return (
    <View className="gap-3">
      <View>
        {body.rows.map((row, index) => (
          <ListRow
            key={row.id}
            first={index === 0}
            name={row.title}
            {...(row.subject === null ? {} : { sub: row.subject })}
            {...(row.relation === null
              ? {}
              : {
                  sub2: (
                    <Tag tone={row.relation.tone === "neutral" ? "neutral" : row.relation.tone}>
                      {row.relation.text}
                    </Tag>
                  ),
                })}
          />
        ))}
      </View>
      {body.brief !== null && (
        <View className="gap-1 rounded-tile bg-subtle p-3">
          <Text className="text-caption font-demi text-fg-muted">{S.riskBrief}</Text>
          <Text className="text-body text-fg">{body.brief}</Text>
        </View>
      )}
    </View>
  );
}
