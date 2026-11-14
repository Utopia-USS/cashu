// Pure spending screen: the period control, the donut of categories with spending against the usual,
// one row per category (share and, in the month view, against its usual amount) and the note on
// transfers and other currencies. Exact Money rows and the prebuilt chart arrive from the screen hook.

import {
  Button,
  Donut,
  Icon,
  ListRow,
  Money as MoneyValue,
  NoteLine,
  Percent,
  Seg,
  Swatch,
  Tile,
} from "@cashu/ui/native";
import { FlashList } from "@shopify/flash-list";
import { Pressable, Text, View } from "react-native";
import type { SpendingPeriodKind, SpendingRow, SpendingViewProps } from "../money-contracts";
import { S } from "./Spending.strings";

function Stepper(props: SpendingViewProps) {
  return (
    <View className="flex-row items-center justify-between">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={S.previous}
        accessibilityState={{ disabled: props.onPrevious === null }}
        disabled={props.onPrevious === null}
        onPress={() => props.onPrevious?.()}
        className={`size-11 items-center justify-center ${props.onPrevious === null ? "opacity-30" : ""}`}
      >
        <Icon name="chevron-left" size={20} className="text-fg" />
      </Pressable>
      <Text accessibilityLiveRegion="polite" className="text-title font-strong text-fg">
        {props.periodLabel}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={S.next}
        accessibilityState={{ disabled: props.onNext === null }}
        disabled={props.onNext === null}
        onPress={() => props.onNext?.()}
        className={`size-11 items-center justify-center ${props.onNext === null ? "opacity-30" : ""}`}
      >
        <Icon name="chevron-right" size={20} className="text-fg" />
      </Pressable>
    </View>
  );
}

/**
 * Month / Quarter / Year; with more than one currency, a compact currency chip at the row's end (designer
 * #18.6): it shows the current currency and a tap moves to the next one (a profile holds two or three).
 */
function PeriodRow(props: SpendingViewProps) {
  const many = props.currencies.length > 1;
  const period = (
    <Seg<SpendingPeriodKind>
      full={!many}
      label={S.period}
      items={[
        [S.month, "month"],
        [S.quarter, "quarter"],
        [S.year, "year"],
      ]}
      value={props.kind}
      onChange={props.onKindChange}
    />
  );
  if (!many) return period;
  const at = props.currencies.indexOf(props.currency);
  const next = props.currencies[(at + 1) % props.currencies.length] ?? props.currency;
  return (
    <View className="flex-row items-center justify-between gap-2">
      {period}
      <Button
        variant="secondary"
        size="sm"
        className="self-center"
        label={S.currencyChip(props.currency, next)}
        onPress={() => props.onCurrencyChange(next)}
      >
        {props.currency}
      </Button>
    </View>
  );
}

function Header(props: SpendingViewProps) {
  return (
    <View className="gap-3 p-4">
      <PeriodRow {...props} />
      <Stepper {...props} />
      {props.closedMonth !== null && (
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            if (props.closedMonth !== null) props.onMonthClosePressed(props.closedMonth.month);
          }}
          className="flex-row items-center gap-1 self-start py-2"
        >
          <Text className="text-body font-medium text-accent">{props.closedMonth.label}</Text>
          <Icon name="chevron-right" size={16} className="text-accent" />
        </Pressable>
      )}
      <Tile>
        {props.empty ? (
          <Text className="text-body text-fg-secondary">{S.noData}</Text>
        ) : (
          <View className="items-center gap-2">
            <Donut {...props.chart} size={196} thickness={20} />
            {props.vsUsual !== null && (
              <Text
                className={`text-caption font-medium ${props.vsUsual.over ? "text-fg" : "text-positive"}`}
              >
                {S.vsUsual(props.vsUsual.text)}
              </Text>
            )}
          </View>
        )}
      </Tile>
    </View>
  );
}

function Row({ row, first, onPress }: { row: SpendingRow; first: boolean; onPress(): void }) {
  return (
    <View className="mx-4">
      <ListRow
        first={first}
        lead={<Swatch color={row.swatch} />}
        name={row.label}
        value={<MoneyValue value={row.amount} weight="strong" fractionDigits={0} />}
        sub={
          <View className="shrink flex-row items-center gap-1">
            <Percent value={row.share} size="caption" tone="muted" fractionDigits={0} />
            <Text className="text-caption text-fg-muted">{S.ofSpending}</Text>
          </View>
        }
        {...(row.vsUsual === null
          ? {}
          : {
              sub2:
                row.vsUsual.kind === "over" ? (
                  <Text className="text-caption text-negative tabular-nums">
                    {S.vsUsual(row.vsUsual.text)}
                  </Text>
                ) : (
                  S.asUsual
                ),
            })}
        onPress={onPress}
      />
    </View>
  );
}

export function SpendingView(props: SpendingViewProps) {
  return (
    <FlashList
      className="flex-1 bg-surface"
      data={props.rows}
      keyExtractor={(row) => row.key}
      ListHeaderComponent={<Header {...props} />}
      renderItem={({ item, index }) => (
        <Row row={item} first={index === 0} onPress={() => props.onCategoryPicked(item.key)} />
      )}
      ListFooterComponent={
        <View className="p-4">
          <NoteLine icon="sync">
            {S.transfersNote}
            {props.otherCurrencies.length > 0 && ` ${S.showing(props.currency)} `}
            {props.otherCurrencies.map((money, i) => (
              <Text key={money.currency}>
                {i > 0 && ", "}
                <MoneyValue value={money} size="caption" tone="muted" />
              </Text>
            ))}
          </NoteLine>
        </View>
      }
    />
  );
}
