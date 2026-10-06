# CLAUDE.md

This file is loaded automatically by Claude Code. The full repo context, code
map, and conventions live in **[`AGENTS.md`](AGENTS.md)** — read it before
working on the code.

## If the user is just getting started

Walk them through setup following **[`ONBOARDING.md`](ONBOARDING.md)** — step by
step, waiting for confirmation after each step.

## Hard rules (do not break them)

1. **Never commit user data.** `data/**`, `statements/**`, `.env`, `*.pem` are
   git-ignored. Before committing, check `git status`; if you see a data file
   staged there — stop and report it.
2. **Never ask for bank passwords/SCA.** Only the user logs in, in the bank's
   browser.
3. **The cloud LLM only ever gets the merchant name** — never IBANs, balances,
   or names. The default backend is local `ollama` (offline).
4. **Net worth is computed per-currency** (never sum currencies); internal
   transfers are matched by IBAN only.
5. **Never run `eb resync` / `reclassify` in a loop** — banks throttle (429).

Note: the dashboard UI and the LLM prompts are intentionally in Polish (the tool
targets Polish banks). Keep them Polish; translate only comments, docstrings,
CLI help, and docs.

## Developer quick start

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]" && cashu init-db
pytest                                        # tests run on synthetic data
cd frontend && npm install && npm run build && cd ..
cashu serve                                 # http://127.0.0.1:8500
```
