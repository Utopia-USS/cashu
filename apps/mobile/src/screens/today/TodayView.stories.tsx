// Pure presentation variants of the Today tab, all invented (the prototype's Thu 12 Nov 2026). Store-backed
// integration lives in today.native.test.tsx.
import { D, Money } from "@cashu/domain";
import { UiEnvProvider } from "@cashu/ui/native";
import type { ComponentType } from "react";
import { Planned, WithoutInvesting } from "../monthClosed/MonthClosedView.stories";
import { TodayView } from "./TodayView";
import type { TodayReady, TodayState } from "./today-contracts";

const pln = (amount: string) => new Money(D(amount), "PLN");

const ownerPace = {
  spentShare: 0.455,
  usualShare: 0.489,
  left: "Spending vs a usual month",
  right: "PLN 440 under usual so far",
  rightTone: "positive",
} as const;

const owner: TodayReady = {
  kind: "ready",
  header: {
    profile: { initial: "A", name: "Anna" },
    fresh: { tone: "ok", text: "Bank data from 06:40" },
    offline: null,
    incognito: false,
    onProfilePress: () => {},
    onIncognitoToggle: () => {},
  },
  title: "November",
  banner: null,
  stale: false,
  sync: { line: null, notice: null },
  hero: {
    label: "On track to keep",
    daysLeftLabel: "18 days to go",
    keep: pln("2140.00"),
    negative: false,
    subLine: "by November 30, if the rest of the month goes like usual",
    pace: ownerPace,
    kpis: [
      { label: "Income", value: pln("14800.00") },
      { label: "Spent", value: pln("5960.00") },
      { label: "Bills still due", value: pln("5240.00") },
    ],
  },
  attention: [
    {
      key: "payee:netflix",
      icon: "calendar",
      tone: "default",
      title: "Netflix costs more",
      sub: "PLN 49.00 to PLN 60.00, from November 13",
      magnitude: "+PLN 132",
      magnitudeLabel: "a year",
      onPress: null,
    },
  ],
  upcoming: [
    {
      key: "netflix",
      date: "2026-11-13",
      payee: "Netflix",
      amount: pln("-49.00"),
      account: "mBank Personal",
      covered: null,
    },
    {
      key: "share",
      date: "2026-11-15",
      payee: "Share to the Home account",
      amount: pln("-4800.00"),
      account: "mBank Personal",
      covered: true,
    },
    {
      key: "spotify",
      date: "2026-11-16",
      payee: "Spotify Family",
      amount: pln("-37.99"),
      account: "Erste Account",
      covered: null,
    },
  ],
  total: pln("-4886.99"),
  spent: {
    rows: [
      {
        category: "groceries",
        label: "Groceries",
        amount: pln("1412.30"),
        share: 1,
        swatch: "palette-1",
      },
      {
        category: "travel",
        label: "Travel",
        amount: pln("1286.00"),
        share: 0.91,
        swatch: "palette-2",
      },
      {
        category: "shopping",
        label: "Shopping",
        amount: pln("920.45"),
        share: 0.65,
        swatch: "palette-3",
      },
      {
        category: "transport",
        label: "Transport",
        amount: pln("642.15"),
        share: 0.45,
        swatch: "palette-4",
      },
    ],
    more: { count: 5, amount: pln("1699.10") },
  },
  uncategorized: { count: 4, sum: pln("315.59") },
  note: "Bank data comes from your Mac once a day - this phone never asks your bank on its own. Prices it fetches itself. Showing PLN; your EUR accounts are on Net worth.",
  onHeroPressed: () => {},
  onSpentPressed: () => {},
  onUncategorizedPressed: () => {},
};

const partner: TodayReady = {
  ...owner,
  header: { ...owner.header, profile: { initial: "H", name: "Home" } },
  hero: {
    ...owner.hero,
    keep: pln("910.00"),
    pace: {
      ...ownerPace,
      right: "PLN 210 under usual so far",
    },
    kpis: [
      { label: "Income", value: pln("9600.00") },
      { label: "Spent", value: pln("3410.00") },
      { label: "Bills still due", value: pln("2797.00") },
    ],
  },
  attention: [],
  upcoming: [
    {
      key: "mortgage",
      date: "2026-11-15",
      payee: "Mortgage installment",
      amount: pln("-2431.18"),
      account: "Erste Joint account",
      covered: true,
    },
  ],
  total: pln("-2431.18"),
  uncategorized: { count: 2, sum: pln("303.10") },
  note: "Bank data comes from your Mac once a day - this phone never asks your bank on its own. Prices it fetches itself.",
};

const threeRows: TodayReady = {
  ...owner,
  attention: [
    {
      key: "uncategorized:uncategorized",
      icon: "tag",
      tone: "warn",
      title: "PLN 2,496 not categorized",
      sub: "mostly IKEA, Tue, Nov 10 · your projection may be off",
      magnitude: "31%",
      magnitudeLabel: "of spending",
      onPress: () => {},
    },
    {
      key: "bill:gym",
      icon: "calendar",
      tone: "neg",
      title: "Not enough money for CityFit gym",
      sub: "due November 18 from Erste Account",
      magnitude: "PLN 59",
      magnitudeLabel: "short",
      onPress: null,
    },
    ...owner.attention,
  ],
  uncategorized: null,
};

const stale: TodayReady = {
  ...owner,
  header: {
    ...owner.header,
    fresh: { tone: "warn", text: "Bank data from Mon 07:30 · 3 days old" },
  },
  banner: {
    tone: "warning",
    title: "Bank data is 3 days old",
    body: "It is fetched once a day when the Mac is awake and online; prices still come live to this phone. Open it to catch up - nothing to do on this phone.",
  },
  stale: true,
  hero: {
    ...owner.hero,
    subLine: "by November 30, if the rest of the month goes like usual · as of Monday",
    pace: { ...ownerPace, right: "pace as of Monday", rightTone: "default" },
  },
};

const overUsual: TodayReady = {
  ...owner,
  hero: {
    ...owner.hero,
    keep: pln("-320.00"),
    negative: true,
    subLine:
      "by November 30, if the rest of the month goes like usual · incl. your usual pay on the 10th",
    pace: {
      ...ownerPace,
      spentShare: 0.6,
      right: "PLN 120 over usual so far",
      rightTone: "default",
    },
  },
};

const empty: TodayReady = {
  ...owner,
  hero: { ...owner.hero, keep: pln("0.00"), pace: null },
  attention: [],
  upcoming: [],
  total: null,
  spent: { rows: [], more: null },
  uncategorized: null,
};

const privacy = (Story: ComponentType) => (
  <UiEnvProvider locale="en-US" privacy>
    <Story />
  </UiEnvProvider>
);

const meta = { title: "Mobile/Today", component: TodayView, args: { state: owner } };
export default meta;

export const Owner = { args: { state: owner } };
export const Partner = { args: { state: partner } };
export const Stale = { args: { state: stale } };
export const ThreeAttentionRows = { args: { state: threeRows } };
export const NoAttention = { args: { state: { ...owner, attention: [] } satisfies TodayState } };
export const OverUsual = { args: { state: overUsual } };
export const Empty = { args: { state: empty } };
export const Incognito = { args: { state: owner }, decorators: [privacy] };
export const ClosedWithPlan = {
  args: { state: { kind: "closed", month: "2026-10", ...Planned.args } satisfies TodayState },
};
export const ClosedWithoutInvesting = {
  args: {
    state: { kind: "closed", month: "2026-10", ...WithoutInvesting.args } satisfies TodayState,
  },
};

// Sync in the banner slot (#25.2-4, the replay line, #23.7).
const noop = () => {};
export const SyncPaused = {
  args: {
    state: {
      ...owner,
      sync: {
        line: { text: "Sync paused since 10:12 · cashU works as usual", tone: "muted" },
        notice: null,
      },
    } satisfies TodayState,
  },
};
export const SyncQuota = {
  args: {
    state: {
      ...owner,
      sync: {
        line: { text: "Today's sync limit is used up, tries again after midnight", tone: "muted" },
        notice: null,
      },
    } satisfies TodayState,
  },
};
export const SyncStuckWaiting = {
  args: {
    state: {
      ...owner,
      sync: {
        line: {
          text: "Some changes from Anna's MacBook can't be read yet. Sync keeps trying.",
          tone: "muted",
        },
        notice: null,
      },
    } satisfies TodayState,
  },
};
export const SyncStuckFailed = {
  args: {
    state: {
      ...owner,
      sync: {
        line: {
          text: "Changes from Anna's MacBook can't be read. Check Devices on your Mac.",
          tone: "warning",
        },
        notice: null,
      },
    } satisfies TodayState,
  },
};
export const SyncReplay = {
  args: {
    state: {
      ...owner,
      sync: { line: { text: "Checking this phone's copy · 40%", tone: "muted" }, notice: null },
    } satisfies TodayState,
  },
};
export const SyncRemoved = {
  args: {
    state: {
      ...owner,
      sync: {
        line: null,
        notice: {
          title: "This phone was removed from Anna on your Mac",
          body: "The copy stays on this phone until you remove it.",
          actions: [{ label: "Remove this copy", tone: "danger", onPress: noop }],
          failed: false,
        },
      },
    } satisfies TodayState,
  },
};
export const SyncTurnedOff = {
  args: {
    state: {
      ...owner,
      sync: {
        line: null,
        notice: {
          title:
            "Sync for Anna was turned off on your Mac. The copy on this phone stays until you remove it.",
          body: null,
          actions: [
            { label: "Remove this copy", tone: "danger", onPress: noop },
            { label: "Keep for now", tone: "secondary", onPress: noop },
          ],
          failed: false,
        },
      },
    } satisfies TodayState,
  },
};
