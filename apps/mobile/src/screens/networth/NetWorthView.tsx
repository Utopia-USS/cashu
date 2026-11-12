// Pure Net worth tab: the hero (figure, change, the other currencies and the NBP table date, the
// 12-month chart, four facts), then the accounts, loans and valued assets. Every amount arrives as
// exact Money from the screen hook; the household profile without investments leads with Accounts.
import {
  DateText,
  Delta,
  Facts,
  Figure,
  LineChart,
  ListRow,
  Meter,
  Money as MoneyValue,
  NoteLine,
  Tile,
  useUiEnv,
} from "@cashu/ui/native";
import { Pressable, ScrollView, Text, View } from "react-native";
import { TabHeader } from "../../shell/TabHeader";
import { CurrencyPicker } from "../controls/CurrencyPicker";
import type { NetWorthAccountRow, NetWorthViewProps } from "../money-contracts";
import { S } from "./NetWorth.strings";

function heroLabel(props: NetWorthViewProps, bananas: boolean): string {
  if (bananas) return S.inBananas;
  return props.hero.label === "converted" ? S.convertedTo(props.currency) : S.netWorth;
}

function Hero(props: NetWorthViewProps) {
  const { privacy, bananas } = useUiEnv();
  const { hero } = props;
  return (
    <Tile title={heroLabel(props, privacy && bananas != null)} meta={S.twelveMonths}>
      <View className="gap-2">
        <Figure value={hero.value} fractionDigits={0} />
        {hero.change !== null && (
          <View className="flex-row flex-wrap items-center gap-x-1.5">
            <Delta
              kind="money"
              value={hero.change.amount}
              size="caption"
              weight="strong"
              fractionDigits={0}
            />
            {hero.change.pct !== null && (
              <Delta kind="percent" value={hero.change.pct} size="caption" fractionDigits={1} />
            )}
            <Text className="text-caption text-fg-muted">{hero.change.sinceLabel}</Text>
          </View>
        )}
        {!privacy && hero.parts.length > 0 && (
          <View className="flex-row flex-wrap items-center gap-x-1.5">
            <Text className="text-caption text-fg-muted">{S.incl}</Text>
            {hero.parts.map((part) => (
              <MoneyValue key={part.currency} value={part.amount} size="caption" tone="muted" />
            ))}
          </View>
        )}
        {hero.rateDate !== null && (
          <Text className="text-caption text-fg-muted">{S.nbpRate(hero.rateDate)}</Text>
        )}
        {hero.otherCurrencies.length > 0 && (
          <View className="flex-row flex-wrap items-center gap-x-1.5">
            <Text className="text-caption text-fg-muted">{S.otherCurrencies}</Text>
            {hero.otherCurrencies.map((part) => (
              <MoneyValue key={part.currency} value={part.amount} size="caption" tone="muted" />
            ))}
          </View>
        )}
        {hero.missingRate.length > 0 && (
          <Text className="text-caption text-fg-muted">
            {S.noRateYet(hero.missingRate.join(", "))}
          </Text>
        )}
      </View>
      <View className="mt-3">
        <LineChart {...props.chart} />
      </View>
      {props.facts.length > 0 && (
        <View className="mt-3">
          <Facts
            items={props.facts.map((fact) => ({
              label: fact.label,
              value:
                typeof fact.value === "string" ? (
                  fact.value
                ) : (
                  <MoneyValue value={fact.value} size="title" weight="strong" fractionDigits={0} />
                ),
              ...(fact.detail === undefined ? {} : { detail: fact.detail }),
            }))}
          />
        </View>
      )}
      {props.currencies.length > 1 && (
        <View className="mt-3">
          <CurrencyPicker
            currencies={props.currencies}
            currency={props.currency}
            onCurrencyChange={props.onCurrencyPicked}
          />
        </View>
      )}
    </Tile>
  );
}

function AccountSub({ row }: { row: NetWorthAccountRow }) {
  return (
    <View className="shrink flex-row items-center gap-1">
      {row.bank !== null && (
        <Text numberOfLines={1} className="shrink text-caption text-fg-muted">
          {row.bank}
        </Text>
      )}
      {row.asOf === null ? (
        <Text className="text-caption text-fg-muted">{S.noBalance}</Text>
      ) : (
        <>
          <Text className="text-caption text-fg-muted">{S.asOf}</Text>
          <DateText value={row.asOf} size="caption" tone="muted" />
        </>
      )}
    </View>
  );
}

function Accounts(props: NetWorthViewProps) {
  if (props.accounts.length === 0 && props.emptyCount === 0) return null;
  return (
    <Tile title={S.accounts}>
      {props.accounts.map((row, i) => (
        <ListRow
          key={row.gid}
          first={i === 0}
          name={row.name}
          value={<MoneyValue value={row.amount} weight="strong" />}
          sub={<AccountSub row={row} />}
        />
      ))}
      {props.emptyCount > 0 && (
        <Pressable
          accessibilityRole="button"
          onPress={props.onShowEmptyToggled}
          className="mt-2 self-start py-2"
        >
          <Text className="text-caption font-medium text-accent">
            {props.showEmpty ? S.hideEmpty : S.showEmpty(props.emptyCount)}
          </Text>
        </Pressable>
      )}
    </Tile>
  );
}

function Loans(props: NetWorthViewProps) {
  if (props.loans.length === 0) return null;
  return (
    <Tile title={S.loans}>
      {props.loans.map((loan, i) => (
        <View key={loan.gid} className="gap-1.5 pb-2">
          <ListRow
            first={i === 0}
            name={loan.name}
            accessibilityLabel={S.openLoan(loan.name)}
            onPress={() => props.onLoanPressed(loan.gid)}
            value={<MoneyValue value={loan.outstanding} weight="strong" fractionDigits={0} />}
            sub={
              <View className="shrink flex-row items-center gap-1">
                <MoneyValue value={loan.monthly} size="caption" tone="muted" />
                <Text className="text-caption text-fg-muted">{S.perMonth}</Text>
              </View>
            }
            sub2={
              <View className="flex-row items-center gap-1">
                <Text className="text-caption text-fg-muted">{S.until}</Text>
                <DateText value={loan.payoffDate} size="caption" tone="muted" />
              </View>
            }
          />
          <Meter share={loan.share} tone="accent" height="thin" />
        </View>
      ))}
    </Tile>
  );
}

function Assets(props: NetWorthViewProps) {
  if (props.assets.length === 0) return null;
  return (
    <Tile title={S.propertyAndCar}>
      {props.assets.map((asset, i) => (
        <ListRow
          key={asset.gid}
          first={i === 0}
          name={asset.name}
          value={<MoneyValue value={asset.amount} weight="strong" fractionDigits={0} />}
          sub={
            asset.depreciationPerMonth === null ? (
              <View className="shrink flex-row items-center gap-1">
                <Text className="text-caption text-fg-muted">{S.valued}</Text>
                <DateText value={asset.asOf} size="caption" tone="muted" />
              </View>
            ) : (
              <View className="shrink flex-row items-center gap-1">
                <Text className="text-caption text-fg-muted">{S.losesBefore}</Text>
                <MoneyValue
                  value={asset.depreciationPerMonth}
                  size="caption"
                  tone="muted"
                  fractionDigits={0}
                />
                <Text className="text-caption text-fg-muted">{S.losesAfter}</Text>
              </View>
            )
          }
          {...(asset.stale ? { sub2: S.oldValuation } : {})}
        />
      ))}
    </Tile>
  );
}

export function NetWorthView(props: NetWorthViewProps) {
  return (
    <ScrollView className="flex-1 bg-surface">
      <TabHeader {...props.header} title={S.title} />
      <View className="gap-3 p-4">
        {props.partnerFirst ? (
          <>
            <Accounts {...props} />
            <Hero {...props} />
          </>
        ) : (
          <>
            <Hero {...props} />
            <Accounts {...props} />
          </>
        )}
        <Loans {...props} />
        <Assets {...props} />
        {(props.loans.length > 0 || props.assets.length > 0) && (
          <NoteLine icon="laptop">
            {props.loans.length > 0 ? S.noteValuesAndLoans : S.noteValues}
          </NoteLine>
        )}
      </View>
    </ScrollView>
  );
}
