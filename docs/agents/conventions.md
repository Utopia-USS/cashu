# Conventions

What this is: the code, language, versioning, CLI, test and UI-copy rules of the repo, each with its reason, plus the "What NOT to do" list.

## What this pattern is

How the existing code is shaped, so new code fits it. Domain rules (profiles, currencies, transfers,
migrations) live in [data-model.md](data-model.md); step-by-step recipes live in
[extending.md](extending.md).

## When this applies

Every change to `src/`, `tests/`, `frontend/`, `scripts/` or the docs.

## Rules

### Language

1. **The codebase is English** (comments, docstrings, CLI help, docs). Why: it is code language for
   developers.
2. **Two things are intentionally Polish and must stay Polish** - they are domain data, not code
   language:
   - **Dashboard UI strings** in `frontend/` (tab names, buttons, labels) and the category display
     labels. Why: the tool targets Polish-bank users.
   - **Matching data**: CSV column headers detected in the parsers (`#Data operacji`,
     `Rachunek źródłowy`, ...), the ~420 PL keyword rules in `modules/budget/categorize/taxonomy.py`,
     the installment phrases in `modules/loans/patterns.py`, the patterns in
     `engine.py`/`reclassify.py`, and the LLM prompts in `local_llm.py`/`reclassify.py`. Why: they are
     matched against Polish bank transaction text - translating them breaks categorization on real
     data.
3. **Rule of thumb:** if a string is **explanation for a developer** -> English. If it is **data**
   (matched, shown to the user, or sent to the LLM as a prompt/enum) -> leave it Polish.
4. **Never the em dash; use a hyphen** (code, UI copy, docs). Product names (Claude Code, MCP, Enable
   Banking) stay as they are.

### Versions

5. **Never bump the version in a normal change.** Every push to `main` gets a patch bump from the
   `bump-version` workflow (`pyproject.toml` and `src/cashu/__init__.py` together); `[minor]` /
   `[major]` in a commit message asks for a bigger step, `[skip bump]` for none. Pull after pushing
   (the bot commits to `main`). Why: a manual bump collides with the bot's commit.

### Module boundaries

6. **A module never imports another module's internals.** Cross-module needs go through core
   (net-worth contributors, account types, institutions, categorization hooks). Why: modules are
   switched on and off per profile.

### CLI

7. A module's commands live in its `cli.py` and are added by `register(app)` (top level, upstream
   names) and in the module's sub-app (`cashu loans ...`). Resolve the profile with
   `core.cliutil.profile(session)` and print through `core.cliutil.console`. Follow the existing
   pattern. Why: one console lets tests and callers redirect all output in one place.

### Tests

8. `pytest`. **Always synthetic data. Never paste real statements.** Point `CASHU_DATA_DIR` at a temp
   dir (never the real data dir) and use an in-memory keyring backend for secrets. Why: the repo must
   never hold real financial data (see the data-safety rules in [CLAUDE.md](../../CLAUDE.md)).
9. Helpers: `conftest.seed_demo(session, profile_id=...)` seeds a synthetic household into any
   profile; `tests/upstream_db.py` builds an upstream-shaped database for migration tests.

### Frontend copy (UI text is Polish, minimal and glanceable)

Before adding or changing a string:

10. A screen, card or widget never explains what it is for: the title and the data say it. No
    paragraph under a heading; context needed less than monthly goes into a tooltip (`title` on the
    label, switch or button), never an inline `<p className="muted">`.
11. Labels are 1-3 word nouns (table headers one word where possible); buttons are 1-2 word verbs
    (Zapisz, Importuj, Cofnij, Utwórz); the object is implied by the card.
12. Empty state = one line (a state, not an apology) + one action button. Errors say what to do in the
    same line: "Nie udało się X: {detail}" or "{problem}. {action}." (no "Próbuję ponownie", no
    apology).
13. Only two kinds of notes, one sentence each: privacy / safety (what the agent sees, that in-app
    analyses never leave the machine, an agent write is always a proposal approved in the app) and
    irreversible actions. "Nothing leaves the machine" only where literally true (the app's own
    analyses); never imply that what an agent gets through MCP stays local: MCP tool results go to the
    Claude API. Shared copy lives in one constant (e.g. `PRIVACY_OPTIONS`, `PROPOSAL_NOTE`), never two
    versions on two screens.
14. Numbers first: `12 400 zł · 3 konta`. Status words are single adjectives / short tags (gotowy,
    w toku, nieaktualne). Refresh mechanics stay invisible ("co 5 s", "na żywo", "odświeża się").
15. Backend codes get Polish labels in `frontend/src/core/messages.ts` (strategy issues, import
    warnings, proposals, `X-Cashu-Error-Code` errors, `perf.<code>`, `worker.<code>`); the English text
    is only the fallback.
16. When you change UI copy or structure, keep the e2e specs on roles, labels and aria names rather
    than long texts, and update the matching spec in the same change. Why: long texts change often and
    make the specs brittle.

## What NOT to do

| Don't | Why |
|---|---|
| Sum different currencies into a single net-worth figure | net worth is per currency ([data-model.md](data-model.md) rule 3) |
| Match internal transfers by name/amount - IBAN only | names caused false positives |
| Run `eb resync` / `reclassify` in a loop; sync ~once a day | banks throttle PSD2 (429), and the local LLM is slow |
| Overwrite an existing account's type, or its name with the owner name from OB | keeps the type and name the owner chose (the OB owner name is a person's name, not an account name) |
| Query a profile-scoped table without the profile (accounts, rules, transactions through their account) | data of one profile must never show up in another |
| Commit anything from `data/` or `statements/` | real financial data (data-safety rule 1) |
| Add zoom/pan plugins to Chart.js | they were removed as janky |

## See also

- [data-model.md](data-model.md) - domain rules
- [extending.md](extending.md) - recipes: bank, module, dashboard feature, migration, MCP tool
- [running.md](running.md) - running, demo data, e2e
