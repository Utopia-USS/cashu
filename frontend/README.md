# finanse — dashboard (frontend)

React + Vite + TypeScript SPA. Talks to the FastAPI backend over `/api/*` only;
no business logic lives here.

## Develop (with hot-reload)

Two processes:

```bash
# 1) backend (serves the JSON API on :8500)
finanse serve

# 2) frontend dev server with HMR (proxies /api → :8500)
cd frontend && npm install && npm run dev
```

Open the printed Vite URL (http://localhost:5173). Edits hot-reload instantly.

## Build (production — served by `finanse serve`)

```bash
cd frontend && npm run build
```

This emits into `../src/finanse/api/webdist/`, which FastAPI serves at `/`.
After building, `finanse serve` alone shows the built app (no Node needed at
runtime). If `webdist/` is absent, FastAPI falls back to the legacy single-file
dashboard at `src/finanse/api/static/index.html`.

## Layout

- `src/api.ts` — typed client + response shapes (mirror the backend JSON).
- `src/hooks.ts` — `useAsync` (fetch + reload), `useWidth`.
- `src/format.ts` — currency/date formatters, palette, CSS-var reader.
- `src/tabs/*` — one component per dashboard tab (Overview, Expenses, Flows,
  Subscriptions, Loan).
- `src/components/*` — charts and cards (NetWorthChart, SpendingDonut, CashCard,
  Accounts, Breakdown).

To add a feature: add the endpoint to `api.ts`, then a component/tab. Charts use
Recharts (declarative — no imperative canvas handling).
