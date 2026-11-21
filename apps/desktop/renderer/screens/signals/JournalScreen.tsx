// The mountable ported decision journal page (ab24ab6 v2/Journal.tsx, the Home's `journal` sub-route).
import { JournalView } from "./JournalView.js";
import { type JournalInput, useJournal } from "./useJournal.js";

export type { JournalInput };

export function JournalScreen(props: JournalInput) {
  return <JournalView {...useJournal(props)} />;
}
