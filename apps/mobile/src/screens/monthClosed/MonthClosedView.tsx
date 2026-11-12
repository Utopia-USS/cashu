// Pure month-closed View (prototype `close`): the closed month's keep with its KPIs, what the strategy
// says with the plan buttons (or the planned quote and Undo), the plan note and where the month went
// against a usual one. Under Today's tab header in the first days of a month, or pushed from Spending.
import { C } from "@cashu/i18n/core/common.strings";
import {
  Button,
  Figure,
  FreshLine,
  Icon,
  KpiStrip,
  ListRow,
  Money as MoneyValue,
  NoteLine,
  Tile,
  useUiEnv,
} from "@cashu/ui/native";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { TabHeader } from "../../shell/TabHeader";
import { S as Today } from "../today/Today.strings";
import { S } from "./MonthClosed.strings";
import type { MonthClosedStrategy, MonthClosedViewProps } from "./monthClosed-contracts";

function Kept({ hero }: Pick<MonthClosedViewProps, "hero">) {
  const { privacy, bananas } = useUiEnv();
  return (
    <Tile
      title={privacy && bananas ? `${hero.label}${Today.inBananas}` : hero.label}
      {...(hero.savingsRate === null ? {} : { meta: hero.savingsRate })}
    >
      <Figure value={hero.surplus} fractionDigits={0} />
      <KpiStrip
        items={hero.kpis.map((kpi) => ({
          label: kpi.label,
          value:
            typeof kpi.value === "string" ? (
              kpi.value
            ) : (
              <MoneyValue value={kpi.value} size="title" weight="strong" fractionDigits={0} />
            ),
        }))}
      />
    </Tile>
  );
}

function Strategy({ strategy }: { strategy: MonthClosedStrategy }) {
  if (strategy.kind === "off")
    return (
      <Tile title={S.strategySays}>
        <Text className="text-body text-fg-secondary">{S.noInvestingNote}</Text>
      </Tile>
    );
  return (
    <Tile title={S.strategySays}>
      <View className="gap-3">
        {strategy.body !== null && (
          <Text className="text-body text-fg-secondary">{strategy.body}</Text>
        )}
        {strategy.kind === "planned" ? (
          <View className="flex-row items-center gap-2 rounded-button-lg bg-subtle p-3">
            <Icon name="check" className="text-positive" />
            <Text className="shrink text-body text-fg">{strategy.quote}</Text>
            <Button variant="link" onPress={strategy.onUndo} pending={strategy.pending}>
              {C.undo}
            </Button>
          </View>
        ) : (
          strategy.canPlan && (
            <View className="gap-2">
              <View className="flex-row flex-wrap gap-2">
                {strategy.planLabel !== null && (
                  <Button variant="primary" onPress={strategy.onPlan} pending={strategy.pending}>
                    {strategy.planLabel}
                  </Button>
                )}
                {strategy.other === null && (
                  <Button variant="secondary" onPress={strategy.onOther}>
                    {S.otherAmount}
                  </Button>
                )}
              </View>
              {strategy.other !== null && (
                <View className="flex-row items-center gap-2">
                  <TextInput
                    accessibilityLabel={S.amount}
                    placeholder={S.amount}
                    keyboardType="decimal-pad"
                    value={strategy.other.text}
                    onChangeText={strategy.onAmountChange}
                    onSubmitEditing={() => void strategy.onSave()}
                    className="h-11 flex-1 rounded-button-lg bg-subtle px-3 text-body text-fg"
                  />
                  <Button variant="primary" onPress={strategy.onSave} pending={strategy.pending}>
                    {C.save}
                  </Button>
                </View>
              )}
            </View>
          )
        )}
        {strategy.error !== null && (
          <Text accessibilityRole="alert" className="text-caption text-negative">
            {strategy.error}
          </Text>
        )}
      </View>
    </Tile>
  );
}

function Categories({ categories }: Pick<MonthClosedViewProps, "categories">) {
  return (
    <Tile title={categories.title} meta={S.vsUsualHeader}>
      {categories.rows.length === 0 ? (
        <Text className="text-body text-fg-secondary">{S.noSpending}</Text>
      ) : (
        categories.rows.map((row, i) => (
          <ListRow
            key={row.key}
            first={i === 0}
            name={row.label}
            value={<MoneyValue value={row.amount} weight="strong" fractionDigits={0} />}
            {...(row.vsUsual === null
              ? {}
              : {
                  sub2:
                    row.vsUsual.kind === "over" ? (
                      <Text className="text-caption text-negative tabular-nums">
                        {row.vsUsual.text}
                      </Text>
                    ) : (
                      S.asUsual
                    ),
                })}
          />
        ))
      )}
    </Tile>
  );
}

/** The tiles of the month-closed state, without the screen's scroll container (Today embeds them). */
function MonthClosedContent(props: MonthClosedViewProps) {
  return (
    <View className="gap-3 p-4">
      <Kept hero={props.hero} />
      <Strategy strategy={props.strategy} />
      {props.strategy.kind !== "off" && <NoteLine icon="shield">{S.planNote}</NoteLine>}
      <Categories categories={props.categories} />
      {props.onShowRunning !== null && (
        <Pressable
          accessibilityRole="button"
          onPress={props.onShowRunning}
          className="flex-row items-center gap-1 self-start py-2"
        >
          <Text className="text-body font-medium text-accent">{S.toToday}</Text>
          <Icon name="chevron-right" size={16} className="text-accent" />
        </Pressable>
      )}
    </View>
  );
}

export function MonthClosedView(props: MonthClosedViewProps) {
  const { chrome } = props;
  return (
    <ScrollView className="flex-1 bg-surface" keyboardShouldPersistTaps="handled">
      {chrome.kind === "tab" ? (
        <TabHeader {...chrome.header} title={props.title} />
      ) : (
        chrome.fresh !== null && (
          <View className="px-4 pt-3">
            <FreshLine tone={chrome.fresh.tone}>{chrome.fresh.text}</FreshLine>
          </View>
        )
      )}
      <MonthClosedContent {...props} />
    </ScrollView>
  );
}
