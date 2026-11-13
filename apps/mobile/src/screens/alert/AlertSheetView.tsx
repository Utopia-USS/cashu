// The alert sheet (prototype `alert` sheet, "see it, then decide - nothing preselected"): the alert tag,
// what fired and when, the facts of the position, the thesis with the research verdict, the strategy's
// drawdown line and the decision (Nothing / Buy more / Sell, an optional reason), with "Decide later" and
// "Save decision" in the footer. Save stays disabled until a choice. The bell left of the close button
// marks the alert "tell this phone" (accent while marked).
import {
  Button,
  Delta,
  EmptyState,
  Facts,
  type FactsItem,
  GroupSection,
  Icon,
  Money as MoneyValue,
  NoteLine,
  Seg,
  Tag,
  TextField,
} from "@cashu/ui/native";
import type { ReactNode } from "react";
import { ScrollView, Text, View } from "react-native";
import { S } from "./Alert.strings";
import type { AlertFact, AlertSheetState } from "./useAlertSheet";

export type AlertSheetViewProps = AlertSheetState;
type Ready = Extract<AlertSheetState, { kind: "ready" }>;

function Quote({ children }: { children: ReactNode }) {
  return (
    <View className="rounded-xl bg-subtle p-4">
      <Text className="text-body text-fg-secondary">{children}</Text>
    </View>
  );
}

function CloseButton({ onClose }: { onClose(): void }) {
  return (
    <Button variant="glyph" label={S.close} onPress={onClose}>
      <Icon name="x" size={20} />
    </Button>
  );
}

function factItem(fact: AlertFact): FactsItem {
  switch (fact.kind) {
    case "text":
      return {
        label: fact.label,
        value: fact.value,
        ...(fact.detail === undefined ? {} : { detail: fact.detail }),
      };
    case "money":
      return {
        label: fact.label,
        value: <MoneyValue value={fact.value} size="title" weight="strong" fractionDigits={0} />,
        ...(fact.detail === undefined ? {} : { detail: fact.detail }),
      };
    case "percent":
      return {
        label: fact.label,
        value: <Delta kind="percent" value={fact.value} size="title" weight="strong" />,
        ...(fact.detail === undefined ? {} : { detail: fact.detail }),
      };
    case "note":
      return {
        label: fact.label,
        value: (
          <Text numberOfLines={4} className="text-body font-demi text-fg">
            {fact.value}
          </Text>
        ),
      };
  }
}

function Thesis({ props }: { props: Ready }) {
  const { thesis } = props;
  if (thesis === null || (thesis.wrongIf === null && thesis.researchLine === null)) return null;
  const research = thesis.researchLine;
  return (
    <GroupSection grouped={false} title={S.yourThesis}>
      {thesis.wrongIf !== null && (
        <Quote>
          <Text className="font-strong text-fg">{S.wrongIf} </Text>
          {thesis.wrongIf}
        </Quote>
      )}
      {research !== null && (
        <View className="flex-row flex-wrap items-center gap-1.5 px-1">
          <Text className="text-caption text-fg-muted">{research.lead}</Text>
          <Tag tone={research.tone}>{research.verdict}</Tag>
          <Text className="shrink text-caption text-fg-muted">{research.text}</Text>
        </View>
      )}
    </GroupSection>
  );
}

function Decision({ props }: { props: Ready }) {
  const { decision } = props;
  if (decision === null) return null;
  return (
    <GroupSection grouped={false} title={S.yourDecision}>
      <Seg
        full
        label={S.yourDecision}
        items={[
          [S.choiceHeld, "held"],
          [S.choiceBought, "bought"],
          [S.choiceSold, "sold"],
        ]}
        value={decision.choice}
        onChange={(value) => {
          if (value !== null) decision.onPick(value);
        }}
      />
      <TextField
        label={S.reason}
        labelHidden
        placeholder={S.reason}
        value={decision.reason}
        onChange={decision.onReason}
        multiline
        rows={2}
        maxLength={500}
      />
      {decision.error !== null && (
        <Text accessibilityLiveRegion="polite" className="px-1 text-caption text-negative">
          {decision.error}
        </Text>
      )}
    </GroupSection>
  );
}

export function AlertSheetView(props: AlertSheetViewProps) {
  if (props.kind === "missing") {
    return (
      <View className="flex-1 bg-surface px-4 pt-6">
        <View className="items-end">
          <CloseButton onClose={props.onClose} />
        </View>
        <EmptyState icon="bell" title={S.missing} />
      </View>
    );
  }
  const { decision } = props;
  // The ScrollView is the sheet's root and the footer ends its content: a react-native-screens formSheet
  // on iOS sizes only a root ScrollView, so a flex-1 ScrollView inside a wrapper View laid out at zero
  // height and left the sheet blank above the footer.
  return (
    <ScrollView className="flex-1 bg-surface" contentContainerClassName="gap-5 px-4 pt-6 pb-10">
      <View className="flex-row items-center justify-between gap-3">
        <Tag tone={props.tag.tone}>{props.tag.text}</Tag>
        <View className="flex-row items-center">
          {props.tellPhone !== null && (
            <Button
              variant="glyph"
              pressed={props.tellPhone.on}
              label={props.tellPhone.on ? S.stopTelling : S.tellPhone}
              onPress={props.tellPhone.onToggle}
            >
              <Icon name="bell" size={20} />
            </Button>
          )}
          <CloseButton onClose={props.onClose} />
        </View>
      </View>
      <View className="gap-1.5">
        <Text role="heading" className="text-headline font-strong text-fg">
          {props.title}
        </Text>
        <Text className="text-caption text-fg-muted">{props.meta}</Text>
      </View>
      {props.facts.length > 0 && <Facts items={props.facts.map(factItem)} />}
      <Thesis props={props} />
      {props.strategyLine !== null && (
        <GroupSection grouped={false} title={S.strategySays}>
          <Quote>{props.strategyLine}</Quote>
        </GroupSection>
      )}
      {props.settled !== null && (
        <NoteLine icon={decision === null ? "check" : "calendar"}>{props.settled}</NoteLine>
      )}
      <Decision props={props} />
      <NoteLine icon="shield">{S.decisionIsANote}</NoteLine>
      {decision !== null && (
        <View className="flex-row gap-2 border-t border-border pt-3">
          {decision.canLater && (
            <Button
              variant="secondary"
              block
              className="flex-1"
              disabled={decision.isSaving}
              onPress={props.onLater}
            >
              {S.later}
            </Button>
          )}
          <Button
            variant="primary"
            block
            className="flex-1"
            disabled={!decision.canSave}
            onPress={props.onSave}
          >
            {S.save}
          </Button>
        </View>
      )}
    </ScrollView>
  );
}
