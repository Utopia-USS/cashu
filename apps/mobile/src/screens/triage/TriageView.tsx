// Pure categorize deck (prototype `triage`): the modal bar with close and Skip, the progress, the card
// stack (date, account, payee, amount, statement and the merchant's earlier category), then the
// category grid and the "same for every payment" toggle; the done and empty states.
import {
  Button,
  CategoryGrid,
  EmptyState,
  Figure,
  Icon,
  Money as MoneyValue,
  ProgressDots,
  Swatch,
  SwipeStack,
  ToggleRow,
} from "@cashu/ui/native";
import { Pressable, ScrollView, Text, View } from "react-native";
import { S } from "./Triage.strings";
import type { TriageState } from "./useTriageScreen";

export type TriageViewProps = TriageState;

type CardState = Extract<TriageState, { kind: "card" }>;

function ModalBar({ onClose, onSkip }: { onClose(): void; onSkip?: () => void }) {
  return (
    <View className="min-h-11 flex-row items-center justify-between gap-3 px-4 py-2">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={S.close}
        onPress={onClose}
        hitSlop={4}
        className="size-9 items-center justify-center rounded-full bg-chip active:opacity-70"
      >
        <Icon name="x" className="text-fg-secondary" />
      </Pressable>
      {onSkip !== undefined && (
        <>
          <Text role="heading" className="shrink text-headline font-strong text-fg">
            {S.categorize}
          </Text>
          <Button variant="ghost" size="sm" onPress={onSkip}>
            {S.skip}
          </Button>
        </>
      )}
    </View>
  );
}

function Card(props: CardState) {
  const { card } = props;
  return (
    <View className="flex-1 gap-3 rounded-widget border border-border bg-surface-raised p-5">
      <View className="flex-row items-center justify-between gap-2">
        <Text numberOfLines={1} className="shrink text-caption text-fg-muted">
          {S.card(card.dateLabel, card.account)}
        </Text>
        <Text className="text-caption text-fg-muted tabular-nums">
          {S.stepOf(props.done + 1, props.total)}
        </Text>
      </View>
      <Text numberOfLines={2} className="text-title font-strong text-fg">
        {card.payee}
      </Text>
      <Figure value={card.amount} size="sheet" fractionDigits={2} />
      {card.statement !== null && (
        <Text numberOfLines={2} className="font-mono text-caption text-fg-muted">
          {card.statement}
        </Text>
      )}
      {card.suggestion !== null && (
        <View className="mt-auto flex-row items-center gap-2 rounded-lg bg-subtle p-3">
          <View className="shrink grow gap-0.5">
            <Text className="text-caption text-fg-muted">{S.suggested}</Text>
            <View className="flex-row items-center gap-2">
              <Swatch color={card.suggestion.swatch} />
              <Text numberOfLines={1} className="shrink text-body font-strong text-fg">
                {card.suggestion.label}
              </Text>
            </View>
          </View>
          <Button
            variant="primary"
            size="sm"
            disabled={props.isSaving}
            onPress={props.onUseSuggestion}
          >
            {S.useIt}
          </Button>
        </View>
      )}
    </View>
  );
}

function Behind({ next }: { next: NonNullable<CardState["next"]> }) {
  return (
    <View className="flex-1 gap-3 rounded-widget border border-border bg-surface-raised p-5">
      <Text numberOfLines={1} className="mt-6 text-title font-strong text-fg">
        {next.payee}
      </Text>
      <MoneyValue value={next.amount} weight="strong" />
    </View>
  );
}

function Deck(props: CardState) {
  return (
    <ScrollView className="flex-1" contentContainerClassName="gap-4 px-4 pb-10">
      {props.dots && <ProgressDots total={props.total} done={props.done} />}
      <SwipeStack
        enabled={false}
        onSwiped={() => {}}
        swipeLeftLabel={S.skip}
        swipeRightLabel={S.useIt}
        {...(props.next === null ? {} : { behind: <Behind next={props.next} /> })}
      >
        <Card {...props} />
      </SwipeStack>
      {props.error !== null && (
        <Text accessibilityLiveRegion="polite" className="text-caption text-negative">
          {props.error}
        </Text>
      )}
      <Text role="heading" className="px-1 text-caption font-demi text-fg-muted">
        {props.card.suggestion === null ? S.pickCategory : S.orPickAnother}
      </Text>
      <CategoryGrid
        options={props.grid.options}
        selected={props.grid.selected}
        suggested={props.grid.suggested}
        suggestedHint={S.suggested}
        expanded={props.grid.expanded}
        onPick={(key) => {
          if (!props.isSaving) props.grid.onPick(key);
        }}
        onExpand={props.grid.onExpand}
        expandLabel={S.allCategories}
      />
      {props.rule !== null && (
        <View className="rounded-xl bg-surface-raised px-4">
          <ToggleRow
            label={props.rule.label}
            sub={props.rule.sub}
            value={props.rule.on}
            onChange={props.rule.onToggle}
          />
        </View>
      )}
    </ScrollView>
  );
}

export function TriageView(props: TriageViewProps) {
  if (props.kind === "card")
    return (
      <View className="flex-1 bg-surface">
        <ModalBar onClose={props.onClose} onSkip={props.onSkip} />
        <Deck {...props} />
      </View>
    );
  return (
    <View className="flex-1 bg-surface">
      <ModalBar onClose={props.onClose} />
      <View className="flex-1 justify-center">
        {props.kind === "done" ? (
          <View className="items-center gap-3 px-6">
            <Icon name="check" size={24} className="text-positive" />
            <EmptyState
              title={props.onContinue === null ? S.allCategorized : S.done}
              body={
                props.left > 0
                  ? `${S.doneBody(props.count)} ${S.moreLeft(props.left)}`
                  : S.doneBody(props.count)
              }
              action={
                props.onContinue === null ? (
                  <Button variant="primary" onPress={props.onClose}>
                    {S.done}
                  </Button>
                ) : (
                  <View className="flex-row gap-2">
                    <Button variant="secondary" onPress={props.onClose}>
                      {S.close}
                    </Button>
                    <Button variant="primary" onPress={props.onContinue}>
                      {S.continue}
                    </Button>
                  </View>
                )
              }
            />
          </View>
        ) : (
          <EmptyState
            icon="check"
            title={S.nothingToDo}
            action={<Button onPress={props.onClose}>{S.close}</Button>}
          />
        )}
      </View>
    </View>
  );
}
