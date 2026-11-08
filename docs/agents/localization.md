# Localization

What this is: how cashU shows its UI in Polish or English - the language choice, where texts live in
the renderer and the backend (host, CLI, worker, MCP), the rules every change follows, and the PL/EN
glossary.

## What this pattern is

One app-wide UI language, `pl` or `en`. Everything the app **shows** is localized: screen copy,
labels the backend renders (category names, macro cards, alert and signal texts, setup steps, module
names), CLI output and OS notifications. Two kinds of text are **not** localized:

- **Agent content** - research notes, theses, recommendations, market views written by the user's agent
  over MCP. They are shown as the agent wrote them, in the **app language**: the MCP server names it
  in its `instructions` at each session start (`instructionsFor` in `packages/mcp`, read from the
  device pin by `apps/host/src/language.ts`, the same rule the window follows), the workspace
  CLAUDE.md and the shipped skills tell the agent to write everything the owner reads in it (Polish
  when unsure), so the app and the agent never mix languages. Content already stored stays as
  written. The note wording check (`research/patterns.ts`) knows Polish and English forecast and
  advice wording; it warns, never refuses.
- **Matching data** - CSV headers, taxonomy keyword rules, installment phrases, LLM prompts, the word
  lists of `packages/domain/src/investments/research/validation.ts` and `similarity.ts`. They match Polish bank and news text;
  translating them breaks matching ([conventions.md](conventions.md) "Language").

Text already stored before localization (an account named `Gotówka`, a signal message
rendered at generation time) is data: it stays in the language it was written in.

## When this applies

Every change that adds or edits a text a user can see: screen copy, a backend label, an error the
UI shows, CLI output, a notification.

## The language

- Supported: `pl`, `en` (`LANGS` in `packages/i18n/src/lang.ts`).
- Choice: Settings -> Aplikacja/App -> Język/Language: System, Polski, English. Stored as the device
  preference `languagePin` (device store); changing it reloads the window.
- Default ("System"): the first supported language of the OS preference list (`navigator.languages`,
  which Electron takes from the OS), else **English**.
- Where it lives: `@cashu/i18n` (`packages/i18n`, platform free) resolves the UI language from a
  `LanguageSource` the app installs at startup (`apps/desktop/renderer/main.tsx`). Without a source
  the language is English.
- Backend work (host, CLI commands, worker, MCP) never reads the UI's global language: it gets an
  explicit `Translator` (backend rules below).
- Tests switch the UI language explicitly; e2e runs the app with a fixed locale.

## UI rules

1. **No user-visible literal in code.** Every text a user can see (JSX text, `title`, `placeholder`,
   `aria-label`, toasts, error texts, chart labels and tooltips, `confirm()` text) lives in a
   `*.strings.ts` catalog next to the code that uses it (or in `packages/i18n` when shared):

   ```ts
   // packages/i18n/src/loans/Loans.strings.ts (imported as @cashu/i18n/loans/Loans.strings)
   import { catalog, enCount, plCount } from "../index.js";

   export const S = catalog({
     title: { pl: "Kredyty", en: "Loans" },
     installments: {
       pl: (n: number) => plCount(n, "rata", "raty", "rat"),
       en: (n: number) => enCount(n, "installment", "installments"),
     },
   });
   ```

   Use: `S.title`, `S.installments(3)`. The compiler requires every language in every entry, with the
   same type. Generic words (Zapisz/Save, Anuluj/Cancel, Zamknij/Close, Cofnij/Undo, ...) come from
   `C` in `@cashu/i18n/core/common.strings`. Where catalogs live: screen copy in `packages/i18n/src/<core|module>/`
   (one exports subpath per catalog), the catalogs of the shared pure logic next to it in
   `packages/ui-logic/src/<core|module>/`, a screen's own catalog next to it in
   `apps/desktop/renderer/screens/<feature>/`. `packages/i18n` and `packages/ui-logic` are platform
   free (no DOM, React or Node).
2. **A label map is a catalog.** `const TYPE_LABEL: Record<string, string> = { checking: "Konta
   osobiste", ... }` becomes `catalog({ checking: { pl: "Konta osobiste", en: "Checking accounts" }, ...
   })`: the same shape, the language read on each access.
3. **Read the catalog where the text is used**, not into a module-level constant (`const X = S.a` at
   import time). The language is fixed per page load, but tests switch it.
4. **Numbers, money, dates go through `Intl` with `intlLocale()`** (`pl-PL`, or the OS English variant /
   `en-US`). Never hardcode `"pl-PL"`, never append `" zł"`; hand-built `dd.mm.yyyy` is Polish-only.
5. **Plurals:** `plCount` / `plForm` (one, few, many) and `enCount` / `enForm` (one, other) from
   `@cashu/i18n` (through `Intl.PluralRules`).
6. **Do not translate data:** values sent to or compared with the backend (codes, enum values, category
   keys), CSS classes, test ids, story fixtures.
7. **Backend codes:** `@cashu/ui-logic/core/messages` maps backend codes (strategy issues, import warnings,
   proposal summaries, worker outcomes, ...) to labels; English labels sit next to the Polish ones.
8. **The guards** (`pnpm arch:check`, `tools/arch/src/guards/`): `hardcodedText` fails on a Polish
   letter in a non-comment line of UI code outside a catalog (it cannot see Polish without
   diacritics, reviews do); `catalogs` checks every catalog under `packages/` and `apps/` for PL / EN
   parity and plural categories (a `catalog()` keeps its raw entries for it); `backendTranslation`
   keeps backend code on explicit translators.

## Backend rules

The backend (host, CLI commands, worker, MCP, Electron main) uses an explicit immutable `Translator`
from `@cashu/i18n` for each request, command or run; the root `tr()` and `catalog()` getters are UI
only, and the `backendTranslation` guard rejects them in backend code. See
[`packages/i18n/README.md`](../../packages/i18n/README.md) for the settings / OS adapter, precedence
and the `context.tr({ pl, en })` pattern.

1. **Texts rendered for a user go through the context's translator**: `context.tr({ pl, en })` or a
   catalog entry passed to it; a CLI command uses `io.t` (the command's language: `CASHU_LANG` or the
   shell locale, else `language` in `<data dir>/settings.json`, else the OS, else English). Plurals:
   `plCount` / `plForm`, `enCount` / `enForm`. Tests build `createTranslator("en")`.
2. **A label table is resolved when it is read**, never at import: a function taking the translator,
   or a Polish identity field plus display variants resolved through the context
   (`packages/domain/src/core/` registries, taxonomy labels). The Polish field stays the identity:
   MCP, matching and the LLM prompt read it.
3. **Work outside a request** (the worker, OS notifications) snapshots
   `createTranslator(backendI18n.appLanguage())` at the start of the run: `CASHU_LANG` if set, else the
   stored app language (`<data dir>/settings.json`), else the OS language, else English
   (`packages/node-host/src/language.ts`).
4. **MCP output is Polish.** It goes to the agent, not the UI: every tool runs under
   `createTranslator("pl")` (the strict-mode vocabulary check of macro summaries is Polish).
5. **Stored texts are written in the language of the run that generates them** (signal messages,
   notification bodies) and regenerated on the next run; open signals follow a language switch on the
   next run, closed ones keep their language. Data created once with a Polish default (the cash account
   "Gotówka", the default profile "Domyślny", strategy templates) stays as stored; the profile name is
   shown as "Default" in English while it is still the untouched default. Where code matches a stored
   prefix (the draft-thesis prefix), it recognises every language.
6. **Persist codes, not prose,** for new texts stored for later display: store a code + params and
   render it when it is read.
7. **The UI matches some backend texts** (macro `state_label` modifiers, "Koszyk/Bucket <id>",
   "Wyniki kwartalne/Quarterly results <name>"): change both sides together and keep both languages
   matched.

## Texts the UI stores or matches

- A text the app stores and later compares (an alert's generated title, a decision tag inside an
  acknowledgement reason) is compared in **every** language: `inEveryLang(() => render())` from
  `@cashu/i18n`. Markers the code parses (the `decyzja: ` reason prefix) stay fixed.
- Number inputs go through `normalizeNumberInput` (decimal comma in Polish; in English a comma is a
  thousands separator when unambiguous).

## Style of the English copy

- US English, sentence case (as the Polish copy), short. A plain hyphen, never the em dash. The
  ellipsis character `…` where the Polish uses it. Straight quotes in code; the Polish `„…"` becomes
  `"…"`.
- Polish product and legal names stay: IKE, IKZE, PPK, BLIK, NBP, GPW, KNF, PIT-38, Enable Banking.
- Keep the meaning, not the word order: a Polish label that reads naturally may need a different
  English phrasing.

## Glossary (PL / EN)

| PL | EN | PL | EN |
|---|---|---|---|
| Budżet domowy | Home budget | Wartość netto | Net worth |
| Wydatki | Expenses | Przychody / wpływy | Income / inflows |
| Przepływy | Cash flow | Zamknięcie miesiąca | Month close |
| Kategoria | Category | Sprzedawca | Merchant |
| Przelew wewnętrzny | Internal transfer | Wyciąg | Statement |
| Konto osobiste | Checking account | Oszczędności | Savings |
| Gotówka | Cash | Subskrypcje / płatności cykliczne | Subscriptions / recurring payments |
| Majątek | Assets | Nieruchomość | Property |
| Kredyty | Loans | Hipoteka | Mortgage |
| Rata | Installment | Harmonogram spłat | Repayment schedule |
| Inwestycje | Investments | Rachunek maklerski | Brokerage account |
| Opakowanie (IKE, IKZE) | Wrapper (IKE, IKZE) | Wpłata | Contribution |
| Pozycja | Position | Instrument | Instrument |
| Koszyk | Bucket | Alokacja | Allocation |
| Waga | Weight | Dryf | Drift |
| Strategia | Strategy | Reguła | Rule |
| Sygnał | Signal | Alert | Alert |
| Decyzja / dziennik decyzji | Decision / decision journal | Przegląd | Review |
| Teza | Thesis | Obserwowane | Watchlist |
| Research | Research | Makro | Macro |
| Temat | Topic | Sektor | Sector |
| Notowania | Prices / quotes | Wycena | Valuation |
| Propozycja (agenta) | Proposal | Konektor | Connector |
| Profil | Profile | Moduł | Module |
| Agent AI | AI agent | Praca w tle | Background work |
| Sekrety | Secrets | Tryb incognito | Incognito mode |
| Ustawienia | Settings | Aplikacja | App |

## Adding a language

`LANGS` in `packages/i18n/src/lang.ts`, then the compiler lists every catalog entry without it;
`context.tr({ ... })` call sites get the new variant the same way; `LANG_NAME` gets the language's
own name; the OS language lookup (`packages/node-host/src/language.ts`) needs nothing.
