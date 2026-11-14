// Pure Activity tab (prototype `activity` and `search`): the tab header with the add-cash plus, the
// search field, the filter chips with the account picker, and the day list; while searching, the payee
// summary and the hit count lead and the hits follow by day. One FlashList of day headers and rows.

import {
  Button,
  Delta,
  EmptyState,
  Icon,
  ListRow,
  Money as MoneyValue,
  SearchField,
  Swatch,
  Tag,
  Tile,
} from "@cashu/ui/native";
import { FlashList } from "@shopify/flash-list";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { TabHeader } from "../../shell/TabHeader";
import { AccountPicker } from "../controls/AccountPicker";
import { S } from "./Activity.strings";
import type { ActivityDay, ActivityRow, ActivityState } from "./useActivityScreen";

export type ActivityViewProps = ActivityState;

type Item =
  | { type: "day"; key: string; day: ActivityDay }
  | { type: "row"; key: string; row: ActivityRow; first: boolean; last: boolean };

/** The days flattened into one list: a header per day, then its rows (first and last close the card). */
function itemsOf(days: readonly ActivityDay[]): Item[] {
  return days.flatMap((day): Item[] => [
    { type: "day", key: `day:${day.date}`, day },
    ...day.rows.map(
      (row, i): Item => ({
        type: "row",
        key: row.gid,
        row,
        first: i === 0,
        last: i === day.rows.length - 1,
      }),
    ),
  ]);
}

function Chips(props: ActivityViewProps) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      accessibilityLabel={S.filters}
      contentContainerClassName="gap-2 px-4"
    >
      {props.chips.map((chip) => (
        <Pressable
          key={chip.key}
          accessibilityRole="button"
          accessibilityState={{ selected: chip.active }}
          onPress={() => props.onFilterPicked(chip.key)}
          className={`h-8 flex-row items-center gap-1.5 rounded-full px-3 active:opacity-70 ${chip.active ? "bg-fg" : "bg-chip"}`}
        >
          <Text
            className={`text-sm-plus font-demi ${chip.active ? "text-surface" : "text-fg-secondary"}`}
          >
            {chip.label}
          </Text>
          {chip.count !== undefined && (
            <View className="h-5 min-w-5 items-center justify-center rounded-full bg-warning-bg px-1.5">
              <Text className="text-caption font-strong text-warning tabular-nums">
                {chip.count}
              </Text>
            </View>
          )}
        </Pressable>
      ))}
      <AccountPicker {...props.account} />
    </ScrollView>
  );
}

function Summary({ results }: { results: NonNullable<ActivityViewProps["results"]> }) {
  const summary = results.summary;
  return (
    <View className="gap-3 px-4">
      {summary !== null && (
        <Tile title={summary.payee} meta={summary.countLabel}>
          {summary.rows.map((row, i) => (
            <ListRow
              key={row.key}
              first={i === 0}
              name={row.year}
              value={<MoneyValue value={row.amount} weight="strong" />}
              sub={row.dateLabel}
              {...(row.vsPrevious === null ? {} : { sub2: row.vsPrevious })}
            />
          ))}
        </Tile>
      )}
      <View className="flex-row items-center justify-between gap-2 px-1">
        <Text className="text-caption font-demi text-fg-secondary">{results.countLabel}</Text>
        <Text className="shrink text-caption text-fg-muted">{S.allHistoryOnPhone}</Text>
      </View>
    </View>
  );
}

function Header(props: ActivityViewProps) {
  return (
    <View className="gap-3 pb-1">
      <TabHeader
        {...props.header}
        title={S.title}
        {...(props.canAddCash
          ? {
              right: (
                <Button variant="glyph" label={S.addCash} onPress={props.onCashPressed}>
                  <Icon name="plus" size={20} />
                </Button>
              ),
            }
          : {})}
      />
      <View className="px-4">
        <SearchField
          value={props.search.value}
          placeholder={S.searchPlaceholder}
          clearLabel={S.clearSearch}
          onChange={props.search.onChange}
          onClear={props.search.onClear}
        />
      </View>
      {props.mode === "browse" && <Chips {...props} />}
      {props.mode === "browse" && props.categoryFilter !== null && (
        <View className="flex-row items-center gap-1 px-4">
          <Tag tone="info">{props.categoryFilter.label}</Tag>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={S.clearCategory(props.categoryFilter.label)}
            hitSlop={14}
            onPress={props.categoryFilter.onClear}
            className="size-6 items-center justify-center rounded-full active:opacity-70"
          >
            <Icon name="x" className="text-fg-muted" />
          </Pressable>
        </View>
      )}
      {props.results !== null && <Summary results={props.results} />}
    </View>
  );
}

function DayHeader({ day }: { day: ActivityDay }) {
  return (
    <View className="flex-row items-center justify-between gap-2 px-5 pt-4 pb-2">
      <Text role="heading" className="text-caption font-demi text-fg-secondary">
        {day.label}
      </Text>
      {day.spent !== null && (
        <Text className="text-caption text-fg-muted">
          {S.spent} <MoneyValue value={day.spent} size="caption" tone="muted" />
        </Text>
      )}
    </View>
  );
}

function RowSub({ sub }: { sub: ActivityRow["sub"] }) {
  switch (sub.kind) {
    case "uncategorized":
      return <Tag tone="warning">{S.toCategorizeTag}</Tag>;
    case "internal":
      return (
        <View className="shrink flex-row items-center gap-1.5">
          <Swatch color="fg-muted" />
          <Text numberOfLines={1} className="shrink text-caption text-fg-muted">
            {S.betweenAccounts}
          </Text>
        </View>
      );
    case "category":
      return (
        <View className="shrink flex-row items-center gap-1.5">
          <Swatch color={sub.swatch} />
          <Text numberOfLines={1} className="shrink text-caption text-fg-muted">
            {`${sub.label} · ${sub.account}`}
          </Text>
        </View>
      );
    case "account":
      return sub.account;
  }
}

function Row({ item, onPress }: { item: Extract<Item, { type: "row" }>; onPress(): void }) {
  const { row } = item;
  return (
    <View
      className={`mx-4 bg-surface-raised px-4 ${item.first ? "rounded-t-2xl pt-1" : ""} ${item.last ? "rounded-b-2xl pb-1" : ""}`}
    >
      <ListRow
        first={item.first}
        name={row.payee}
        value={
          row.income ? (
            <Delta kind="money" value={row.amount} weight="strong" />
          ) : (
            <MoneyValue value={row.amount} weight="strong" />
          )
        }
        sub={<RowSub sub={row.sub} />}
        {...(row.cash ? { sub2: S.cashTag } : {})}
        dim={row.dim}
        onPress={onPress}
      />
    </View>
  );
}

export function ActivityView(props: ActivityViewProps) {
  return (
    <FlashList
      className="flex-1 bg-surface"
      data={itemsOf(props.days)}
      keyExtractor={(item) => item.key}
      getItemType={(item) => item.type}
      ListHeaderComponent={<Header {...props} />}
      renderItem={({ item }) =>
        item.type === "day" ? (
          <DayHeader day={item.day} />
        ) : (
          <Row item={item} onPress={() => props.onRowPressed(item.row.gid)} />
        )
      }
      onEndReached={props.onEndReached}
      ListEmptyComponent={props.empty === null ? null : <EmptyState title={props.empty} />}
      ListFooterComponent={
        <View className="items-center px-4 pt-4 pb-10">
          {props.isLoadingMore ? (
            <ActivityIndicator />
          ) : (
            props.footer !== null && (
              <Text className="text-center text-caption text-fg-muted">{props.footer}</Text>
            )
          )}
        </View>
      }
    />
  );
}
