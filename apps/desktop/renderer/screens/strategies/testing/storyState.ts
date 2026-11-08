// Synthetic states of the Strategie tab Views (stories and the view test): no real strategy, file or path.
import type { StrategiesScreenState } from "../useStrategiesScreen.js";
import type { StrategySettingsState } from "../useStrategySettings.js";

const noop = () => {};
export const prose =
  "# Synthetic strategy\n\nPrivate synthetic investment prose.\n\n- [x] Review\n- Keep a long horizon\n\n| Bucket | Target |\n|---|---|\n| Synthetic | 80% |\n";

export const readyState: StrategiesScreenState = {
  phase: "ready",
  withSide: true,
  listLabel: "Strategies and their files",
  tree: [
    {
      key: "_main",
      id: "_main",
      title: "Synthetic strategy",
      tags: [
        { key: "st", text: "OK", tone: "positive" },
        { key: "ex", text: "executed", tone: "neutral" },
      ],
      description: "Private synthetic description",
      on: true,
      select: { id: "_main", path: "strategy.md" },
      files: [
        {
          kind: "file",
          key: "f:strategy.md",
          name: "strategy.md",
          depth: 0,
          path: "strategy.md",
          ext: "md",
          extText: "MD",
          on: true,
        },
        {
          kind: "file",
          key: "f:strategy.yaml",
          name: "strategy.yaml",
          depth: 0,
          path: "strategy.yaml",
          ext: "yaml",
          extText: "YML",
          on: false,
        },
      ],
    },
  ],
  noFiles: "no files",
  pick: noop,
  folderHint: "Your agent saves further strategies in the strategies folder.",
  copyFolder: "Copy the folder path",
  onCopyFolder: noop,
  main: {
    kind: "file",
    crumb: "Synthetic strategy",
    path: "strategy.md",
    mode: {
      label: "File view",
      items: [
        ["Preview", "preview"],
        ["Source", "source"],
      ],
      value: "preview",
      onChange: noop,
    },
    copyPath: "Copy path",
    onCopyPath: noop,
    notExecuted: null,
    issuesNote: null,
    body: { kind: "md", text: prose },
  },
  onProposalOpened: undefined,
};

export const unavailableState: StrategiesScreenState = {
  phase: "unavailable",
  text: "Strategies not loaded: synthetic",
};

export const settingsState: StrategySettingsState = {
  side: false,
  title: "Investment strategy",
  tag: { key: "st", text: "OK", tone: "positive" },
  unavailableText: "Strategy file access is unavailable.",
  popover: {
    kind: "missing",
    strategy: "Strategy",
    tag: { key: "none", text: "none", tone: "warning" },
    fromTemplate: "Create from a template",
    copyCommand: "Copy /investments-setup",
    onInit: noop,
    onCopyCommand: noop,
    notice: null,
  },
  view: "View",
  onProposal: noop,
};
