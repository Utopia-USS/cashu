// Pure weekly review deck (prototype `review`): on the dark stage, the modal bar (close without saving,
// the title, back to the previous card), the progress with the flagged cards in the warning tone, the
// card stack (swipe right = got it, left = come back to this; right is blocked on the decide card until
// every item has a choice, so the stack is off then) and the footer buttons; after the last card the
// summary with "Mark review done" (nothing flagged) or "Done" (the review saved with its agenda).
import { Button, EmptyState, Icon, ProgressDots, SwipeStack } from "@cashu/ui/native";
import { Text, useWindowDimensions, View } from "react-native";
import { CalendarCard } from "./cards/CalendarCard";
import { CardShell } from "./cards/CardShell";
import { DecideCard } from "./cards/DecideCard";
import { EventsCard } from "./cards/EventsCard";
import { IdeasCard } from "./cards/IdeasCard";
import { PositionsCard } from "./cards/PositionsCard";
import { SectorsCard } from "./cards/SectorsCard";
import { SummaryCard } from "./cards/SummaryCard";
import { WorldCard } from "./cards/WorldCard";
import { S } from "./Review.strings";
import type { CardBody, DeckProgress, ReviewDeckState } from "./useReviewDeck";

export type ReviewDeckViewProps = ReviewDeckState;

/** Room the chrome takes around the stage (bar, progress, footer, gaps), in points. */
const CHROME = 230;
const MIN_STAGE = 320;

function ModalBar({ onClose, onBack }: { onClose(): void; onBack: (() => void) | null }) {
  return (
    <View className="min-h-11 flex-row items-center justify-between gap-3 px-4 py-2">
      <Button variant="glyph" label={S.close} onPress={onClose}>
        <Icon name="x" size={20} />
      </Button>
      <Text role="heading" className="shrink text-headline font-strong text-fg">
        {S.weeklyReview}
      </Text>
      {onBack === null ? (
        <View className="size-11" />
      ) : (
        <Button variant="glyph" label={S.back} onPress={onBack}>
          <Icon name="chevron-left" size={20} />
        </Button>
      )}
    </View>
  );
}

function Progress({ progress }: { progress: DeckProgress }) {
  return (
    <View className="px-4">
      <ProgressDots total={progress.total} done={progress.done} flagged={progress.flagged} />
    </View>
  );
}

function Body({ body }: { body: CardBody }) {
  switch (body.kind) {
    case "world":
      return <WorldCard body={body} />;
    case "sectors":
      return <SectorsCard body={body} />;
    case "positions":
      return <PositionsCard body={body} />;
    case "events":
      return <EventsCard body={body} />;
    case "ideas":
      return <IdeasCard body={body} />;
    case "calendar":
      return <CalendarCard body={body} />;
    case "decide":
      return <DecideCard body={body} />;
  }
}

/** The card's foot line: where its content comes from, when the phone shows only part of it. */
function sourceOf(body: CardBody): string | undefined {
  if (body.kind === "events") return S.fullNoteOnMac;
  if (body.kind === "ideas") return S.ideasSource;
  return undefined;
}

export function ReviewDeckView(props: ReviewDeckViewProps) {
  const { height } = useWindowDimensions();
  const stage = Math.max(MIN_STAGE, height - CHROME);
  if (props.kind === "unavailable")
    return (
      <View className="flex-1 bg-surface-sunken">
        <ModalBar onClose={props.onClose} onBack={null} />
        <View className="flex-1 justify-center px-6">
          <EmptyState icon="calendar" title={S.unavailable} body={S.unavailableBody} />
        </View>
      </View>
    );

  if (props.kind === "summary")
    return (
      <View className="flex-1 gap-4 bg-surface-sunken pb-4">
        <ModalBar onClose={props.onClose} onBack={props.onBack} />
        <Progress progress={props.progress} />
        <View className="px-4" style={{ height: stage }}>
          <SummaryCard summary={props.summary} />
        </View>
        {props.error !== null && (
          <Text accessibilityLiveRegion="polite" className="px-4 text-caption text-negative">
            {props.error}
          </Text>
        )}
        <View className="px-4">
          <Button variant="primary" block pending={props.isSaving} onPress={props.onDone}>
            {props.primaryLabel}
          </Button>
        </View>
      </View>
    );

  const { card } = props;
  return (
    <View className="flex-1 gap-4 bg-surface-sunken pb-4">
      <ModalBar onClose={props.onClose} onBack={props.onBack} />
      <Progress progress={props.progress} />
      <View className="px-4">
        <SwipeStack
          height={stage}
          enabled={!props.isSaving}
          canSwipeRight={props.canKeep}
          onSwiped={(direction) => void (direction === "right" ? props.onKeep() : props.onFlag())}
          swipeLeftLabel={S.flag}
          swipeRightLabel={props.keepLabel}
          {...(props.next === null
            ? {}
            : { behind: <CardShell eyebrow={props.next.eyebrow} title={props.next.title} /> })}
        >
          <CardShell
            eyebrow={card.eyebrow}
            step={props.step}
            title={card.title}
            {...(sourceOf(card.body) === undefined ? {} : { source: sourceOf(card.body) })}
          >
            <Body body={card.body} />
          </CardShell>
        </SwipeStack>
      </View>
      {props.error !== null && (
        <Text accessibilityLiveRegion="polite" className="px-4 text-caption text-negative">
          {props.error}
        </Text>
      )}
      <View className="flex-row gap-2 px-4">
        <Button
          variant="secondary"
          className="flex-1"
          disabled={props.isSaving}
          onPress={props.onFlag}
        >
          {S.flag}
        </Button>
        <Button
          variant="primary"
          className="flex-1"
          disabled={!props.canKeep}
          pending={props.isSaving}
          onPress={props.onKeep}
        >
          {props.keepLabel}
        </Button>
      </View>
    </View>
  );
}
