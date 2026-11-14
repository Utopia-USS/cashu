// The alert sheet's hook and View over the synthetic investments vault (the companion fixture's own
// builders: CD Projekt's -8% alert fired by one daily evaluation, its thesis, Saturday's research): what
// fired, Save disabled until a choice, a decision written as `decision.recorded` that closes the sheet,
// "Decide later" as an acknowledgement, the strategy's drawdown line, the bell that marks the alert for
// this phone; and every story of the View.
// The calendar is pinned to Thu 12 Nov 2026.
import { setLanguageForTests } from "@cashu/i18n";
import { markedAlerts, notificationPrefs } from "@cashu/store/device";
import type { Read } from "@cashu/store/query";
import { ProfileProvider, StoreProvider, useProfile } from "@cashu/store-react";
import { UiEnvProvider } from "@cashu/ui/native";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react-native";
import { type ComponentType, type ReactNode, useEffect } from "react";
import { ServicesProvider } from "../../services/ServicesProvider";
import { type InvestmentsStore, investmentsStore } from "../testing/investmentsStore";
import { AlertSheetView } from "./AlertSheetView";
import alertMeta, {
  ChoiceMade,
  CouldNotSave,
  Decided,
  Fired,
  Incognito,
  Missing,
  RuleWithoutThesis,
  SetAsideForReview,
  TellsThisPhone,
} from "./AlertSheetView.stories";
import { drawdownLine } from "./strategyLine";
import { type AlertSheetState, useAlertSheet } from "./useAlertSheet";

jest.mock("@expo/ui", () => require("../testing/expoUiMock").default);

const NOT_DATE = [
  "hrtime",
  "nextTick",
  "performance",
  "queueMicrotask",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "requestIdleCallback",
  "cancelIdleCallback",
  "setImmediate",
  "clearImmediate",
  "setInterval",
  "clearInterval",
  "setTimeout",
  "clearTimeout",
] as const;

const closers: (() => void)[] = [];
beforeEach(() => {
  jest.useFakeTimers({ now: new Date(2026, 10, 12, 9, 45), doNotFake: [...NOT_DATE] });
  setLanguageForTests("en");
});
afterEach(() => {
  cleanup();
  for (const close of closers.splice(0)) close();
  jest.useRealTimers();
});

function Frame({
  fixture,
  privacy = false,
  children,
}: {
  fixture: InvestmentsStore;
  privacy?: boolean;
  children: ReactNode;
}) {
  return (
    <ServicesProvider services={fixture.services}>
      <StoreProvider client={fixture.client}>
        <ProfileProvider>
          <UiEnvProvider locale="en-US" privacy={privacy}>
            {children}
          </UiEnvProvider>
        </ProfileProvider>
      </StoreProvider>
    </ServicesProvider>
  );
}

function Sheet({
  fixture,
  gid,
  close,
  observed,
}: {
  fixture: InvestmentsStore;
  gid: string;
  close(): void;
  observed(props: AlertSheetState): void;
}) {
  const props = useAlertSheet({
    vault: useProfile(),
    gid,
    lang: "en",
    today: fixture.today,
    now: fixture.now,
    close,
  });
  useEffect(() => observed(props));
  return <AlertSheetView {...props} />;
}

/** The fired CD Projekt alert's signal. */
const alertSignal = (fixture: InvestmentsStore): string => {
  const gid = fixture.store.read<{ gid: string }>(
    "SELECT gid FROM inv_signals WHERE rule_id LIKE 'alert:%'",
  )[0]?.gid;
  if (gid === undefined) throw new Error("the synthetic alert did not fire");
  return gid;
};

async function show(options: { gid?: string; privacy?: boolean } = {}) {
  const fixture = investmentsStore();
  closers.push(() => fixture.close());
  const close = jest.fn();
  let props: AlertSheetState | undefined;
  const gid = options.gid ?? alertSignal(fixture);
  await render(
    <Frame fixture={fixture} privacy={options.privacy ?? false}>
      <Sheet
        fixture={fixture}
        gid={gid}
        close={close}
        observed={(p) => {
          props = p;
        }}
      />
    </Frame>,
  );
  const ready = () => {
    if (props?.kind !== "ready") throw new Error("the alert sheet is not ready");
    return props;
  };
  return { fixture, gid, close, ready, current: () => props };
}

const decisions = (fixture: InvestmentsStore) =>
  fixture.store.read<{ action: string; reason: string | null; instrument: string | null }>(
    `SELECT d.action, d.reason, i.gid AS instrument FROM inv_decisions d
     LEFT JOIN inv_instruments i ON i.id = d.instrument_id ORDER BY d.created_at DESC, d.id DESC`,
  );

describe("the alert sheet over the real synchronous store", () => {
  it("shows what fired, the position and the thesis, with nothing preselected", async () => {
    const { ready } = await show();
    expect(ready().tag).toEqual({ text: "Your alert · risk", tone: "negative" });
    expect(ready().title).toBe("CD Projekt fell 9.4% in 5 sessions");
    expect(ready().meta).toMatch(/^“CDR -8% in 5 sessions” · fired today /);
    expect(ready().facts.map((f) => f.label)).toEqual([
      "Price",
      "Your position",
      "Result",
      "Your size plan",
    ]);
    expect(ready().facts[0]).toMatchObject({
      kind: "text",
      value: expect.stringMatching(/^PLN\s214\.60$/),
    });
    expect(ready().facts[2]).toMatchObject({
      detail: expect.stringMatching(/^average cost PLN\s245\.50$/),
    });
    expect(ready().thesis).toMatchObject({
      wrongIf: "the 2027 release slips again",
      researchLine: { verdict: "weakens", tone: "negative", text: "Q3 and the 2027 slate" },
    });
    // The passive starter strategy has no drawdown section: no strategy line.
    expect(ready().strategyLine).toBeNull();
    expect(ready().settled).toBeNull();
    expect(ready().decision).toMatchObject({ choice: null, canSave: false, canLater: true });
    expect(screen.getByText("CD Projekt fell 9.4% in 5 sessions")).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Save decision" })).toBeDisabled();
  });

  it("masks the owner's average cost while amounts are hidden, never the public price", async () => {
    const { ready } = await show({ privacy: true });
    expect(ready().facts[0]).toMatchObject({ value: expect.stringMatching(/^PLN\s214\.60$/) });
    expect(ready().facts[2]).toMatchObject({ detail: "average cost •••" });
  });

  it("writes the decision as a journal note covering the signal and closes", async () => {
    const { fixture, gid, close, ready } = await show();
    await fireEvent.press(screen.getByRole("tab", { name: "Nothing" }));
    expect(ready().decision).toMatchObject({ choice: "held", canSave: true });
    await act(async () => {
      ready().decision?.onReason("results first");
    });
    await act(async () => {
      await ready().onSave();
    });
    expect(close).toHaveBeenCalledTimes(1);
    expect(
      fixture.store.read<{ type: string }>("SELECT type FROM event_log ORDER BY eid DESC LIMIT 1"),
    ).toEqual([{ type: "decision.recorded" }]);
    expect(decisions(fixture)[0]).toEqual({
      action: "held",
      reason: "results first",
      instrument: fixture.instrument("CDR"),
    });
    const covered = fixture.store.read<{ n: number }>(
      `SELECT COUNT(*) AS n FROM inv_decision_signals l JOIN inv_signals s ON s.id = l.signal_id
       WHERE s.gid = ?`,
      gid,
    );
    expect(covered).toEqual([{ n: 1 }]);
    expect(ready().decision).toBeNull();
    expect(ready().settled).toBe("Noted: Nothing for now · Nov 12, 2026");
  });

  it("writes one decision for two taps on Save before the next render", async () => {
    const { fixture, close, ready } = await show();
    await fireEvent.press(screen.getByRole("tab", { name: "Nothing" }));
    const before = decisions(fixture).length;
    await act(async () => {
      const save = ready().onSave;
      await Promise.all([save(), save()]);
    });
    expect(decisions(fixture).length).toBe(before + 1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("sets the alert aside for the review with Decide later", async () => {
    const { fixture, close, ready } = await show();
    await fireEvent.press(screen.getByRole("button", { name: "Decide later" }));
    expect(close).toHaveBeenCalledTimes(1);
    expect(decisions(fixture)[0]).toEqual({
      action: "held",
      reason: "acknowledged",
      instrument: fixture.instrument("CDR"),
    });
    expect(ready().settled).toBe("Decide later - back in your review");
    // Still decidable here; Decide later is not offered twice.
    expect(ready().decision).toMatchObject({ canLater: false, choice: null });
  });

  it("is gone for an unknown signal", async () => {
    const { current, close } = await show({ gid: "0".repeat(32) });
    expect(current()?.kind).toBe("missing");
    await fireEvent.press(screen.getByRole("button", { name: "Close" }));
    expect(close).toHaveBeenCalled();
  });
});

describe("the strategy's drawdown line", () => {
  it("takes the first quote under a heading about drawdowns", () => {
    const md = [
      "# My strategy",
      "> Not this one.",
      "## Goal",
      "Independence by 2045.",
      "## Drawdowns",
      "Some words first.",
      "> A drawdown alone is not a reason to sell.",
      "> Check the thesis, then decide.",
      "## Spadki",
      "> Drugi cytat.",
    ].join("\n");
    expect(drawdownLine(md)).toBe(
      "A drawdown alone is not a reason to sell. Check the thesis, then decide.",
    );
    expect(drawdownLine("## Spadki\n\n> Spadek to nie powód do sprzedaży.")).toBe(
      "Spadek to nie powód do sprzedaży.",
    );
    expect(drawdownLine("## Goal\n\n> Not about falls.")).toBeNull();
    expect(drawdownLine(null)).toBeNull();
  });
});

describe("the alert sheet's bell", () => {
  const marks = (fixture: InvestmentsStore) => {
    const read: Read = (sql, ...params) => fixture.device.read(sql, ...params);
    const vault = fixture.services.profiles[0]?.vault ?? "";
    return {
      marked: () => markedAlerts.run(read, { vault }),
      prefs: () => notificationPrefs.run(read, { vault }),
    };
  };

  it("marks the alert for this phone, turns the marked-alerts choice on, and unmarks it", async () => {
    const { fixture, ready } = await show();
    const { marked, prefs } = marks(fixture);
    expect(ready().tellPhone?.on).toBe(false);
    expect(prefs().alertsFired).toBe(false);
    await fireEvent.press(screen.getByRole("button", { name: "Tell this phone when it fires" }));
    expect(marked()).toHaveLength(1);
    expect(prefs().alertsFired).toBe(true);
    expect(ready().tellPhone?.on).toBe(true);
    expect(screen.getByRole("button", { name: "Stop telling this phone" })).toBeSelected();
    await fireEvent.press(screen.getByRole("button", { name: "Stop telling this phone" }));
    expect(marked()).toEqual([]);
    // Unmarking leaves the choice as it is.
    expect(prefs().alertsFired).toBe(true);
  });

  it("has no bell on a rule's signal", async () => {
    const fixture = investmentsStore();
    closers.push(() => fixture.close());
    const rule = fixture.store.read<{ gid: string }>(
      "SELECT gid FROM inv_signals WHERE rule_id NOT LIKE 'alert:%' AND status = 'active'",
    )[0]?.gid;
    if (rule === undefined) throw new Error("the synthetic strategy opened no rule signal");
    // The kit is deterministic: the same signal gid in the sheet's own fixture.
    const { ready } = await show({ gid: rule });
    expect(ready().tellPhone).toBeNull();
    expect(screen.queryByRole("button", { name: "Tell this phone when it fires" })).toBeNull();
  });
});

const stories: [string, object, ComponentType[]?][] = [
  ["fired", Fired.args],
  ["choice made", ChoiceMade.args],
  ["could not save", CouldNotSave.args],
  ["set aside for review", SetAsideForReview.args],
  ["tells this phone", TellsThisPhone.args],
  ["decided", Decided.args],
  ["rule without thesis", RuleWithoutThesis.args],
  ["incognito", Incognito.args],
  ["missing", Missing.args],
];

it.each(stories)("renders the %s story", async (_name, args) => {
  const View = alertMeta.component as ComponentType<object>;
  await render(
    <UiEnvProvider locale="en-US" privacy={false}>
      <View {...alertMeta.args} {...args} />
    </UiEnvProvider>,
  );
  expect(screen.root).toBeOnTheScreen();
});
