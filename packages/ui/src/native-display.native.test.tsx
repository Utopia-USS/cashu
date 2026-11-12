// Native render tests of the phone's display components (jest-expo + React Native Testing Library): every
// story of every file renders inside a UiEnvProvider, and the figure, the rows and the meters keep money
// private and speak one text each.
import { setLanguageForTests } from "@cashu/i18n";
import { render, screen } from "@testing-library/react-native";
import type { ReactElement } from "react";
import { storyCases } from "./charts/testing/csf.js";
import * as buttonStories from "./controls/Button.stories.js";
import { UiEnvProvider } from "./environment/UiEnv.js";
import * as bannerStories from "./feedback/Banner.native.stories.js";
import * as emptyStories from "./feedback/EmptyState.native.stories.js";
import * as noteStories from "./feedback/NoteLine.native.stories.js";
import * as dotsStories from "./feedback/ProgressDots.native.stories.js";
import * as iconStories from "./icons/Icon.native.stories.js";
import * as dateLeadStories from "./lists/DateLead.native.stories.js";
import * as rowStories from "./lists/ListRow.native.stories.js";
import * as meterStories from "./meters/Meter.native.stories.js";
import * as paceStories from "./meters/PaceMeter.native.stories.js";
import * as freshStories from "./status/FreshLine.native.stories.js";
import * as factsStories from "./surfaces/Facts.native.stories.js";
import * as kpiStories from "./surfaces/KpiStrip.native.stories.js";
import * as tagStories from "./surfaces/Tag.native.stories.js";
import * as tileStories from "./surfaces/Tile.native.stories.js";
import * as figureStories from "./values/Figure.native.stories.js";

jest.mock("@expo/ui", () => require("./testing/expoUiMock.native").default);

beforeEach(() => setLanguageForTests("en"));

const MODULES = {
  iconStories,
  tileStories,
  figureStories,
  rowStories,
  dateLeadStories,
  tagStories,
  freshStories,
  meterStories,
  paceStories,
  kpiStories,
  factsStories,
  noteStories,
  bannerStories,
  emptyStories,
  dotsStories,
  buttonStories,
};
// Not rendered here: Card.stories.tsx (every story passes a bare string as children, which a native View
// cannot hold) and Button's RichContent story (DOM <strong> / <span> children). Both are desktop story data.
const SKIP = new Set(["buttonStories/RichContent"]);

const inEnv = (element: ReactElement) => (
  <UiEnvProvider privacy={false} locale="en-US">
    {element}
  </UiEnvProvider>
);
const story = (mod: Record<string, unknown>, name: string) => {
  const found = storyCases(mod).find(([n]) => n === name);
  if (!found) throw new Error(`no story ${name}`);
  return inEnv(found[1]);
};

describe.each(Object.entries(MODULES))("%s (native)", (name, mod) => {
  const cases = storyCases(mod).filter(([story]) => !SKIP.has(`${name}/${story}`));
  it.each(cases)("%s renders", async (_story, element) => {
    await render(inEnv(element));
    expect(screen.root).toBeOnTheScreen();
  });
});

describe("Figure (native)", () => {
  it("splits the currency before the digits in English and mutes the decimals", async () => {
    await render(story(figureStories, "Pln"));
    expect(screen.getByLabelText("PLN 14,220.55")).toBeOnTheScreen();
    expect(screen.getByText("PLN")).toBeOnTheScreen();
    expect(screen.getByText("14,220")).toBeOnTheScreen();
    expect(screen.getByText(".55").props.className).toContain("text-fg-muted");
  });

  it("puts zł after the digits in Polish", async () => {
    await render(story(figureStories, "Polish"));
    expect(screen.getByText("zł")).toBeOnTheScreen();
    expect(screen.getByText(",55")).toBeOnTheScreen();
  });

  it("masks the amount and its tone in privacy mode, or shows it in bananas", async () => {
    await render(story(figureStories, "PrivacyMasked"));
    expect(screen.getByLabelText("Amount hidden")).toBeOnTheScreen();
    expect(screen.getByText("•••").props.className).not.toContain("negative");
    expect(JSON.stringify(screen.toJSON())).not.toMatch(/14|PLN/);
    await render(story(figureStories, "PrivacyBananas"));
    expect(screen.getByText(/^🍌 /)).toBeOnTheScreen();
  });

  it("keeps the sign with the digits and the negative tone", async () => {
    await render(story(figureStories, "Negative"));
    expect(screen.getByText("-3,410").props.className).toContain("text-negative");
  });
});

describe("rows and meters (native)", () => {
  it("shows a date lead as day and weekday, spoken as the whole date", async () => {
    await render(story(dateLeadStories, "Default"));
    expect(screen.getByText("12")).toBeOnTheScreen();
    expect(screen.getByText("Thu")).toBeOnTheScreen();
    expect(screen.getByLabelText("November 12, 2026")).toBeOnTheScreen();
  });

  it("draws the hairline above every row but the first", async () => {
    const rootClass = () =>
      String((screen.toJSON() as { props: Record<string, unknown> } | null)?.props.className);
    await render(story(rowStories, "Default"));
    expect(rootClass()).toContain("border-t");
    await render(story(rowStories, "First"));
    expect(rootClass()).not.toContain("border-t");
  });

  it("gives the pace meter the right label as its value", async () => {
    await render(story(paceStories, "Default"));
    const meter = screen.getByRole("progressbar");
    expect(meter.props.accessibilityValue).toEqual({ text: "a bit ahead of usual" });
  });

  it("reports progress dots as done of total", async () => {
    await render(story(dotsStories, "Default"));
    expect(screen.getByRole("progressbar").props.accessibilityValue.text).toBe("2 of 5");
  });
});
