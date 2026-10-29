# Install and dashboard (source checkout)

What this is: the install steps (step 2) and the dashboard build plus the git-ignore check (step 10)
of `/budget-setup` for a cashU source checkout. A packaged app (cashU.app) needs none of this.

## Step 2 - Prerequisites and install (source checkout only)

Check `python3 --version` (3.12+), `node --version` (18+, for the dashboard), optionally `ollama`.
Missing on macOS: `brew install python node ollama`. Then:

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
cashu init-db          # prints the database location in the per-user data dir
pytest                   # synthetic data only
```

Older checkout with `data/finanse.db` (legacy name): every command prints a notice; the user runs `cashu
migrate-data` (copies the DB, Open Banking sessions and key into the data dir with a backup).

## Step 10 - Dashboard and finish

Packaged app: the user opens cashU.app. Source checkout:

```bash
cd frontend && npm install && npm run build && cd ..
cashu serve            # http://127.0.0.1:8500 (127.0.0.1 only, per-launch token)
```

The user opens it and walks the tabs (Przegląd, Wydatki, Przepływy, Subskrypcje). Opening an `/api/...`
URL directly answers 401, which is expected.

Source checkout only: finally check that user data cannot be committed (prints nothing when all is
well):

```bash
for p in data/cashu.db statements/mbank/x.csv .env key.pem; do git check-ignore -q "$p" || echo "NOT IGNORED: $p"; done
```

Any `NOT IGNORED` line: stop and fix `.gitignore` before the user commits anything.
