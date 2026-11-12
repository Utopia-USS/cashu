// A list row inside a phone tile (design/mobile/companion prototype `.row`, visual.md "List rows"): name and
// value on the first line, two captions on the second, hairline separated, never boxed. A pressable row
// grows a full-bleed press fill. `DateLead` is the date column of a transaction row.
import type { IsoDate } from "@cashu/domain";
import { formatCalendarDate, formatCalendarDay } from "@cashu/i18n/values";
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { useUiEnv } from "../environment/UiEnv.js";

export interface ListRowProps {
  /** Left of the text: a `DateLead`, a `Swatch`, an icon. */
  lead?: ReactNode;
  name: string;
  /** Right on the first line: usually a value component (`Money`, `Percent`). */
  value?: ReactNode;
  /** Second line, left. */
  sub?: ReactNode;
  /** Second line, right. */
  sub2?: ReactNode;
  /** A row that matters less (a paid bill, a hidden category): drawn faded. */
  dim?: boolean;
  /** The first row of a tile has no hairline above it. */
  first?: boolean;
  onPress?(): void;
  /** Accessible name of a pressable row when its name does not say where it leads. */
  accessibilityLabel?: string;
}

/** A string becomes a text in the given look; any other node (a value component) renders as is. */
function text(node: ReactNode, className: string, lines = 1) {
  return typeof node === "string" || typeof node === "number" ? (
    <Text numberOfLines={lines} className={className}>
      {node}
    </Text>
  ) : (
    node
  );
}

/** One row: lead, then name / value over sub / sub2. */
export function ListRow({
  lead,
  name,
  value,
  sub,
  sub2,
  dim,
  first,
  onPress,
  accessibilityLabel,
}: ListRowProps) {
  const content = (
    <>
      {lead}
      <View className="min-w-0 flex-1 gap-0.5">
        <View className="flex-row items-center justify-between gap-3">
          <Text numberOfLines={1} className="shrink text-body font-demi text-fg">
            {name}
          </Text>
          {text(value, "text-body font-heavy text-fg tabular-nums")}
        </View>
        {(sub != null || sub2 != null) && (
          <View className="flex-row items-center justify-between gap-3">
            {text(sub, "shrink text-caption text-fg-muted", 2)}
            {text(sub2, "text-caption text-fg-muted tabular-nums")}
          </View>
        )}
      </View>
    </>
  );
  const look = `flex-row items-center gap-3 py-2.5 ${first ? "" : "border-t border-border"} ${dim ? "opacity-60" : ""}`;
  if (onPress)
    return (
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        className={`${look} -mx-2.5 rounded-button-lg px-2.5 active:bg-subtle`}
      >
        {content}
      </Pressable>
    );
  return <View className={look}>{content}</View>;
}

export interface DateLeadProps {
  date: IsoDate;
}

/** The date column of a transaction row: the day number over the short weekday, on its ISO day; a screen
 * reader hears the whole date. */
export function DateLead({ date }: DateLeadProps) {
  const { locale } = useUiEnv();
  const { day, weekday } = formatCalendarDay(date, locale);
  return (
    <View
      accessible
      accessibilityLabel={formatCalendarDate(date, locale, "long")}
      className="w-9 items-center"
    >
      <Text className="text-title font-heavy text-fg tabular-nums">{day}</Text>
      <Text className="text-caption text-fg-muted">{weekday}</Text>
    </View>
  );
}
