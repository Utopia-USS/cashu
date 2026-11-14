// Stories of the research note reader (CSF 3, invented text): a note that weakens the thesis with the
// paragraph quoting it set apart, a background note without a verdict, a link the phone does not open
// and a note that is gone.
import { NoteView, type NoteViewProps } from "./NoteView";

type Ready = Extract<NoteViewProps, { kind: "ready" }>;

const weakens: Ready = {
  kind: "ready",
  tag: { text: "weakens your thesis", tone: "negative" },
  meta: "Quux Games · news · Nov 7, 2026",
  title: "Q3 and the 2027 slate",
  blocks: [
    {
      key: "0",
      kind: "p",
      text: "Third-quarter revenue came in close to expectations; the back catalogue carried the quarter.",
    },
    {
      key: "1",
      kind: "quote",
      text: "Your thesis is wrong if the 2027 release slips again. Not yet: one report suggests a delay.",
    },
    {
      key: "2",
      kind: "p",
      text: "What to watch: the Q4 call on 26 November and any update on the release window.",
    },
  ],
  sources: [
    { key: "a", title: "Company Q3 report and call transcript - Nov 5, 2026", onPress: () => {} },
    { key: "b", title: "Industry news site - Nov 6, 2026", onPress: () => {} },
  ],
  byAgent: true,
};

const meta = { title: "Mobile/Investments/Note", component: NoteView, args: weakens };
export default meta;

export const WeakensThesis = { args: {} };

export const Background = {
  args: {
    tag: { text: "background", tone: "neutral" },
    meta: "usd_pln · macro · Nov 6, 2026",
    title: "USD/PLN: what moved it this month",
    blocks: [
      {
        key: "0",
        kind: "p",
        text: "The dollar lost ground against the zloty this month as the rate gap narrowed.",
      },
    ],
    sources: [{ key: "a", title: "Table A mid rates - Nov 6, 2026", onPress: null }],
  },
};

export const WrittenByYou = { args: { byAgent: false, sources: [] } };

export const Missing = { args: { kind: "missing" } };
