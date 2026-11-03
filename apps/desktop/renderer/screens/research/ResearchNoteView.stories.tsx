import { UiEnvProvider } from "@cashu/ui";
import { researchNoteDates, researchNoteFacts } from "./presentation.js";
import { type ResearchNote, ResearchNoteView } from "./ResearchNoteView.js";

const note = {
  id: "a".repeat(32),
  title: "Synthetic market report",
  summary: "A synthetic report for layout verification.",
  observed_at: "2026-10-31T12:00:00Z",
  expires_at: "2026-11-30T12:00:00Z",
  created_by: "agent",
  sources: [
    { title: "Synthetic source", url: "https://example.com/synthetic", publisher: "Example" },
  ],
  details: { context: "Synthetic context", criteria: [{ text: "Synthetic criterion", met: true }] },
  kind: "news",
  candidate: null,
  instrument_id: "b".repeat(32),
  segment: "energy",
  unread: true,
  expired: false,
  dismissed: false,
} as unknown as ResearchNote;
export default {
  title: "Desktop/Investments/ResearchNote",
  component: ResearchNoteView,
  decorators: [
    (Story: () => React.ReactNode) => (
      <UiEnvProvider locale="en-US" privacy={false}>
        <Story />
      </UiEnvProvider>
    ),
  ],
  args: {
    note,
    dates: researchNoteDates(note),
    facts: researchNoteFacts(note),
    privacy: false,
    onClose: () => {},
  },
};
export const Ready = {};
export const Privacy = {
  args: {
    note,
    dates: researchNoteDates(note),
    facts: researchNoteFacts(note),
    privacy: true,
    onClose: () => {},
  },
};
export const Dismissed = {
  args: {
    note: { ...note, dismissed: true },
    dates: researchNoteDates(note),
    facts: researchNoteFacts(note),
    privacy: false,
    onClose: () => {},
    onRestore: () => {},
  },
};
