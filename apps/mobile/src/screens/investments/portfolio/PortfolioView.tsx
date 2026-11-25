// Pure Portfolio view of the Investments tab (prototype "Portfolio subtab"): the value tile (converted
// to the base currency, or in bananas in incognito, today's and the week's change, the foreign positions
// at the NBP rate, the year chart and four facts), allocation against the strategy's targets (a bar per
// bucket with a marker at the target) and the positions (every one opens its page; a red ring when a
// decision waits on it). Amounts render through the value components, so incognito hides them.
import {
  Delta,
  EmptyState,
  Facts,
  Figure,
  LineChart,
  ListRow,
  Money as MoneyValue,
  NoteLine,
  Percent,
  Tag,
  TickerTile,
  Tile,
  useUiEnv,
} from "@cashu/ui/native";
import { Text, View } from "react-native";
import { AccountPicker } from "../../controls/AccountPicker";
import type {
  AllocationColor,
  PortfolioPosition,
  PortfolioViewProps,
} from "../investments-contracts";
import { S } from "./Portfolio.strings";

type Ready = Extract<PortfolioViewProps, { status: "ready" }>;

// Literal classes per role: Uniwind generates only the classes it finds written out.
const FILL: Record<AllocationColor, string> = {
  "inv-global": "bg-inv-global",
  "inv-pl": "bg-inv-pl",
  "inv-bonds": "bg-inv-bonds",
  "inv-cash": "bg-inv-cash",
  "inv-other": "bg-inv-other",
};

const percent = (share: number) => `${Math.min(Math.max(share, 0), 1) * 100}%` as const;

function ValueTile(props: Ready) {
  const { privacy, bananas } = useUiEnv();
  const { value } = props;
  const inBananas = privacy && bananas != null;
  return (
    <Tile
      title={inBananas ? S.inBananas : S.convertedTo(props.currency)}
      meta={
        props.accounts.options.length > 1 ? (
          <AccountPicker
            options={props.accounts.options}
            selected={props.accounts.selected}
            onPicked={props.accounts.onPicked}
            anyLabel={S.allAccounts}
            testID="investments-account"
          />
        ) : undefined
      }
    >
      <View className="gap-2">
        <Figure value={value.total} fractionDigits={0} />
        {(value.day !== null || value.weekPct !== null) && (
          <View className="flex-row flex-wrap items-center gap-x-1.5">
            {value.day !== null && (
              <>
                <Delta
                  kind="money"
                  value={value.day.amount}
                  size="caption"
                  weight="strong"
                  fractionDigits={0}
                />
                {value.day.pct !== null && (
                  <Delta kind="percent" value={value.day.pct} size="caption" fractionDigits={1} />
                )}
                <Text className="text-caption text-fg-muted">{S.today}</Text>
              </>
            )}
            {value.day !== null && value.weekPct !== null && (
              <Text className="text-caption text-fg-muted">·</Text>
            )}
            {value.weekPct !== null && (
              <>
                <Delta
                  kind="percent"
                  value={value.weekPct}
                  size="caption"
                  weight="strong"
                  fractionDigits={1}
                />
                <Text className="text-caption text-fg-muted">{S.thisWeek}</Text>
              </>
            )}
          </View>
        )}
        {!privacy && value.incl.length > 0 && (
          <View className="flex-row flex-wrap items-center gap-x-1.5">
            <Text className="text-caption text-fg-muted">{S.incl}</Text>
            {value.incl.map((part) => (
              <MoneyValue key={part.currency} value={part} size="caption" tone="muted" />
            ))}
            {value.rateDate !== null && (
              <Text className="text-caption text-fg-muted">{S.nbpRate(value.rateDate)}</Text>
            )}
          </View>
        )}
      </View>
      <View className="mt-3">
        <LineChart {...props.chart} />
      </View>
      <View className="mt-3">
        <Facts
          items={[
            {
              label: S.thisYear,
              value: (
                <Delta
                  kind="percent"
                  value={props.facts.thisYear}
                  size="title"
                  weight="strong"
                  fractionDigits={1}
                />
              ),
            },
            {
              label: S.fromHigh,
              value: (
                <Percent
                  value={props.facts.fromHigh}
                  size="title"
                  weight="strong"
                  fractionDigits={1}
                />
              ),
            },
            {
              label: S.unrealized,
              value: (
                <Delta
                  kind="money"
                  value={props.facts.unrealized}
                  size="title"
                  weight="strong"
                  fractionDigits={0}
                />
              ),
            },
            {
              label: S.added(props.yearLabel),
              value: (
                <MoneyValue
                  value={props.facts.added}
                  size="title"
                  weight="strong"
                  fractionDigits={0}
                />
              ),
              ...(props.facts.planToDate === null
                ? {}
                : {
                    detail: (
                      <View className="flex-row flex-wrap items-center gap-x-1">
                        <Text className="text-caption text-fg-muted">{S.planToDate}</Text>
                        <MoneyValue
                          value={props.facts.planToDate}
                          size="caption"
                          tone="muted"
                          fractionDigits={0}
                        />
                      </View>
                    ),
                  }),
            },
          ]}
        />
      </View>
    </Tile>
  );
}

function Allocation({ allocation }: Ready) {
  if (allocation.rows.length === 0) return null;
  return (
    <Tile
      title={S.allocation}
      meta={
        allocation.drift === null ? undefined : (
          <Tag tone={allocation.drift.tone === "warn" ? "warning" : "positive"}>
            {allocation.drift.label}
          </Tag>
        )
      }
    >
      <View className="gap-3">
        {allocation.rows.map((row) => (
          <View key={row.key} className="gap-1.5">
            <View className="flex-row items-center justify-between gap-3">
              <Text numberOfLines={1} className="shrink text-body text-fg">
                {row.label}
              </Text>
              <View className="flex-row items-center gap-1">
                <Percent value={row.now} weight="strong" fractionDigits={0} />
                <Text className="text-caption text-fg-muted">/</Text>
                {row.target === null ? (
                  <Text className="text-caption text-fg-muted">{S.noTarget}</Text>
                ) : (
                  <Percent value={row.target} tone="muted" fractionDigits={0} />
                )}
              </View>
            </View>
            <View
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              className="h-2 rounded-full bg-subtle"
            >
              <View
                className={`absolute inset-y-0 left-0 rounded-full ${FILL[row.color]}`}
                style={{ width: percent(row.now.toFloat()) }}
              />
              {row.target !== null && (
                <View
                  className="absolute -top-1 h-4 w-0.5 rounded-5xs bg-fg"
                  style={{ left: percent(row.target.toFloat()) }}
                />
              )}
            </View>
          </View>
        ))}
      </View>
    </Tile>
  );
}

function PositionSub({ row }: { row: PortfolioPosition }) {
  return (
    <View className="shrink flex-row items-center gap-1">
      <Text numberOfLines={1} className="shrink text-caption text-fg-muted">
        {row.account}
      </Text>
      {row.weekPct !== null && (
        <>
          <Text className="text-caption text-fg-muted">· {S.week}</Text>
          <Delta kind="percent" value={row.weekPct} size="caption" fractionDigits={1} />
        </>
      )}
    </View>
  );
}

function Positions(props: Ready) {
  return (
    <Tile title={S.positions} meta={S.byValue}>
      {props.positions.length === 0 ? (
        <EmptyState title={S.noPositions} body={S.noPositionsNote} />
      ) : (
        props.positions.map((row, i) => (
          <ListRow
            key={row.gid}
            first={i === 0}
            lead={<TickerTile ticker={row.ticker} ring={row.risk ? "negative" : null} />}
            name={row.name}
            accessibilityLabel={S.openPosition(row.name)}
            onPress={() => props.onPositionPressed(row.gid)}
            value={<MoneyValue value={row.value} weight="strong" fractionDigits={0} />}
            sub={<PositionSub row={row} />}
            {...(row.resultPct === null
              ? {}
              : {
                  sub2: (
                    <Delta kind="percent" value={row.resultPct} size="caption" fractionDigits={1} />
                  ),
                })}
          />
        ))
      )}
      {props.pricesStale > 0 && (
        <View className="mt-3">
          <NoteLine icon="sync">{S.stalePrices(props.pricesStale)}</NoteLine>
        </View>
      )}
    </Tile>
  );
}

export function PortfolioView(props: PortfolioViewProps) {
  if (props.status === "unavailable")
    return (
      <Tile>
        <NoteLine icon="laptop">{props.message}</NoteLine>
      </Tile>
    );
  return (
    <View className="gap-3">
      <ValueTile {...props} />
      <Allocation {...props} />
      <Positions {...props} />
    </View>
  );
}
