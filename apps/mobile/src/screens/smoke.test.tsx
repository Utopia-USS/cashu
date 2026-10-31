// RNTL smoke test: every story of every View renders and shows its meaning (cashu-ui: stories are
// the render tests), and the debug screen's hook drives the real store (better-sqlite3 here).
import { render, screen, userEvent } from "@testing-library/react-native";
import type { ComponentType } from "react";
import benchMeta, { Idle, Running, WithResults } from "./bench/BenchView.stories";
import cryptoMeta, { BrokenRuntime, Passed } from "./debug/CryptoView.stories";
import debugMeta, { Failures, FirstLaunch, Reopened } from "./debug/DebugView.stories";

// Every story by name: a new story must be added here (CSF named exports).
const STORIES: [string, ComponentType<never>, object, Record<string, { args: object }>][] = [
  ["DebugView", debugMeta.component, debugMeta.args, { FirstLaunch, Reopened, Failures }],
  ["CryptoView", cryptoMeta.component, cryptoMeta.args, { Passed, BrokenRuntime }],
  ["BenchView", benchMeta.component, benchMeta.args, { Idle, WithResults, Running }],
];

describe.each(STORIES)("%s stories", (_view, component, base, stories) => {
  const Component = component as ComponentType<object>;
  it.each(Object.entries(stories))("%s renders", async (_name, story) => {
    await render(<Component {...base} {...story.args} />);
    expect(screen.root).toBeOnTheScreen();
  });
});

describe("DebugView", () => {
  const Component = debugMeta.component;
  it("shows the fixture, tables and sync status", async () => {
    await render(<Component {...FirstLaunch.args} />);
    expect(screen.getByRole("heading", { name: "Demo event log" })).toBeOnTheScreen();
    expect(screen.getByText("Rebuild equals apply")).toBeOnTheScreen();
    expect(screen.getByText("transactions")).toBeOnTheScreen();
    expect(screen.getByText("2340")).toBeOnTheScreen();
    expect(screen.getByText("Reader up to date")).toBeOnTheScreen();
  });

  it("renders the shared charts with accessible names", async () => {
    await render(<Component {...FirstLaunch.args} />);
    const donut = screen.getByLabelText(/^Spending by account \(PLN\)/);
    expect(donut).toBeOnTheScreen();
    expect(donut.props.accessibilityLabel).toMatch(/Konto osobiste \(demo\)/);
    expect(screen.getByLabelText(/^Personal account balance at month end/)).toBeOnTheScreen();
  });

  it("reports a diverging rebuild and a reader behind the log", async () => {
    await render(<Component {...Failures.args} />);
    expect(screen.getByText("Rebuild differs from apply")).toBeOnTheScreen();
    expect(screen.getByText("Needs an app upgrade")).toBeOnTheScreen();
  });

  it("asks for a rebuild", async () => {
    const onRebuild = jest.fn();
    await render(<Component {...FirstLaunch.args} onRebuild={onRebuild} />);
    await userEvent.setup().press(screen.getByRole("button", { name: "Rebuild from the log" }));
    expect(onRebuild).toHaveBeenCalledTimes(1);
  });
});

describe("CryptoView", () => {
  it("shows every check and the verdict", async () => {
    await render(<cryptoMeta.component {...Passed.args} />);
    expect(screen.getByRole("heading", { name: "Crypto (self-test)" })).toBeOnTheScreen();
    expect(screen.getByText("All checks passed")).toBeOnTheScreen();
    expect(screen.getByText("sealedBoxWrongKey")).toBeOnTheScreen();
  });

  it("reports a broken runtime", async () => {
    await render(<cryptoMeta.component {...BrokenRuntime.args} />);
    expect(screen.getByText("Self-test failed")).toBeOnTheScreen();
    expect(screen.getByText("FAIL unsupported_runtime")).toBeOnTheScreen();
  });
});

describe("BenchView", () => {
  it("disables the runs while one is in progress", async () => {
    const Component = benchMeta.component;
    await render(<Component {...Running.args} />);
    expect(screen.getByRole("button", { name: "Scroll 4k" })).toBeDisabled();
  });
});
