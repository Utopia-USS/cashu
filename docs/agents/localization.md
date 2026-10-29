# Localization

What this is: how cashU shows its UI in Polish or English - the language choice, where texts live in
the frontend and the backend, the rules every change follows, and the PL/EN glossary.

## What this pattern is

One app-wide UI language, `pl` or `en`. Everything the app **shows** is localized: dashboard copy,
labels the backend renders (category names, macro cards, alert and signal texts, setup steps, module
names) and OS notifications. Two kinds of text are **not** localized:

- **Agent content** - research notes, theses, recommendations, market views written by the user's agent
  over MCP. They are shown as the agent wrote them; the language is the agent's choice.
- **Matching data** - CSV headers, taxonomy keyword rules, installment phrases, LLM prompts, the word
  lists of `research/validation.py` and `research/similarity.py`. They match Polish bank and news text;
  translating them breaks matching ([conventions.md](conventions.md) "Language").

Text already stored in the database before localization (an account named `Gotówka`, a signal message
rendered at generation time) is data: it stays in the language it was written in.

## When this applies

Every change that adds or edits a text a user can see: dashboard copy, a backend label, an error the
UI shows, a notification.

## The language

- Supported: `pl`, `en` (`LANGS` in `frontend/src/i18n.ts`, `LANGS` in `src/cashu/core/i18n.py`; keep
  them in sync).
- Choice: Settings -> Aplikacja/App -> Język/Language: System, Polski, English. Stored in browser
  storage (`cashu.lang`); changing it reloads the page.
- Default ("System"): the first supported language of the OS / browser preference list
  (`navigator.languages`, which WKWebView takes from macOS), else **English**.
- The frontend sends the effective language on every request as `X-Cashu-Lang` (`authHeaders` in
  `core/api.ts`); the backend renders its texts in that language.
- Node tests run in Polish (`lang()` outside a browser), so existing assertions keep their Polish text;
  `setLanguageForTests("en")` switches. Playwright runs with `locale: "pl-PL"`.

## Frontend rules

1. **No user-visible literal in code.** Every text a user can see (JSX text, `title`, `placeholder`,
   `aria-label`, toasts, error texts, chart labels and tooltips, `confirm()` text) lives in a
   `*.strings.ts` catalog next to the code that uses it:

   ```ts
   // src/modules/loans/Loans.strings.ts
   import { catalog, enCount, plCount } from "../../i18n.ts";

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
   `C` in `src/common.strings.ts`.
2. **A label map is a catalog.** `const TYPE_LABEL: Record<string, string> = { checking: "Konta
   osobiste", ... }` becomes `catalog({ checking: { pl: "Konta osobiste", en: "Checking accounts" }, ...
   })`: the same shape, the language read on each access.
3. **Read the catalog where the text is used**, not into a module-level constant (`const X = S.a` at
   import time). The language is fixed per page load, but tests switch it.
4. **Numbers, money, dates go through `Intl` with `intlLocale()`** (`pl-PL`, or the OS English variant /
   `en-US`). Never hardcode `"pl-PL"`, never append `" zł"`; hand-built `dd.mm.yyyy` is Polish-only.
5. **Plurals:** `plCount` / `plForm` (one, few, many) and `enCount` / `enForm` (one, other) from
   `i18n.ts`.
6. **Do not translate data:** values sent to or compared with the backend (codes, enum values, category
   keys), CSS classes, test ids, mock data (`mock.ts`).
7. **Backend codes:** `core/messages.ts` maps backend codes (strategy issues, import warnings,
   proposal summaries, worker outcomes, ...) to labels; English labels sit next to the Polish ones.
8. **The guard:** `tests/i18n-guard.test.mjs` fails on a Polish letter in a non-comment line outside a
   catalog. It cannot see Polish without diacritics; reviews do.

## Backend rules

1. **Texts rendered for the UI use `cashu.core.i18n`.** `tr(pl=..., en=...)` returns the variant of
   the current language: the request's `X-Cashu-Lang` (set by `LanguageMiddleware`), else the app
   language. Plurals: `pl_count` / `pl_form`, `en_count` / `en_form`. Tests:
   `with i18n.use_language("en"): ...` or a request with the header.
2. **A label table is resolved when it is read**, never at import: a function with `tr()`, or a Polish
   field plus an English one read through an accessor (`NetWorthBucket.label_en` / `.display_label`,
   `AccountTypeInfo.label_en`, `ModuleSpec.name_en` / `.display_name()`, `Institution.name_en`,
   `Segment.label_en`, `taxonomy.label(key)`). The Polish field stays the identity: MCP, the CLI and
   the LLM prompt read it.
3. **Work outside a request** (the background worker, OS notifications, the desktop boot page) uses the
   app language (`app_language()`): `CASHU_LANG` if set, else the language the dashboard last sent
   (stored in `<data dir>/settings.json` by the middleware), else the OS language, else English.
4. **MCP output is Polish.** It goes to the agent, not the UI: `CashuMcp.call` runs every tool under
   `use_language("pl")` (the strict-mode vocabulary check of macro summaries is Polish).
5. **Stored texts are written in the language of the run that generates them** (signal messages,
   notification bodies) and regenerated on the next run; open signals follow a language switch on the
   next run, closed ones keep their language. Data created once with a Polish default (the cash account
   "Gotówka", the default profile "Domyślny", strategy templates) stays as stored; the profile name is
   shown as "Default" in English while it is still the untouched default. Where code matches a stored
   prefix (the draft-thesis prefix), it recognises every language.
6. **Persist codes, not prose,** for new texts stored for later display: store a code + params and
   render it when it is read.
7. **The frontend matches some backend texts** (macro `state_label` modifiers, "Koszyk/Bucket <id>",
   "Wyniki kwartalne/Quarterly results <name>"): change both sides together and keep both languages
   matched.

## Texts the frontend stores or matches

- A text the app stores and later compares (an alert's generated title, a decision tag inside an
  acknowledgement reason) is compared in **every** language: `inEveryLang(() => render())` in
  `i18n.ts`. Markers the code parses (the `decyzja: ` reason prefix) stay fixed.
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

`LANGS` in `frontend/src/i18n.ts` and `src/cashu/core/i18n.py`, then the compiler lists every catalog
entry without it (frontend); on the backend `tr()` gets a new keyword argument (every call site, plus the
`*_en` fields and `*_EN` tables become per-language); `LANG_NAME` gets the language's own name; the
desktop boot page and `os_language()` need nothing.
