// RNTL smoke test: every story of every View renders and shows its meaning (cashu-ui: stories are
// the render tests), and the debug screen's hook drives the real store (better-sqlite3 here).
import { render, screen, userEvent } from "@testing-library/react-native";
import type { ComponentType } from "react";
import benchMeta, { Idle, Running, WithResults } from "./bench/BenchView.stories";
import debugMeta, { Failures, FirstLaunch, Reopened } from "./debug/DebugView.stories";

// Every story by name: a new story must be added here (CSF named exports).
const STORIES: [string, ComponentType<never>, object, Record<string, { args: object }>][] = [
  ["DebugView", debugMeta.component, debugMeta.args, { FirstLaunch, Reopened, Failures }],
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
  it("shows the fixture, tables, sync and crypto results", async () => {
    await render(<Component {...FirstLaunch.args} />);
    expect(screen.getByRole("heading", { name: "Demo event log" })).toBeOnTheScreen();
    expect(screen.getByText("Rebuild equals apply")).toBeOnTheScreen();
    expect(screen.getByText("transactions")).toBeOnTheScreen();
    expect(screen.getByText("2340")).toBeOnTheScreen();
    expect(screen.getByText("All checks passed")).toBeOnTheScreen();
  });

  it("reports a failing self-test and a diverging view", async () => {
    await render(<Component {...Failures.args} />);
    expect(screen.getByText("Rebuild differs from apply")).toBeOnTheScreen();
    expect(screen.getByText("Self-test failed")).toBeOnTheScreen();
    expect(screen.getByText("FAIL unsupported_runtime")).toBeOnTheScreen();
  });

  it("asks for a rebuild", async () => {
    const onRebuild = jest.fn();
    await render(<Component {...FirstLaunch.args} onRebuild={onRebuild} />);
    await userEvent.setup().press(screen.getByRole("button", { name: "Rebuild from the log" }));
    expect(onRebuild).toHaveBeenCalledTimes(1);
  });
});

describe("BenchView", () => {
  it("disables the runs while one is in progress", async () => {
    const Component = benchMeta.component;
    await render(<Component {...Running.args} />);
    expect(screen.getByRole("button", { name: "Scroll 4k" })).toBeDisabled();
  });
});
