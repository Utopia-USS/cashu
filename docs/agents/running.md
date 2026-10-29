# Running, demo data and e2e

What this is: how to run and verify the app locally, seed synthetic demo data, and run the browser smoke suite.

## How to use this

The command list is in [CLAUDE.md](../../CLAUDE.md) "Common commands"; this file carries the caveats
behind them. Everything here runs on synthetic data and temp data dirs.

## Running and verifying

| Step | Command / note |
|---|---|
| Environment | `python3 -m venv .venv && source .venv/bin/activate`, `pip install -e ".[dev]"`, `cashu init-db` |
| Tests (synthetic data - safe) | `pytest` |
| Dashboard: backend + built frontend | `cd frontend && npm install && npm run build && cd ..`, then `cashu serve` (http://127.0.0.1:8500) |
| Dashboard in dev mode (HMR), terminal 1 | `cashu serve` (API :8500) |
| Dashboard in dev mode (HMR), terminal 2 | `cd frontend && npm run dev` (Vite :5173, proxies `/api` -> :8500) |
| Preview tools | `.claude/launch.json` has a `dashboard` config - via the preview tools you can run `cashu serve` and verify changes in the browser (net worth, charts, tabs) |
| After `git clone` | `webdist/` is git-ignored - run `npm run build` once, otherwise FastAPI serves `static/index.html`, a minimal page that says how to build the frontend |

## Demo data

`scripts/demo_data.py` fills a data dir with two invented profiles ("Demo Anna", "Demo Piotr")
through the service layer: budget with categorised transactions, transfers and subscriptions, a loan,
assets, a brokerage account imported through the import path with about two years of synthetic prices
and FX rates (no network), a strategy, alerts (owner and agent), watchlist, a finished research run,
a planned deposit, a decision and (Anna) a pending agent import proposal. Dates follow today.

| Rule | Detail |
|---|---|
| `--data-dir` | required |
| Real data dir | refused unless `--force` |
| Idempotent | a second run changes nothing |

| Task | Command |
|---|---|
| Seed | `.venv/bin/python scripts/demo_data.py --data-dir /tmp/cashu-demo` |
| Serve the demo | `CASHU_DATA_DIR=/tmp/cashu-demo cashu serve` (open the printed `#token=` URL) |
| Test the script | `pytest -q tests/test_demo_data.py` (the script twice on a temp dir) |

## Browser e2e (`frontend/e2e/`)

| Fact | Detail |
|---|---|
| Runner | Playwright test runner with the system Chrome (`channel: "chrome"`) |
| Install | `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install` |
| Build | it never builds: run `npm run build` first |
| Global setup | seeds a temp data dir with the demo script, starts `e2e/serve_offline.py` (`cashu serve` with the synthetic market sources and outbound HTTP refused) on a free port, reads the token from the printed URL, and removes everything afterwards |
| Order | specs run one after another (some change the data) |
| Timezone | browser timezone Europe/Warsaw |
| Artifacts | `frontend/e2e/output/` (git-ignored) |
| Run all | `cd frontend && npm run build && npm run e2e` |
| One spec | `npm run e2e -- specs/05-alerts.spec.ts` |

When you change UI copy or structure, keep the specs on roles, labels and aria names rather than long
texts, and update the matching spec in the same change.

## See also

- [conventions.md](conventions.md) - test rules (synthetic data, temp `CASHU_DATA_DIR`, in-memory keyring)
- [extending.md](extending.md) - what to verify after each kind of change
