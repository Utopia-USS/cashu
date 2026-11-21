// Pure loan page: the amount left as the figure, the rate and the repaid share, the balance over the
// schedule, four facts, the next installment and where loan terms change. Amounts arrive as Money.
import {
  DateLead,
  DateText,
  EmptyState,
  Facts,
  Figure,
  LineChart,
  ListRow,
  Money as MoneyValue,
  NoteLine,
  Percent,
  Tile,
  useUiEnv,
} from "@cashu/ui/native";
import { ScrollView, Text, View } from "react-native";
import type { LoanViewProps } from "../money-contracts";
import { S } from "./Loan.strings";

export function LoanView({ loan }: LoanViewProps) {
  const { privacy, bananas } = useUiEnv();
  if (loan === null)
    return (
      <View className="flex-1 justify-center bg-surface">
        <EmptyState title={S.gone} />
      </View>
    );
  return (
    <ScrollView className="flex-1 bg-surface">
      <View className="gap-3 p-4">
        <Tile
          title={privacy && bananas != null ? S.leftToRepayBananas : S.leftToRepay}
          meta={
            <View className="flex-row items-center gap-1">
              <Percent value={loan.annualRate} size="caption" tone="muted" fractionDigits={2} />
              <Text className="text-caption text-fg-muted">{S.perYear}</Text>
            </View>
          }
        >
          <View className="gap-2">
            <Figure value={loan.outstanding} fractionDigits={0} />
            <Text className="text-caption text-fg-muted tabular-nums">{loan.repaidLine}</Text>
          </View>
          <View className="mt-3">
            <LineChart {...loan.chart} />
          </View>
          <View className="mt-3">
            <Facts
              items={[
                {
                  label: S.eachMonth,
                  value: <MoneyValue value={loan.monthly} size="title" weight="strong" />,
                },
                {
                  label: S.rate,
                  value: (
                    <Percent
                      value={loan.annualRate}
                      size="title"
                      weight="strong"
                      fractionDigits={2}
                    />
                  ),
                },
                {
                  label: S.lastInstallment,
                  value: <DateText value={loan.payoffDate} size="title" weight="strong" />,
                },
                {
                  label: S.interestPaid,
                  value: (
                    <MoneyValue
                      value={loan.interestPaid}
                      size="title"
                      weight="strong"
                      fractionDigits={0}
                    />
                  ),
                  detail: (
                    <View className="flex-row items-center gap-1">
                      <MoneyValue
                        value={loan.interestRemaining}
                        size="caption"
                        tone="muted"
                        fractionDigits={0}
                      />
                      <Text className="text-caption text-fg-muted">{S.interestLeft}</Text>
                    </View>
                  ),
                },
              ]}
            />
          </View>
        </Tile>
        {loan.next !== null && (
          <Tile title={S.nextInstallment}>
            <ListRow
              first
              lead={<DateLead date={loan.next.date} />}
              name={S.installment}
              value={<MoneyValue value={loan.next.amount} weight="strong" />}
              sub={
                <View className="shrink flex-row items-center gap-1">
                  <Text className="text-caption text-fg-muted">{S.ofWhichInterest}</Text>
                  <MoneyValue value={loan.next.interest} size="caption" tone="muted" />
                </View>
              }
              {...(loan.next.account === null ? {} : { sub2: S.fromAccount(loan.next.account) })}
            />
          </Tile>
        )}
        <NoteLine icon="laptop">{S.note}</NoteLine>
      </View>
    </ScrollView>
  );
}
