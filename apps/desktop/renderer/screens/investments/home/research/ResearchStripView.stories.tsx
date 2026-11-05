import { ResearchStripView } from "./ResearchStripView.js";
import type { ResearchStripProps } from "./researchStripModel.js";

const args: ResearchStripProps = {
  kind: "story",
  count: "Mon 2.11",
  allLabel: "All · 3 notes",
  onAll() {},
  lead: "A synthetic market sentence.",
  chips: [
    {
      key: "risk",
      label: "Risk",
      state: "calm",
      tone: "calm",
      fresh: true,
      brief: { headline: "A synthetic brief", why: "Why it matters." },
      plain: null,
      onMore() {},
    },
  ],
  aheadSay: "A quiet week.",
  days: [
    {
      date: "2026-11-03",
      day: "3.11",
      weekday: "Tue",
      groups: [{ topic: "Tech", earnings: [{ text: "Synthetic Co", mine: true }], other: [] }],
      market: null,
      mine: "1 of yours",
    },
  ],
  weak: null,
  topics: [
    {
      key: "tech",
      label: "Tech",
      mood: { word: "calm", tone: "calm" },
      headline: "A synthetic topic headline",
      impact: "+0.4 pp",
      now: "Now text.",
      outlook: "",
      valuation: null,
      notes: [],
      onWholeTopic() {},
    },
  ],
  quiet: null,
  drafts: null,
};

export default { title: "Desktop/Investments/ResearchStrip", component: ResearchStripView, args };
export const Story = {};
