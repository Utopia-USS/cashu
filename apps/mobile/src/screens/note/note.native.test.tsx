// The research note reader's hook and View over the synthetic investments vault (Saturday's research run
// of the companion fixture): the verdict tag and meta, the paragraph quoting the thesis set apart, the
// sources opening their links, the note marked read on open; and every story of the View. The calendar
// is pinned to Thu 12 Nov 2026.
import { setLanguageForTests } from "@cashu/i18n";
import { runQuery } from "@cashu/store/query";
import { ProfileProvider, StoreProvider } from "@cashu/store-react";
import { UiEnvProvider } from "@cashu/ui/native";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react-native";
import { type ComponentType, type ReactNode, useEffect } from "react";
import { ServicesProvider } from "../../services/ServicesProvider";
import { type InvestmentsStore, investmentsStore } from "../testing/investmentsStore";
import { NoteView } from "./NoteView";
import noteMeta, { Background, Missing, WeakensThesis, WrittenByYou } from "./NoteView.stories";
import { type NoteState, noteBlocks, useNoteScreen } from "./useNoteScreen";

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

function Frame({ fixture, children }: { fixture: InvestmentsStore; children: ReactNode }) {
  return (
    <ServicesProvider services={fixture.services}>
      <StoreProvider client={fixture.client}>
        <ProfileProvider>
          <UiEnvProvider locale="en-US" privacy={false}>
            {children}
          </UiEnvProvider>
        </ProfileProvider>
      </StoreProvider>
    </ServicesProvider>
  );
}

const openLink = jest.fn();

function Reader({
  fixture,
  gid,
  observed,
}: {
  fixture: InvestmentsStore;
  gid: string;
  observed(props: NoteState): void;
}) {
  const props = useNoteScreen({
    gid,
    lang: "en",
    today: fixture.today,
    now: fixture.now,
    openLink,
  });
  useEffect(() => observed(props));
  return <NoteView {...props} />;
}

const noteGid = (fixture: InvestmentsStore, title: string): string => {
  const gid = fixture.store.read<{ gid: string }>(
    "SELECT gid FROM research_notes WHERE title = ?",
    title,
  )[0]?.gid;
  if (gid === undefined) throw new Error(`no synthetic note ${title}`);
  return gid;
};

const unread = (fixture: InvestmentsStore, gid: string) => {
  const result = runQuery(fixture.store, fixture.services.moneyQueries.investments.research.note, {
    today: fixture.today,
    lang: "en",
    note: gid,
  }).value;
  return result.status === "current" ? result.note?.unread : undefined;
};

async function show(title: string | null) {
  const fixture = investmentsStore();
  closers.push(() => fixture.close());
  const gid = title === null ? "0".repeat(32) : noteGid(fixture, title);
  let props: NoteState | undefined;
  await render(
    <Frame fixture={fixture}>
      <Reader
        fixture={fixture}
        gid={gid}
        observed={(p) => {
          props = p;
        }}
      />
    </Frame>,
  );
  const ready = () => {
    if (props?.kind !== "ready") throw new Error("the note reader is not ready");
    return props;
  };
  return { fixture, gid, ready, current: () => props };
}

describe("the research note reader over the real synchronous store", () => {
  it("reads the note with its verdict, the quoted thesis and its sources, and marks it read", async () => {
    const { fixture, gid, ready } = await show("Q3 and the 2027 slate");
    expect(ready().tag).toEqual({ text: "weakens your thesis", tone: "negative" });
    expect(ready().meta).toBe("CD Projekt · news · 7 Nov 2026");
    expect(ready().blocks.map((b) => b.kind)).toEqual(["p", "quote", "p", "p"]);
    expect(ready().blocks[1]?.text).toMatch(
      /^Your thesis is wrong if the 2027 release slips again/,
    );
    expect(ready().sources.map((s) => s.title)).toEqual([
      "Company Q3 report and call transcript - 5 Nov 2026",
      "Release window report - 6 Nov 2026",
      "Exchange quote history - 7 Nov 2026",
      "Public broker note summary - 6 Nov 2026",
    ]);
    expect(ready().byAgent).toBe(true);
    expect(screen.getByText("Written by your research agent on your Mac.")).toBeOnTheScreen();
    await act(async () => {});
    expect(unread(fixture, gid)).toBe(false);
  });

  it("opens a source's link through the route", async () => {
    await show("Q3 and the 2027 slate");
    await fireEvent.press(screen.getByText("Release window report - 6 Nov 2026"));
    expect(openLink).toHaveBeenCalledWith("https://research.example.com/cdr/release-window");
  });

  it("shows a theme note without a verdict as background, without a quote", async () => {
    const { ready } = await show("USD/PLN: what moved it this month");
    expect(ready().tag).toEqual({ text: "background", tone: "neutral" });
    expect(ready().meta).toMatch(/^usd_pln · macro · \d+ Nov 2026$/);
    expect(ready().blocks.every((b) => b.kind === "p")).toBe(true);
  });

  it("is gone for an unknown note", async () => {
    const { current } = await show(null);
    expect(current()).toEqual({ kind: "missing" });
  });
});

describe("the note's paragraphs", () => {
  it("sets apart the first paragraph quoting a thesis text", () => {
    const blocks = noteBlocks(
      "First.\n\nThe RELEASE SLIPS AGAIN, they say.\n\n\nAgain: the release slips again.",
      ["the release slips again"],
      "en-US",
    );
    expect(blocks.map((b) => b.kind)).toEqual(["p", "quote", "p"]);
    expect(noteBlocks("One.\n\nTwo.", [], "en-US").map((b) => b.kind)).toEqual(["p", "p"]);
  });
});

const stories: [string, object][] = [
  ["weakens thesis", WeakensThesis.args],
  ["background", Background.args],
  ["written by you", WrittenByYou.args],
  ["missing", Missing.args],
];

it.each(stories)("renders the %s story", async (_name, args) => {
  const View = noteMeta.component as ComponentType<object>;
  await render(
    <UiEnvProvider locale="en-US" privacy={false}>
      <View {...noteMeta.args} {...args} />
    </UiEnvProvider>,
  );
  expect(screen.root).toBeOnTheScreen();
});
