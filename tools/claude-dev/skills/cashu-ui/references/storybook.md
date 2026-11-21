---
title: Storybook as catalog, test bed and agent index
impact: HIGH
tags: storybook, stories, vitest, a11y, visual-regression, mcp
---

# Storybook as catalog, test bed and agent index

Storybook 10 replaces any homegrown gallery. One story file serves four jobs: the catalog people and
agents browse, render tests, accessibility tests and visual-regression baselines.

## Setup (lands with the first component)

| Piece | Choice |
|---|---|
| Desktop / shared web stories | `@storybook/react-vite` over `packages/ui` and the desktop Views (the Electron renderer is DOM) |
| Mobile | on-device React Native Storybook 10 in `apps/mobile` (dev builds only) for native controls and mobile Views |
| Stories as tests | `@storybook/addon-vitest`: every story renders in Vitest browser mode (Playwright) in `pnpm test` |
| Accessibility | `@storybook/addon-a11y`: axe on every story, violations fail the test |
| Visual regression | Playwright `toHaveScreenshot` over stories in light / dark / privacy mode / PL / EN; baselines in the repo, local only (no cloud upload of UI) |
| Agent index | `@storybook/addon-mcp`: the component manifest the agent queries before building ("search before you build") |

## Writing stories

- CSF: `const meta = { component: Money, ... } satisfies Meta<typeof Money>`; one story per variant,
  size and state (disabled, error, empty, long text, privacy mode on). Synthetic data only.
- A View gets a story per phase of its state union (`empty`, `ready`, `setupRequired`) built from fake
  state objects; pure Views make this free. Interaction checks go in `play` functions.
- Story files sit next to the component (`<Name>.stories.tsx`) or View (`XView.stories.tsx`).

## Coverage (checked)

`tools/arch/src/guards/stories.test.ts` fails when a PascalCase export of `packages/ui/src/index.ts`
has no story with `component: <Name>`, or an `apps/**/XView.tsx` has no sibling `XView.stories.tsx`.
While `packages/ui` has no components the packages/ui half reports SKIPPED with that reason.
