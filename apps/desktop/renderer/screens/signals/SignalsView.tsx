import { Button } from "@cashu/ui";
import type { ReactNode } from "react";
import { DecisionDialogView } from "./DecisionDialogView.js";
import { pageTitle } from "./labels.js";
import { G } from "./Signals.strings.js";
import { SignalsListView } from "./SignalsListView.js";
import { SignalsNoticeView } from "./SignalsNoticeView.js";
import type { SignalsFeedback } from "./useSignalsFeedback.js";
import type { SignalsPageKind, SignalsScreenState } from "./useSignalsScreen.js";

/** The full Signals dialog and the decision dialog over whatever screen owns the Signals state. */
export function SignalsDialogView({ state }: { state: SignalsScreenState }) {
  const { open, ...list } = state.list;
  return (
    <>
      {open && (
        <SignalsListView
          {...list}
          notice={state.feedback.notice}
          refusal={state.feedback.refusal}
        />
      )}
      <DecisionDialogView {...state.decision} />
    </>
  );
}

/** One Signals page (Alerts, Watchlist or Journal): back link, write feedback, the page and dialogs. */
export function SignalsPageView({
  page,
  available,
  privacy,
  feedback,
  onBack,
  onUndoLast,
  dialogs,
  children,
}: {
  page: SignalsPageKind;
  /** False while the snapshot is unavailable (privacy mode or no data). */
  available: boolean;
  privacy: boolean;
  feedback: SignalsFeedback;
  onBack?: () => void;
  onUndoLast(): void;
  /** The Signals and decision dialogs, rendered over the page. */
  dialogs?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="grid gap-4 p-6" data-testid={`native-signals-${page}`}>
      <header className="flex flex-wrap items-center gap-3">
        <Button onPress={onBack}>{G.portfolio}</Button>
        <h1 className="text-headline font-strong">{pageTitle(page)}</h1>
      </header>
      <SignalsNoticeView notice={feedback.notice} refusal={feedback.refusal} />
      {feedback.undoIds.length > 0 && <Button onPress={onUndoLast}>{G.undo}</Button>}
      {available ? children : <p>{privacy ? G.privacy : G.unavailable}</p>}
      {dialogs}
    </main>
  );
}
