import { UiEnvProvider } from "@cashu/ui";
import { ResearchView } from "./ResearchView.js";
import type { ResearchScreenState } from "./useResearchScreen.js";

const noop = () => {};
const empty = {
  data: {
    status: "current",
    revision: "synthetic",
    notes: [],
    runs: [],
    lastRun: null,
    positions: [],
    positionStatus: { status: "current" },
    summary: { status: "unavailable", reason: "market_unavailable" },
    topics: [],
    segments1w: { status: "unavailable", reason: "market_unavailable" },
    segments4w: { status: "unavailable", reason: "market_unavailable" },
    macro: { status: "unavailable", reason: "source_unbound" },
    calendar: { status: "unavailable", reason: "source_unbound" },
    digest: {
      value: {},
      macro: { status: "unavailable", reason: "source_unbound" },
      segments: { status: "unavailable", reason: "market_unavailable" },
    },
    workspace: { status: "unavailable", reason: "source_unbound" },
  },
  privacy: false,
  tab: "topics",
  setTab: noop,
  topic: null,
  setTopic: noop,
  note: null,
  setNote: noop,
  notice: null,
  visible: 15,
  showMore: noop,
  noteFilter: "all",
  setNoteFilter: noop,
  topicForm: { thesis: "", invalidation: "", assessment: "", outlook: "" },
  setTopicForm: noop,
  topicRecord: null,
  saveTopic: noop,
  copyRun: noop,
  onBack: noop,
  onSettings: noop,
  openTopic: noop,
  openAsset: noop,
  openNote: noop,
  dismiss: noop,
  restore: noop,
  accept: noop,
  undoAccept: noop,
  busy: false,
} as unknown as ResearchScreenState;

export default {
  title: "Desktop/Investments/Research",
  component: ResearchView,
  decorators: [
    (Story: () => React.ReactNode) => (
      <UiEnvProvider locale="en-US" privacy={false}>
        <Story />
      </UiEnvProvider>
    ),
  ],
  args: { state: empty },
};
export const BeforeFirstRun = {};
export const Notes = { args: { state: { ...empty, tab: "notes" } } };
export const CalendarUnavailable = { args: { state: { ...empty, tab: "calendar" } } };
export const Candidates = { args: { state: { ...empty, tab: "candidates" } } };
export const Runs = { args: { state: { ...empty, tab: "runs" } } };
export const Privacy = { args: { state: { ...empty, privacy: true } } };
export const Partial = {
  args: {
    state: {
      ...empty,
      data: {
        status: "partial",
        reason: "market_unavailable",
        notes: [],
        runs: [],
        lastRun: null,
        workspace: { status: "unavailable", reason: "source_unbound" },
      },
    },
  },
};
