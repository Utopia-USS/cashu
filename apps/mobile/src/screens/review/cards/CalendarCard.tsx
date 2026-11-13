// The calendar card: the coming dates that touch the portfolio (only when the review has a calendar).
import { DateText, ListRow } from "@cashu/ui/native";
import { View } from "react-native";
import type { CalendarCard as CalendarModel } from "../useReviewDeck";

export function CalendarCard({ body }: { body: CalendarModel }) {
  return (
    <View>
      {body.rows.map((row, index) => (
        <ListRow
          key={row.key}
          first={index === 0}
          name={row.title}
          value={<DateText value={row.date} dateStyle="medium" tone="muted" />}
        />
      ))}
    </View>
  );
}
