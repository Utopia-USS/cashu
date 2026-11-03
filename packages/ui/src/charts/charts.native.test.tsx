// Native render tests (jest-expo + React Native Testing Library): every story of every chart renders through
// the react-native-svg renderer, and the image / adjustable roles, privacy masking and touch scrub behave.
import { setLanguageForTests } from "@cashu/i18n";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { Uniwind } from "uniwind";
import * as envStories from "../environment/UiEnvProvider.stories.js";
import * as areaStories from "./AreaChart.stories.js";
import * as barStories from "./BarChart.stories.js";
import * as donutStories from "./Donut.stories.js";
import * as lineStories from "./LineChart.stories.js";
import * as sparkStories from "./Sparkline.stories.js";
import { ROLE_VAR } from "./scene.js";
import { storyCases } from "./testing/csf.js";

// Metro compiles theme.css into Uniwind's store in the app; under jest the theme is fed directly. Synthetic
// values, one per role, so the test can tell which token a mark resolved to.
const THEME = Object.fromEntries(
  Object.values(ROLE_VAR).map((name, k) => [name, `rgb(${k + 1}, 0, 0)`]),
);
beforeAll(() => Uniwind.updateCSSVariables(Uniwind.currentTheme, THEME));
beforeEach(() => setLanguageForTests("en"));

const MODULES = { lineStories, areaStories, barStories, donutStories, sparkStories, envStories };
const story = (mod: Record<string, unknown>, name: string) => {
  const found = storyCases(mod).find(([n]) => n === name);
  if (!found) throw new Error(`no story ${name}`);
  return found[1];
};

describe.each(Object.entries(MODULES))("%s", (_name, mod) => {
  it.each(storyCases(mod))("%s renders", async (_story, element) => {
    await render(element);
    expect(screen.root).toBeOnTheScreen();
  });
});

describe("LineChart (native)", () => {
  it("resolves the token roles of the marks through Uniwind (series 1 line, grid)", async () => {
    await render(story(lineStories, "Default"));
    type Json = {
      type: string;
      props: Record<string, unknown>;
      children: (Json | string)[] | null;
    };
    const strokes = new Set<string>();
    const walk = (node: Json | string) => {
      if (typeof node === "string") return;
      if (node.type.startsWith("RNSVG") && node.props.stroke != null)
        strokes.add(JSON.stringify(node.props.stroke));
      for (const child of node.children ?? []) walk(child);
    };
    walk(screen.toJSON() as Json);
    // grid lines and the series line resolved to two different synthetic colours (none left unresolved)
    expect(strokes.size).toBe(2);
  });

  it("is an image named by its label and value summary, with axis labels as text", async () => {
    await render(story(lineStories, "Default"));
    const img = screen.getByRole("image");
    expect(img.props.accessibilityLabel).toMatch(
      /^Net worth\. from 01\/25 to 12\/26\. Net worth: latest/,
    );
    expect(screen.getAllByText(/^\d+k$/).length).toBeGreaterThan(0);
  });

  it("hides the amount axis and speaks amounts as hidden in privacy mode", async () => {
    await render(story(lineStories, "PrivacyMode"));
    expect(screen.queryAllByText(/^\d+k$/)).toHaveLength(0);
    expect(screen.getByRole("adjustable").props.accessibilityLabel).toContain("latest hidden");
  });

  it("is adjustable: VoiceOver increment / decrement step the focused value", async () => {
    await render(story(lineStories, "Interactive"));
    const chart = screen.getByRole("adjustable");
    expect(chart.props.accessibilityValue).toBeUndefined();
    await fireEvent(chart, "accessibilityAction", { nativeEvent: { actionName: "decrement" } });
    expect(screen.getByRole("adjustable").props.accessibilityValue.text).toMatch(
      /^11\/26, Portfolio /,
    );
    expect(screen.getByText("Portfolio")).toBeOnTheScreen();
  });

  it("scrubs to the touched index and clears on release; amounts are masked in privacy mode", async () => {
    await render(story(lineStories, "PrivacyMode"));
    const chart = screen.getByRole("adjustable");
    await fireEvent(chart, "responderGrant", { nativeEvent: { locationX: 56 } });
    expect(screen.getAllByText("01/25")).toHaveLength(2); // x label + tooltip title
    expect(screen.getAllByText("•••")).toHaveLength(2);
    await fireEvent(chart, "responderRelease");
    expect(screen.getAllByText("01/25")).toHaveLength(1);
  });
});

describe("BarChart, Donut, Sparkline (native)", () => {
  it("names a bar chart by every value", async () => {
    await render(story(barStories, "Monthly"));
    expect(screen.getByRole("image").props.accessibilityLabel).toMatch(
      /^Contributions: 01 2,000, 02 500, 03 none/,
    );
  });

  it("masks an amount donut centre in privacy mode", async () => {
    await render(story(donutStories, "CenterInPrivacyMode"));
    expect(screen.getByText("•••")).toBeOnTheScreen();
    expect(screen.queryByText("184k")).toBeNull();
  });

  it("hides an unlabelled sparkline from assistive technology", async () => {
    await render(story(sparkStories, "Decorative"));
    expect(screen.queryByRole("image")).toBeNull();
  });
});

describe("interactive donut (native)", () => {
  it("dispatches host accessibility actions to the same segment intent as actual arc presses", async () => {
    const selected: number[] = [];
    const Donut = donutStories.default.component;
    await render(
      <Donut
        label="Spending"
        segments={[{ name: "Food", value: 2, color: 1 }]}
        onSegmentSelected={(i) => selected.push(i)}
      />,
    );
    const host = screen.getByLabelText("Spending: Food 100%");
    await fireEvent(host, "accessibilityAction", { nativeEvent: { actionName: "segment-0" } });
    const arc = screen.getByLabelText("Food");
    expect(selected).toEqual([0]);
    const touch = {
      currentTarget: 1,
      persist: () => {},
      nativeEvent: {
        target: 1,
        identifier: 1,
        pageX: 20,
        pageY: 20,
        locationX: 20,
        locationY: 20,
        timestamp: 100,
        touches: [{ identifier: 1, pageX: 20, pageY: 20 }],
        changedTouches: [{ identifier: 1, pageX: 20, pageY: 20 }],
      },
    };
    await fireEvent(arc, "responderGrant", touch);
    await fireEvent(arc, "responderRelease", touch);
    expect(selected).toEqual([0, 0]);
  });
});
