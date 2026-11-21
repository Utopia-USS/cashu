---
title: Components, platforms, lists, charts and porting
impact: CRITICAL
tags: ui, components, react, react-native, expo-ui, lists, charts, accessibility
---

# Components, platforms, lists, charts and porting

## Package layout

```
packages/ui/
  src/tokens/                      the token source (format fixed by S50, see tokens.md)
  src/<name>/<Name>.tsx            shared implementation (where the platforms agree)
  src/<name>/<Name>.web.tsx        desktop control  } only for native controls,
  src/<name>/<Name>.native.tsx     @expo/ui control } identical props, plus a default file
  src/<name>/<Name>.stories.tsx    every variant, size, state, privacy mode; synthetic data
  src/<name>/<Name>.strings.ts     accessibility defaults only, PL + EN
  src/index.ts                     the package's public exports (story coverage reads this)
```

The component's one-line purpose is its JSDoc summary, written for someone searching ("Row of a list
with a leading icon, title, subtitle and a trailing value"); Storybook autodocs and the MCP manifest
read it.

## Shared vs platform

- **Shared display layer** (one implementation): layout (`Stack`, `Row`, `Grid`, `Section`), `Text`
  variants, value components, `Badge`, `Tag`, `Card`, `StatTile`, `EmptyState`, `ErrorState`, chart
  geometry. How one implementation renders on both platforms is the S50 decision.
- **Native controls** (platform files): `Sheet`, `Menu`, `Picker`, `Switch`, `DatePicker`,
  `TextField`, `SegmentedControl`. Mobile uses `@expo/ui` (SwiftUI / Compose); desktop uses DOM
  controls. Do not wrap a native control only to route it through the system when it adds nothing.
- **Screens are not shared.** Desktop and phone screens differ; they share feature hooks, tokens and
  the components above.
- Components accept a `style` / `className` for **layout only** (margin, flex, alignment), merged
  last; identity (color, type) comes from variants. With S50's engine the layout-only restriction
  becomes a type.

## Component API conventions

- Intent props: `variant` (`primary | secondary | danger | ghost`), `size` (`sm | md | lg`), `tone`
  for semantic roles; no boolean soup. Compound components over render props (`Card.Header`).
- Text comes in as translated strings or `children`; a component holds no copy except its own
  accessibility defaults.
- Data comes in as props: packages/ui never imports the store, sync, ui-logic, navigation, app-state
  stores or the network (checked).

## Value components

`Money`, `Amount`, `Percent`, `Delta`, `DateText` take raw values (`Money`, `Decimal`, ISO dates) and
read locale and privacy mode from the UI environment context that the app root provides (fed from the
store's device-local settings). Privacy mode hides amounts everywhere; components never check it on
their own. Amounts use tabular figures; `tone.positive` / `tone.negative` for gains and losses.

## Lists

Any list that can exceed ~50 rows is virtualized: FlashList v2 in mobile Views, TanStack Virtual on
the desktop. Rows are components with a stable `key` (the gid); the row's data shape is shared, the
list component is per platform. The query behind it pages (keyset / window), see the architecture
skill's performance budgets.

## Charts

Share the geometry (d3-scale, d3-shape, ticks, privacy masking) in `packages/ui`; render with DOM
`<svg>` on desktop and `react-native-svg` on mobile through thin renderers. Series colors come from
`chart.series1..8` tokens. Skia (Victory Native XL) only if a profiler demands it.

## Accessibility

- Accessible names are required props where a control has no visible text.
- Custom controls set role and state (selected, expanded, disabled).
- Desktop: full keyboard navigation and a visible focus ring (`focus.ring` token) on the dense
  dashboard. Mobile: Dynamic Type (never disable font scaling), reduced motion respected.
- The a11y addon runs axe on every story; token pairs pass a contrast test (tokens.md).

## Adding a component

1. Search Storybook (MCP manifest) by purpose words, not only names. Prefer a variant.
2. Check the promotion rule: two real uses, a nameable role, an API smaller than its implementation.
   Otherwise keep it private to the View.
3. Write the props and JSDoc purpose, then the implementation (platform files only for native controls).
4. Add `<Name>.stories.tsx` covering every variant, size, state (disabled, error, empty) and privacy
   mode where amounts appear; export it from `src/index.ts`.
5. `pnpm arch:check`: story coverage, a11y and render tests (Vitest addon) must pass.

## Porting from the legacy SPA

The legacy SPA (`frontend/src/ui.tsx`, `widgets.tsx`, `charts.tsx`, module components; React 18 + Vite 5
with plain CSS and inline styles) is deleted from the tree; read it from git history
(`git log --diff-filter=D -- frontend` names the deleting commit, `git show <commit>^:frontend/src/ui.tsx`).
Port by moving behaviour and look into `packages/ui` with the conventions above (tokens, variants,
stories).
