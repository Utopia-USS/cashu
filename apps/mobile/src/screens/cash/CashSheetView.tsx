// Pure cash expense sheet (prototype `cash`): the typed amount, the cash wallet line, the category
// grid, what it was, the day, the keypad and the add button. While amounts are hidden the figure shows
// the digits as typed (the owner is typing them), never on the banana scale.
import {
  Button,
  CategoryGrid,
  Figure,
  Icon,
  Keypad,
  Money as MoneyValue,
  Seg,
  useUiEnv,
} from "@cashu/ui/native";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { S } from "./Cash.strings";
import type { CashSheetState } from "./useCashSheet";

export type CashSheetViewProps = CashSheetState;

function Amount({ amount }: { amount: CashSheetState["amount"] }) {
  const { privacy } = useUiEnv();
  if (privacy)
    return (
      <Text className="text-6xl font-bold leading-none tracking-dense text-fg tabular-nums">
        {amount.typed}
      </Text>
    );
  return (
    <Figure value={amount.money} size="sheet" fractionDigits={amount.text.includes(".") ? 2 : 0} />
  );
}

export function CashSheetView(props: CashSheetViewProps) {
  return (
    <ScrollView
      className="flex-1 bg-surface"
      contentContainerClassName="gap-4 px-4 pt-6 pb-10"
      keyboardShouldPersistTaps="handled"
    >
      <View className="flex-row items-center justify-between gap-3">
        <Text role="heading" className="shrink text-headline font-strong text-fg">
          {S.cashExpense}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={S.close}
          onPress={props.onClose}
          hitSlop={4}
          className="size-9 items-center justify-center rounded-full bg-chip active:opacity-70"
        >
          <Icon name="x" className="text-fg-secondary" />
        </Pressable>
      </View>
      <View className="gap-2">
        <Amount amount={props.amount} />
        <Text className="text-caption text-fg-muted">
          {props.wallet.exists ? (
            <>
              {S.walletBefore}
              <MoneyValue value={props.wallet.balance} size="caption" tone="muted" />
              {S.walletAfter}
            </>
          ) : (
            S.walletNew
          )}
        </Text>
      </View>
      <CategoryGrid
        options={props.grid.options}
        selected={props.grid.selected}
        suggested={props.grid.suggested}
        expanded={props.grid.expanded}
        onPick={props.grid.onPick}
        onExpand={props.grid.onExpand}
        expandLabel={S.allCategories}
      />
      <View className="min-h-11 flex-row items-center gap-3 rounded-lg bg-subtle px-3">
        <Icon name="doc" size={20} className="text-fg-muted" />
        <TextInput
          accessibilityLabel={S.titleLabel}
          value={props.title.value}
          onChangeText={props.title.onChange}
          placeholder={props.title.placeholder}
          returnKeyType="done"
          placeholderTextColorClassName="accent-fg-muted"
          cursorColorClassName="accent-accent"
          className="min-h-11 flex-1 text-body text-fg"
        />
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <Seg
          label={S.date}
          items={props.date.options.map((o) => [o.label, o.key] as const)}
          value={props.date.selected}
          onChange={props.date.onPick}
        />
      </ScrollView>
      <Keypad
        onKey={props.amount.onKey}
        decimalLabel={props.amount.decimal}
        backspaceLabel={S.backspace}
      />
      {props.error !== null && (
        <Text accessibilityLiveRegion="polite" className="text-caption text-negative">
          {props.error}
        </Text>
      )}
      <Button
        variant="primary"
        size="lg"
        disabled={!props.canSave}
        pending={props.isSaving}
        onPress={props.onSave}
      >
        {props.addLabel}
      </Button>
    </ScrollView>
  );
}
