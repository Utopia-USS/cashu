import { ResearchPageView } from "./ResearchPageView.js";
import type { ResearchPageModel } from "./researchPageModel.js";

const ui = { onBack() {}, onTab() {}, onSettings() {}, onHow() {} };
const runNow = {
  command: "cd ~/cashU/demo && claude",
  label: "Run now",
  primary: false,
  showCommand: false,
  size: "md" as const,
  onCopy() {},
};
const story: ResearchPageModel = {
  runNow,
  body: {
    kind: "story",
    head: {
      story: "Saturday's research covered 3 positions and 2 topics.",
      sents: [{ text: "nothing waits for a decision", tone: "" }],
      next: "next research: Sat 7.11, 07:00",
      tabs: [
        { key: "topics", label: "Topics", selected: false },
        { key: "runs", label: "Runs", selected: true },
      ],
    },
    tab: {
      kind: "runs",
      count: "last 1",
      rows: [
        {
          id: 1,
          date: "2026-11-02 11:00",
          status: { text: "finished", tone: "pos" },
          scope: "positions, watchlist",
          notes: "4",
          signals: "1",
          time: "28 min",
          by: "routine · Claude Code",
        },
      ],
      scope: {
        line: "3 positions, 2 watched",
        rest: ", candidates by the strategy entry criteria, topics",
        privacy: "level strict · weights and theses, no amounts or accounts",
        path: "~/cashU/demo",
      },
    },
  },
};

export default {
  title: "Desktop/Research/ResearchPage",
  component: ResearchPageView,
  args: { model: story, ui },
};
export const Ready = {};
export const NeverRan = {
  args: {
    model: {
      runNow,
      body: {
        kind: "empty",
        empty: {
          steps: [
            {
              key: "run",
              status: "on",
              title: { kind: "text", text: "Run the first research in Claude Code" },
              hint: { kind: "text", text: "about 30 min" },
              tag: null,
              action: null,
            },
          ],
          schedule: null,
        },
      },
    } satisfies ResearchPageModel,
    ui,
  },
};
