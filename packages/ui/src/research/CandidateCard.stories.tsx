import type { Meta, Story } from "../charts/testing/csf.js";
import { CandidateCard, type CandidateCardProps } from "./CandidateCard.js";

const meta = {
  title: "Research/CandidateCard",
  component: CandidateCard,
  args: {
    id: 1,
    name: "Synthetic Corp",
    monogram: "SYN",
    sub: "NASDAQ",
    entry: "growth",
    criteria: [
      { text: "P/E 14 (threshold 20)", met: true, mark: "met" },
      { text: "debt / equity 1.4 (threshold 1)", met: false, mark: "not met" },
    ],
    context: "Fits the strategy's entry criteria.",
    title: "Synthetic Corp as a candidate",
    state: {
      kind: "open",
      watch: { label: "Watch", title: "Add to the watchlist", onPress: () => {} },
      dismiss: { label: "Dismiss", title: "Hide for 90 days", onPress: () => {} },
    },
    sources: "2 sources · 3.11",
  },
} satisfies Meta<CandidateCardProps>;
export default meta;
export const Open: Story<CandidateCardProps> = {};
export const Watched: Story<CandidateCardProps> = {
  args: { state: { kind: "watched", label: "watched since 2.11" } },
};
export const Dismissed: Story<CandidateCardProps> = {
  args: { dismissed: { tag: "dismissed 1.11", line: "Synthetic Corp as a candidate" } },
};
