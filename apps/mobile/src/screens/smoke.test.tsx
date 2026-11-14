// RNTL smoke test: every story of the debug and bench Views renders (cashu-ui: stories are the render
// tests). Chart accessibility is covered in packages/ui (charts.native.test.tsx).
import { render, screen } from "@testing-library/react-native";
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

// The diagnostics the debug screen exists for: a diverging rebuild and a reader behind the log.
it("DebugView reports a diverging rebuild and a reader behind the log", async () => {
  await render(<debugMeta.component {...Failures.args} />);
  expect(screen.getByText("Rebuild differs from apply")).toBeOnTheScreen();
  expect(screen.getByText("Needs an app upgrade")).toBeOnTheScreen();
});
