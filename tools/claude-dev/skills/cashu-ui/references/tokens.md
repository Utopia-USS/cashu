---
title: Tokens and theming
impact: CRITICAL
tags: ui, tokens, theme, dark-mode, privacy, contrast
---

# Tokens and theming

## One source

`packages/ui/src/tokens/` is the single definition of every style value. Desktop reads them as CSS
custom properties (`--color-text-primary`, `--space-3`); mobile reads the same values through the
styling engine's theme. With option (b) of S50 the source is a Tailwind v4 `@theme` (CSS variables)
consumed by Tailwind and Uniwind; with option (a) it is StyleX `defineVars` / `createTheme`, which emit
CSS variables on the web. Either way: one file set, no second copy, no hand-kept native mirror.

Apps never hold values: a View writes token references (a role class, a theme variable), never `#hex`,
`rgb()`, `padding: 12` or `p-[13px]`. The raw-literal guard (`tools/arch/src/guards/rawStyles.ts`)
checks every `apps/**/*.tsx`.

## Roles, not palette

- Color roles: `text.primary | secondary | muted | inverse`, `surface.base | raised | sunken | overlay`,
  `border.default | strong`, `accent.default | muted`, `tone.positive | negative | warning | info`
  (each with `fg` and `bg`), `chart.series1..8`, `focus.ring`.
- Gains and losses are `tone.positive` / `tone.negative`; never green / red literals or raw palette
  classes (`bg-red-500` is flagged).
- The raw palette exists only inside the tokens folder.

## Scales

- Spacing: a 4-point scale (`space.0..10`). Type: named (`caption`, `body`, `bodyStrong`, `title`,
  `headline`, `display`, `numeric` with tabular figures). Radii, elevation, motion durations and
  easings are named too.
- A value not in a scale is a token change, made in the tokens folder and reviewed, never a local
  exception.

## Themes

Light, dark and high contrast are token sets, never component branches. The desktop follows
`prefers-color-scheme` with an explicit `data-theme` override; mobile follows the system appearance.
A unit test over the token pairs (`text.*` on `surface.*`, `tone.*.fg` on `tone.*.bg`) asserts WCAG AA
contrast in every theme; it lands with the first tokens.

## Privacy mode and locale

Both are app state (device-local store tables) handed to `packages/ui` through the UI environment
context at the app root. Value components read it; nothing else checks privacy mode.
