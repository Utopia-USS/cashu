// The position page (prototype `position`): the hero tile (ticker with the risk ring, the place, the
// share of the portfolio, the value, the result and the week, the price and the distance from the
// 52-week high), the price chart with the owner's levels and trades and its range, the quantity and the
// average cost, the thesis (read only, edited on the Mac) and the signals, research notes and decisions
// about the instrument. Every value arrives formatted or as a value component's input.
import {
  Delta,
  EmptyState,
  Facts,
  Figure,
  LineChart,
  ListRow,
  NoteLine,
  Seg,
  Tag,
  TickerTile,
  Tile,
} from "@cashu/ui/native";
import { ScrollView, Text, View } from "react-native";
import { S } from "./Position.strings";
import type { PositionRow, PositionState } from "./usePositionScreen";

export type PositionViewProps = PositionState;
type Ready = Extract<PositionState, { kind: "ready" }>;

function Hero({ props }: { props: Ready }) {
  const { hero } = props;
  return (
    <Tile>
      <View className="mb-3 flex-row items-center justify-between gap-3">
        <View className="shrink flex-row items-center gap-2.5">
          <TickerTile ticker={hero.ticker} size="header" ring={hero.risk ? "negative" : null} />
          {hero.place !== null && (
            <Text numberOfLines={1} className="shrink text-caption text-fg-secondary">
              {hero.place}
            </Text>
          )}
        </View>
        {hero.share !== null && <Text className="text-caption text-fg-muted">{hero.share}</Text>}
      </View>
      {hero.value !== null && <Figure value={hero.value} fractionDigits={0} />}
      {(hero.result !== null || hero.week !== null) && (
        <View className="mt-2 flex-row flex-wrap items-center gap-1">
          {hero.result !== null && (
            <>
              <Delta kind="percent" value={hero.result} size="caption" weight="strong" />
              <Text className="text-caption text-fg-muted">{S.result}</Text>
            </>
          )}
          {hero.result !== null && hero.week !== null && (
            <Text className="text-caption text-fg-muted">·</Text>
          )}
          {hero.week !== null && (
            <>
              <Delta kind="percent" value={hero.week} size="caption" weight="strong" />
              <Text className="text-caption text-fg-muted">{S.thisWeek}</Text>
            </>
          )}
        </View>
      )}
      {(hero.perUnit !== null || hero.fromHigh !== null) && (
        <Text className="mt-1 text-caption text-fg-muted tabular-nums">
          {[hero.perUnit, hero.fromHigh].filter((part) => part !== null).join(" · ")}
        </Text>
      )}
      {props.chart !== null && (
        <View className="mt-3">
          <LineChart {...props.chart} />
        </View>
      )}
      <View className="mt-3">
        <Seg
          full
          label={S.range}
          items={[
            [S.range1m, "1m"],
            [S.range3m, "3m"],
            [S.range1y, "1y"],
            [S.rangeMax, "max"],
          ]}
          value={props.range.value}
          onChange={props.range.onChange}
        />
      </View>
      {props.facts !== null && (
        <View className="mt-3">
          <Facts
            items={[
              { label: S.quantity, value: props.facts.quantity },
              ...(props.facts.averageCost === null
                ? []
                : [{ label: S.averageCost, value: props.facts.averageCost }]),
            ]}
          />
        </View>
      )}
    </Tile>
  );
}

function ThesisLine({ label, text }: { label: string; text: string | null }) {
  if (text === null || text === "") return null;
  return (
    <Text className="text-body text-fg-secondary">
      <Text className="font-strong text-fg">{label} </Text>
      {text}
    </Text>
  );
}

function Thesis({ props }: { props: Ready }) {
  const { thesis } = props;
  if (thesis === null) return null;
  return (
    <>
      <Tile title={S.yourThesis}>
        <View className="gap-2">
          <ThesisLine label={S.why} text={thesis.why} />
          <ThesisLine label={S.wrongIf} text={thesis.wrongIf} />
          <ThesisLine label={S.sizePlan} text={thesis.sizePlan} />
          <ThesisLine label={S.exitPlan} text={thesis.exitPlan} />
        </View>
      </Tile>
      <NoteLine icon="laptop">{S.editThesisOnMac}</NoteLine>
    </>
  );
}

function Row({ row, first }: { row: PositionRow; first: boolean }) {
  if (row.kind === "decision")
    return (
      <ListRow
        first={first}
        name={row.title}
        value={<Text className="text-caption text-fg-muted">{S.decision}</Text>}
        sub={row.sub}
      />
    );
  return (
    <ListRow
      first={first}
      name={row.title}
      value={<Tag tone={row.tag.tone}>{row.tag.text}</Tag>}
      sub={row.sub}
      {...(row.onPress === null ? {} : { onPress: row.onPress })}
    />
  );
}

export function PositionView(props: PositionViewProps) {
  if (props.kind === "missing")
    return (
      <View className="flex-1 justify-center bg-surface">
        <EmptyState icon="chart" title={props.reason === "unknown" ? S.missing : S.unavailable} />
      </View>
    );
  return (
    <ScrollView className="flex-1 bg-surface" contentInsetAdjustmentBehavior="automatic">
      <View className="gap-3 p-4 pb-10">
        <Hero props={props} />
        <Thesis props={props} />
        <Tile title={S.signalsAndDecisions}>
          {props.rows.length === 0 ? (
            <Text className="text-caption text-fg-muted">{S.nothingYet}</Text>
          ) : (
            props.rows.map((row, i) => <Row key={row.key} row={row} first={i === 0} />)
          )}
        </Tile>
      </View>
    </ScrollView>
  );
}
