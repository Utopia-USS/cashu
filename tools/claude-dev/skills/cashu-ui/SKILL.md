---
name: cashu-ui
description: |
  The UI system of the cashU TypeScript stack: design tokens defined once, shared display components where desktop and mobile agree, platform files only for native controls (@expo/ui on mobile), value components for money / dates / privacy mode, charts and long lists, Storybook 10 as the component catalog and test bed, UI copy with Polish plurals, and how to add or change a component.

  Applicability - POSITIVE: packages/ui, every View in apps/desktop and apps/mobile and its story, tokens, colors, spacing, typography, icons, money and date display, charts, virtualized lists, empty / error visuals, accessibility, *.strings.ts catalogs and plurals; reviewing UI code for duplication, raw style values or missing stories.

  Applicability - NEGATIVE: NOT where logic or data lives, screen hooks, queries or commands (cashu-ts-architecture), NOT Expo / React Native platform mechanics or navigation setup (expo-* skills), NOT the legacy frontend/ SPA except when moving one of its components into packages/ui.
---

# cashu-ui

One place for every visual decision, so the desktop and the phone look like one product and nothing
visual is built twice by accident. Screens differ per platform (a dense desktop dashboard, a phone
review deck); tokens, value components and the shared display layer do not. The mechanical parts are
checked by `pnpm arch:check` (raw style literals, story coverage, catalog parity) and per edit by the
dev plugin's hook.

## Styling engine: pending S50

The styling approach is decided by spike **S50**: (a) **react-strict-dom** for the shared display layer
(StyleX on the desktop DOM, React Native on mobile) or (b) **Tailwind v4 tokens** with Tailwind on the
desktop and **Uniwind** on mobile. This is the only place that names the choice. Everything in this
skill holds for both; until S50 lands, write no styling-engine-specific code in `packages/ui` and
keep Views on tokens and existing components.

## Non-negotiable

- **Search before you build.** Query the Storybook MCP addon (component manifest) or `packages/ui`
  stories before any new visual element. Extend an existing component with a variant before forking.
- **Tokens are the only source of style values** (one source: CSS variables / the Tailwind v4 theme),
  named by role, never by palette. No raw color, spacing, font size or radius literal in `apps/*`.
- **Shared where the platforms agree, platform files only where native controls differ**: Sheet,
  Menu, Picker, Switch, DatePicker, TextField use `@expo/ui` on mobile and DOM controls on desktop
  (`.web.tsx` / `.native.tsx`, identical props, a default file).
- **Promote on the second real use**: used on two screens, a nameable role, an API smaller than its
  implementation. A wrong abstraction costs more than duplication.
- **Money, numbers and dates render through `<Money>`, `<Amount>`, `<Percent>`, `<DateText>`, `<Delta>`**,
  which apply locale, currency rules and privacy mode. Never format in a View.
- **Every packages/ui export and every View has a story** (all variants and phases, synthetic data).
- **Long lists are virtualized**: FlashList v2 on mobile, TanStack Virtual on desktop.
- **Copy comes from catalogs** (`*.strings.ts`, PL + EN, plurals through `Intl.PluralRules`); text
  props are required for accessibility where a control has no visible text.

## Problem -> reference

| Task / question | Start with |
|---|---|
| I need a button / row / card / chart / badge / list | Storybook MCP search, then [components.md](references/components.md) |
| Add a variant or a new component, or port one from `frontend/` | [components.md](references/components.md) |
| A color, spacing, type, dark mode or privacy-mode decision | [tokens.md](references/tokens.md) |
| Stories, visual regression, a11y tests, story coverage failure | [storybook.md](references/storybook.md) |
| UI text, plurals, number and date formatting | [copy.md](references/copy.md) |
| Native look and feel on iOS | `expo:expo-ui`, `expo:expo-native-ui`, `expo:expo-design-system` |

## See also

- `cashu-ts-architecture` - screen hook + pure View; what a View may import; performance budgets.
- `expo:expo-design-system` (promotion rule, variant conventions), `expo:expo-ui` (`@expo/ui` controls),
  `building-react-native-apps:react-native-best-practices` (list and render performance).

## References

| File | Style | Impact | Description |
|---|---|---|---|
| [components.md](references/components.md) | pattern | CRITICAL | Package layout, shared vs platform files, the base set, value components, lists, charts, accessibility, adding and porting |
| [tokens.md](references/tokens.md) | pattern | CRITICAL | One token source, roles and scales, themes, privacy mode, contrast, the raw-literal guard |
| [storybook.md](references/storybook.md) | pattern | HIGH | Storybook 10 web + on-device, Vitest and a11y addons, screenshots, MCP search, coverage |
| [copy.md](references/copy.md) | cheatsheet | HIGH | Catalog shape, `useStrings`, Polish plurals, `Intl` formatters, parity guard |

## Self-audit checklist

After editing UI in this skill's applicability, verify:

1. `pnpm arch:check` green: no raw style values in `apps/*`, every new export and View has a story,
   catalogs in parity.
2. You searched the catalog first; no new component duplicates an existing one under another name.
3. Something used on two screens with a nameable role lives in `packages/ui`; one-off composition stays in the View.
4. Platform files exist only for native controls and expose identical props.
5. Amounts go through the value components and disappear in privacy mode.
6. Lists that can exceed ~50 rows are virtualized.
7. Every interactive element has an accessible name; text comes from catalogs in PL and EN, plurals
   with every category.
8. Nothing assumes the S50 styling choice before it is made.
