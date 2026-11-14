// Pure presentation variants of the Investments tab's Signals view, all invented. Store-backed
// integration lives in investments.native.test.tsx.
import type { SignalsViewProps } from "../investments-contracts";
import { SignalsView } from "./SignalsView";

const ready: SignalsViewProps = {
  status: "ready",
  since: "New since your review on Sun, Nov 8",
  fired: [
    {
      gid: "s1",
      title: "CD Projekt fell 9.4% in 5 sessions",
      sub: "risk · 07:31 · waiting for a decision",
      decided: false,
      marked: true,
    },
    // An info alert reads as a fact: it does not wait for a decision.
    {
      gid: "s2",
      title: "CDR below its 5-session average",
      sub: "CD Projekt closed below its 5-session average (PLN 214.60 vs PLN 223.33)",
      decided: false,
      marked: false,
    },
  ],
  near: [
    {
      gid: "a1",
      name: "Vanguard Total World",
      price: "USD 111.40",
      level: "alert below USD 110.00",
      distance: "1.3% away",
    },
  ],
  rules: [
    {
      gid: "r1",
      message: "CDR: 7.5% of the portfolio (max 5.0%).",
      sub: "risk · 07:31",
      tone: "negative",
    },
  ],
  research: [
    {
      gid: "n1",
      title: "Q3 and the 2027 slate",
      tag: "weakens your thesis",
      tone: "negative",
      sub: "weakens your thesis · 4 sources",
    },
    {
      gid: "n2",
      title: "Polish bonds after the rate cut",
      tag: "background",
      tone: "neutral",
      sub: "background · 2 sources",
    },
  ],
  researchDay: "Nov 7",
  decisions: [
    {
      gid: "d1",
      title: "Beta ETF S&P 500 - bought more",
      dateLabel: "Nov 10",
      reason: "monthly plan",
    },
    { gid: "d2", title: "Polish Bond ETF - nothing", dateLabel: "Nov 2", reason: null },
  ],
  onAlertPressed: () => {},
  onNotePressed: () => {},
};

const meta = { title: "Mobile/Investments/Signals", component: SignalsView, args: ready };
export default meta;

export const Ready = { args: ready };
export const Decided = {
  args: {
    ...ready,
    fired: [
      {
        gid: "s1",
        title: "CD Projekt - noted",
        sub: "Decide later - back in your review",
        decided: true,
        marked: false,
      },
    ],
  } satisfies SignalsViewProps,
};
export const Quiet = {
  args: {
    ...ready,
    since: "New in the last week",
    fired: [],
    near: [],
    rules: [],
    research: [],
    researchDay: null,
  } satisfies SignalsViewProps,
};
export const Unavailable = {
  args: {
    status: "unavailable",
    message: "Signals cannot be read on this phone right now.",
  } satisfies SignalsViewProps,
};
