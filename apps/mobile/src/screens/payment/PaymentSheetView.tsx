// The payment sheet (prototype `tx` sheet): the payee and the amount, the own-transfer note, the
// category grid with the rule for the payee, the details and the payee's earlier payments (or the note
// that this is the first one). Inflows and own transfers have no category section.
import {
  Button,
  CategoryGrid,
  EmptyState,
  Figure,
  GroupSection,
  Icon,
  ListRow,
  Money as MoneyValue,
  NoteLine,
  ToggleRow,
} from "@cashu/ui/native";
import { ScrollView, Text, View } from "react-native";
import { S } from "./Payment.strings";
import type { PaymentSheetState } from "./usePaymentSheet";

export type PaymentSheetViewProps = PaymentSheetState;
type Ready = Extract<PaymentSheetState, { kind: "ready" }>;

function CloseButton({ onClose }: { onClose(): void }) {
  return (
    <Button variant="glyph" label={S.close} onPress={onClose}>
      <Icon name="x" size={20} />
    </Button>
  );
}

function Category({ props }: { props: Ready }) {
  const { category, rule } = props;
  if (category === null) return null;
  return (
    <GroupSection
      grouped={false}
      title={S.category}
      meta={category.suggestedLabel === null ? null : S.suggested(category.suggestedLabel)}
    >
      <CategoryGrid
        options={category.options}
        selected={category.selected}
        suggested={category.suggested}
        suggestedHint={S.suggestedHint}
        expanded={category.expanded}
        collapsedCount={category.collapsedCount}
        onPick={category.onPick}
        onExpand={category.onExpand}
        expandLabel={S.more}
        columns={2}
      />
      {props.error !== null && (
        <Text accessibilityLiveRegion="polite" className="px-1 text-caption text-negative">
          {props.error}
        </Text>
      )}
      {rule !== null && (
        <GroupSection>
          <ToggleRow
            label={rule.title}
            sub={rule.sub}
            value={rule.on}
            onChange={rule.onToggle}
            disabled={!rule.enabled || rule.isSaving}
            {...(rule.fixed === null ? {} : { fixed: true })}
          />
        </GroupSection>
      )}
    </GroupSection>
  );
}

function Details({ props }: { props: Ready }) {
  return (
    <GroupSection grouped={false} title={S.details}>
      <GroupSection>
        <ListRow first name={S.account} value={props.account} />
        <ListRow name={S.date} value={props.dateLabel} />
        {props.statement !== null && <ListRow name={S.statement} sub={props.statement} />}
      </GroupSection>
      {props.batch !== null && (
        <Text className="px-1 text-caption text-fg-muted">{props.batch}</Text>
      )}
    </GroupSection>
  );
}

function Earlier({ props }: { props: Ready }) {
  if ("first" in props.earlier) {
    return <NoteLine icon="search">{S.firstPayment(props.payee)}</NoteLine>;
  }
  return (
    <GroupSection title={S.earlierWith(props.payee)}>
      {props.earlier.rows.map((row, i) => (
        <ListRow
          key={row.gid}
          first={i === 0}
          name={row.dateLabel}
          value={<MoneyValue value={row.amount} weight="strong" />}
        />
      ))}
    </GroupSection>
  );
}

export function PaymentSheetView(props: PaymentSheetViewProps) {
  if (props.kind === "missing") {
    return (
      <View className="flex-1 bg-surface px-4 pt-6">
        <View className="items-end">
          <CloseButton onClose={props.onClose} />
        </View>
        <EmptyState icon="search" title={S.missing} />
      </View>
    );
  }
  return (
    <ScrollView className="flex-1 bg-surface" contentContainerClassName="gap-5 px-4 pt-6 pb-10">
      <View className="flex-row items-start justify-between gap-3">
        <View className="shrink gap-3">
          <Text role="heading" numberOfLines={2} className="text-headline font-strong text-fg">
            {props.payee}
          </Text>
          <Figure value={props.amount} size="sheet" fractionDigits={2} />
        </View>
        <CloseButton onClose={props.onClose} />
      </View>
      {props.transfer !== null && (
        <View className="rounded-xl bg-subtle p-4">
          <Text className="text-body text-fg-secondary">
            <Text className="font-strong text-fg">{S.betweenOwn}</Text>
            {props.transfer.counterpart === null
              ? S.transferBodyPlain
              : S.transferBody(props.transfer.counterpart)}
          </Text>
        </View>
      )}
      <Category props={props} />
      <Details props={props} />
      <Earlier props={props} />
    </ScrollView>
  );
}
