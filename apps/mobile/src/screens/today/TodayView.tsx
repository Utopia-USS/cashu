// Pure Today tab (prototype `today`): [the stale or consent banner], the hero tile (what the month is on
// track to keep, the pace meter, the KPI strip), "Worth a look" (only with rows), the next 7 days and
// where it went with the quiet "small payments without a category" line, then the bank note. In the
// month-closed state the closed month takes the place of all of it.
import {
  Banner,
  DateLead,
  Figure,
  Icon,
  KpiStrip,
  ListRow,
  Meter,
  Money as MoneyValue,
  NoteLine,
  PaceMeter,
  Swatch,
  Tile,
  useUiEnv,
} from "@cashu/ui/native";
import { Pressable, ScrollView, Text, View } from "react-native";
import { TabHeader } from "../../shell/TabHeader";
import { SyncSlotView } from "../../sync/SyncSlotView";
import { MonthClosedView } from "../monthClosed/MonthClosedView";
import { S } from "./Today.strings";
import type { TodayAttentionRow, TodayReady, TodayState } from "./today-contracts";

function Hero({ state }: { state: TodayReady }) {
  const { privacy, bananas } = useUiEnv();
  const { hero } = state;
  return (
    <View className={state.stale ? "opacity-70" : ""}>
      <Tile
        title={privacy && bananas ? `${hero.label}${S.inBananas}` : hero.label}
        meta={hero.daysLeftLabel}
        onPress={state.onHeroPressed}
      >
        <View className="gap-2">
          <Figure
            value={hero.keep}
            fractionDigits={0}
            tone={hero.negative ? "negative" : "default"}
          />
          <Text className="text-caption text-fg-muted">{hero.subLine}</Text>
        </View>
        {hero.pace !== null && (
          <View className="mt-4">
            <PaceMeter
              spentShare={hero.pace.spentShare}
              usualShare={hero.pace.usualShare}
              labelLeft={hero.pace.left}
              labelRight={hero.pace.right}
              rightTone={hero.pace.rightTone}
            />
          </View>
        )}
        <KpiStrip
          items={hero.kpis.map((kpi) => ({
            label: kpi.label,
            value: <MoneyValue value={kpi.value} size="title" weight="strong" fractionDigits={0} />,
          }))}
        />
      </Tile>
    </View>
  );
}

const LEAD_TONES = {
  warn: { box: "bg-warning-bg", icon: "text-warning" },
  neg: { box: "bg-negative-bg", icon: "text-negative" },
  default: { box: "bg-subtle", icon: "text-fg-secondary" },
} as const;

function AttentionRow({ row, first }: { row: TodayAttentionRow; first: boolean }) {
  const tone = LEAD_TONES[row.tone];
  return (
    <ListRow
      first={first}
      lead={
        <View className={`size-8.5 items-center justify-center rounded-button-lg ${tone.box}`}>
          <Icon name={row.icon} size={20} className={tone.icon} />
        </View>
      }
      name={row.title}
      value={row.magnitude}
      {...(row.sub === "" ? {} : { sub: row.sub })}
      sub2={row.magnitudeLabel}
      {...(row.onPress === null ? {} : { onPress: row.onPress })}
    />
  );
}

function Attention({ rows }: { rows: TodayReady["attention"] }) {
  if (rows.length === 0) return null;
  return (
    <Tile title={S.worthALook}>
      {rows.map((row, i) => (
        <AttentionRow key={row.key} row={row} first={i === 0} />
      ))}
    </Tile>
  );
}

function Upcoming({ state }: { state: TodayReady }) {
  return (
    <Tile
      title={S.next7Days}
      {...(state.total === null
        ? {}
        : { meta: <MoneyValue value={state.total} size="caption" tone="muted" /> })}
    >
      {state.upcoming.length === 0 ? (
        <Text className="text-body text-fg-secondary">{S.nothingDue}</Text>
      ) : (
        state.upcoming.map((row, i) => (
          <ListRow
            key={row.key}
            first={i === 0}
            lead={<DateLead date={row.date} />}
            name={row.payee}
            value={<MoneyValue value={row.amount} weight="strong" />}
            {...(row.account === null ? {} : { sub: row.account })}
            {...(row.covered === true ? { sub2: S.covered } : {})}
          />
        ))
      )}
    </Tile>
  );
}

function WhereItWent({ state }: { state: TodayReady }) {
  const { spent, uncategorized } = state;
  if (spent.rows.length === 0 && uncategorized === null) return null;
  return (
    <Tile
      title={S.whereItWent}
      meta={
        <Pressable
          accessibilityRole="button"
          onPress={state.onSpentPressed}
          className="flex-row items-center gap-0.5 py-1"
        >
          <Text className="text-caption text-fg-muted">{S.allCategories}</Text>
          <Icon name="chevron-right" size={16} className="text-fg-muted" />
        </Pressable>
      }
    >
      {spent.rows.map((row, i) => (
        <View key={row.category} className="gap-1.5 pb-2">
          <ListRow
            first={i === 0}
            lead={<Swatch color={row.swatch} />}
            name={row.label}
            value={<MoneyValue value={row.amount} weight="strong" fractionDigits={0} />}
            onPress={state.onSpentPressed}
          />
          <Meter share={row.share} height="thin" />
        </View>
      ))}
      {spent.more !== null && (
        <ListRow
          first={spent.rows.length === 0}
          name={S.moreCategories(spent.more.count)}
          value={<MoneyValue value={spent.more.amount} weight="strong" fractionDigits={0} />}
          onPress={state.onSpentPressed}
        />
      )}
      {uncategorized !== null && (
        <Pressable
          accessibilityRole="button"
          onPress={state.onUncategorizedPressed}
          className="-mx-5 -mb-5 mt-3 flex-row items-center justify-between gap-3 border-t border-border px-5 py-4 active:bg-subtle"
        >
          <Text className="shrink text-caption text-fg-muted">
            {S.smallUncategorized(uncategorized.count)}
            {" · "}
            <MoneyValue value={uncategorized.sum} size="caption" tone="muted" fractionDigits={0} />
          </Text>
          <Text className="text-caption font-strong text-fg">{S.categorize}</Text>
        </Pressable>
      )}
    </Tile>
  );
}

function Ready({ state }: { state: TodayReady }) {
  return (
    // Set here, not left to the tab: the tab insets only the scroll view it found when it appeared, so
    // this one (mounted when the closed month gives way, e.g. to the sync-off notice) would draw its
    // header under the status bar.
    <ScrollView className="flex-1 bg-surface" contentInsetAdjustmentBehavior="automatic">
      <TabHeader {...state.header} title={state.title} />
      <View className="gap-3 p-4">
        <SyncSlotView slot={state.sync} />
        {state.banner !== null && (
          <Banner
            tone={state.banner.tone}
            icon="laptop"
            title={state.banner.title}
            body={state.banner.body}
          />
        )}
        <Hero state={state} />
        <Attention rows={state.attention} />
        <Upcoming state={state} />
        <WhereItWent state={state} />
        <NoteLine icon="laptop">{state.note}</NoteLine>
      </View>
    </ScrollView>
  );
}

export function TodayView({ state }: { state: TodayState }) {
  return state.kind === "closed" ? <MonthClosedView {...state} /> : <Ready state={state} />;
}
