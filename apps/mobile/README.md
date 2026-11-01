# Mobile build choices

## Zod error locales

The phone uses Zod's default English validation diagnostics. UI translations come from `@cashu/i18n`;
the app does not configure Zod's other locales. Zod's core and classic entry points both export the
entire locale namespace, which Metro retains even when those translations are unused.

The mobile Metro resolver maps only the resolved `zod/v4/locales/index.js` / `.cjs` aggregator to
`src/platform/zodLocales.ts`. That module re-exports the original English implementation from the
public `zod/v4/locales/en.js` entry. Schema definitions, error codes, the default English error map,
custom messages and per-parse precedence are unchanged; Node/desktop resolution is unchanged too.
Direct locale subpath imports still resolve normally. A future feature configuring another Zod
locale must add that locale deliberately and measure its bundle cost.

This uses Zod's documented [locale subpaths](https://zod.dev/error-customization#internationalization)
and Metro's [custom resolver](https://metrobundler.dev/docs/configuration/#resolverequest).

`scripts/metro.test.cjs` drives the actual resolver and compares English issues before/after installing
the mobile map. It runs with the app's test command. `pnpm bundle:check --report` measures Hermes
bytecode for both platforms and lists the actual locale source modules, so the namespace reduction
is verified in the real Metro graph. The bytecode ceiling lives only in the architecture skill's
`references/performance.md` and is lowered with each measured reduction.
