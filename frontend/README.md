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
The proxy adds the backend's per-launch API token, read on every request from
`<data dir>/api-token` (written by `finanse serve`; `FINANSE_DATA_DIR` and
`FINANSE_PORT` are honoured), so restarting the backend needs no Vite restart.
The built app instead gets the token from a `<meta name="finanse-token">` tag
that `finanse serve` injects into `index.html`.

## Build (production — served by `finanse serve`)

```bash
cd frontend && npm run build
```

This emits into `../src/finanse/api/webdist/`, which FastAPI serves at `/`.
After building, `finanse serve` alone shows the built app (no Node needed at
runtime). If `webdist/` is absent, FastAPI falls back to the legacy single-file
dashboard at `src/finanse/api/static/index.html`.

## Demo backend (no Python needed)

```bash
cd frontend && VITE_MOCK=1 npm run dev
```

Routes every `/api` call to an in-memory demo backend with invented data
(`src/core/mock.ts`). Scenarios via the query string: `?mock=first` (no profile
yet, first-launch wizard), `?mock=one`, `?mock=two` (default). Off unless the
flag is set; a normal build contains no mock code.

## Layout

- `src/core/` - the shell: `App` (first launch vs shell), `Shell` (header,
  profile switcher, module tabs, routing via `#/{slug}/{view}`), `Wizard`,
  `SetupPage` (module blank page driven by `/api/p/{slug}/modules/{id}/setup`),
  `Settings`, `Overview` (composed from module widgets), `api.ts` (transport
  with the token header, platform + core endpoints), `registry.ts` (frontend
  modules in navigation order), `types.ts` (the `ModuleDef` contract), `theme.ts`.
- `src/modules/<id>/` - one folder per module (`budget`, `loans`, `assets`,
  `investments`): its tabs, its endpoints (`api.ts`) and `index.tsx` exporting
  the `ModuleDef` (tabs, overview KPIs/facts, SetupPage copy).
- `src/components/*` - shared charts and cards (NetWorthChart, ScrollableChart,
  CashCard, Accounts, Breakdown).
- `src/ui.tsx` - primitives (Kpi, Seg, skeletons, Tag, Notice, Stepper,
  SetupSteps, Menu, ChoiceCard, RadioList, Switch, Code, toast).
- `src/hooks.ts` - `useAsync`, `usePoll`, `useWidth`; `src/format.ts` -
  formatters, palette, Polish plurals, CSS-var reader.

To add a module page: add its endpoints to `src/modules/<id>/api.ts`, a tab
component, and list it in that module's `ModuleDef`. Every profile-scoped call
takes the active profile's slug (`useSlug()`). Charts use Recharts.
