---
title: UI copy, plurals and formatting
impact: HIGH
tags: i18n, strings, plurals, intl, polish
---

# UI copy, plurals and formatting

Every text the app shows exists in Polish and English (`docs/agents/localization.md`). Matching data
(CSV headers, keyword rules, LLM prompts) stays Polish and never goes through a catalog.

## Catalog shape

```ts
// apps/mobile/src/screens/merchants/merchants.strings.ts
export const merchantsStrings = {
  emptyTitle: { pl: "Wszystko skategoryzowane", en: "Everything is categorized" },
  pickFor: { pl: (name: string) => `Kategoria dla ${name}`, en: (name: string) => `Category for ${name}` },
  merchants: {
    pl: { one: "# sprzedawca", few: "# sprzedawcy", many: "# sprzedawców", other: "# sprzedawcy" },
    en: { one: "# merchant", other: "# merchants" },
  },
} as const satisfies Catalog;
```

- One catalog per screen or component (`X.strings.ts`), next to it.
- Values are strings, functions (same parameters in both languages) or plural objects.
- Views read static copy with `useStrings(catalog)` from `@cashu/i18n`; the screen hook builds only
  dynamic labels. Components hold no copy except accessibility defaults.

## Plurals

Polish needs `one / few / many / other`, English `one / other`. The i18n layer resolves them with a
cached `Intl.PluralRules(lang)` per language (works on Hermes): `t.merchants(count)` picks the form
and fills `#` with the formatted number. Never build plurals with `count === 1 ? ... : ...`.

## Numbers and dates

`Intl.NumberFormat` / `DateTimeFormat` instances are created once per locale in the i18n layer and
reused; money goes through the value components, which use them.

## Checked

`tools/arch/src/guards/catalogs.test.ts` imports every `*.strings.ts` / `strings.ts` under packages/
and apps/ and fails on an entry missing a language, a pl / en type or arity mismatch, an empty text,
or a plural missing a category `Intl.PluralRules` requires (a runtime `catalog()` of `@cashu/i18n` is read
through the raw entries it keeps under `Symbol.for("cashu.catalog.entries")`).
`tools/arch/src/guards/hardcodedText.test.ts` fails on a Polish letter in a non-comment line of UI code
(packages/i18n, packages/ui-logic, packages/ui, apps/) outside a catalog.
