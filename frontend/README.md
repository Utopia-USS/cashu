# cashU - dashboard (frontend)

React + Vite + TypeScript SPA. Talks to the FastAPI backend over `/api/*` only;
no business logic lives here.

## Develop (with hot-reload)

Two processes:

```bash
# 1) backend (serves the JSON API on :8500)
cashu serve

# 2) frontend dev server with HMR (proxies /api → :8500)
cd frontend && npm install && npm run dev
```

Open the printed Vite URL (http://localhost:5173). Edits hot-reload instantly.
The proxy adds the backend's per-launch API token, read on every request from
`<data dir>/api-token` (written by `cashu serve`; `CASHU_DATA_DIR` and
`CASHU_PORT` are honoured), so restarting the backend needs no Vite restart.
It does so only for same-origin requests from the dev page itself
(`devProxyGuard.ts`): a request whose `Origin`, `Referer` or `Sec-Fetch-Site`
names another site (another web page you have open, another local port) gets a
403 from Vite and never reaches the backend, so the token cannot be borrowed for
cross-site requests while `npm run dev` runs. Requests without any browser
context (curl, opening `/api/...` in the address bar) still pass.
The built app gets the token without it ever being embedded in the page:
`cashu serve` prints a one-time URL `http://127.0.0.1:<port>/#token=<token>`;
the SPA moves the fragment token to `sessionStorage` (this tab only) and strips it
from the address bar (`core/token.ts`). The desktop app (`cashu app`) hands the
token to the window over the pywebview bridge (`window.pywebview.api.token()`).

## Tests

```bash
cd frontend && npm test
```

Runs the unit tests of the pure helpers (`tests/*.test.mjs`: the dev proxy guard,
the serialized module-save queue, hash decoding) with Node's built-in test runner
(Node 23.6+ strips the TypeScript types itself; no extra dependency). Component
behaviour (profile switch, resync, toggles) is checked in the browser.

## Build (production - served by `cashu serve`)

```bash
cd frontend && npm run build
```

This emits into `../src/cashu/api/webdist/`, which FastAPI serves at `/`.
After building, `cashu serve` alone shows the built app (no Node needed at
runtime). If `webdist/` is absent, FastAPI serves a minimal page
(`src/cashu/api/static/index.html`) that says how to build the frontend.

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
