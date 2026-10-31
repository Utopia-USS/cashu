---
title: Data flow over the local event store
impact: CRITICAL
tags: store, events, queries, commands, forms, state, suspense, electron
---

# Data flow over the local event store

```
intent -> screen hook -> command (zod input) -> append events (HLC, encrypted log) -> materializer
                                                                                         | writes tables T
useQuery snapshots whose read tables intersect T re-run and push <-----------------------+
remote events arrive through sync -> the same materializer -> the same push
```

One path for local and remote changes, so the UI never has two sources of truth.

## One store per vault

- A store is one vault's SQLite database: its decrypted log copy and its view. `Store.open` takes the
  vault gid and the vault's gid salt and refuses a database of another vault.
- View tables have no `profile_id`, and queries never filter by profile: the profile is explicit
  because it is **the store you read**. The app keeps the open stores in a root Context (a stable
  service, keyed by vault gid); the current profile picks the store that screen hooks and `useQuery`
  read, and switching profile switches the store, not a filter.
- A view that combines profiles (a household summary) reads each vault's store and combines the
  results in a ui-logic hook or a service function. Never `ATTACH` two vault databases into one query:
  isolation holds by construction, and each vault rebuilds independently.
- A command writes to exactly one store; an event never names another vault (events.md 1), and the
  store rejects one whose `vault` differs.

## Reading: `useQuery(query, args)`

- Returns the rows directly. Built on `useSyncExternalStore` over a snapshot cache keyed by
  `query.key(args)`, with ref-counted subscriptions and structural sharing (unchanged rows keep their
  identity, so list rows and the compiler skip work).
- **Suspends only on the first read when the read is async**: in the Electron renderer the store runs
  in the utility process, so a query with no cached snapshot throws a promise to the route's
  `<Suspense>`; later changes are pushed. On mobile the driver is synchronous and it never suspends.
- A query is a typed object from `packages/store/src/<module>/queries.ts` (typed builder, row decoder
  returning domain types: `Money`, gids). The UI never sees raw rows.
- **Invalidation is by tables, tracked by the store**: the store records each prepared query's read
  tables, the materializer records the tables an apply touched, and every snapshot whose read set
  intersects re-runs. Nobody lists event types or tables by hand.
- Heavy derivations (net worth series, allocation) are store queries or derived tables the
  materializer maintains, or domain functions; not render-time work.
- Local data never goes through a fetch cache (no SWR / TanStack Query for store data). Remote data
  (prices, FX) is fetched by the leader's services and written into the store; the UI reads it like
  any other table.

## Writing: commands and `useCommand`

- A command lives in `packages/store/src/<module>/commands.ts`: an exported zod `input` schema, then
  validate, read what it needs, decide the events, append them in one batch. Returns a result union
  for expected outcomes (`{ ok: true } | { ok: false; reason: "duplicate" }`). Never writes view tables.
- `const { run, isPending } = useCommand(budget.setMerchantCategory)` wraps `run` in a React 19
  transition. Expected failures come back as the union; unexpected throws reach the nearest error
  boundary. No `error` state to forget.
- No `useOptimistic`: the local apply is the optimistic update.
- Commands with side effects outside the log (connector cursors, notifications, approvals) follow the
  first-writer-wins rules of the event spec and run only on the device that owns them.

## Forms

TanStack Form, validated by **the same zod schema the command exports** (`validators: { onChange:
budget.addCashExpense.input }`, Standard Schema). Form state lives in the screen hook (`useForm`),
field bindings in the View (`form.Field`). Submit calls the command; the command validates again at
the trust boundary. No hand-rolled field state.

## Global state, by kind

| Kind | Mechanism |
|---|---|
| Stable services (store engine, clock, key store, catalogs) | React Context whose value never changes identity, provided at the app root |
| Persistent app state (current profile, settings, privacy mode, language pin) | device-local store tables, read with `useQuery` |
| Ephemeral cross-screen UI state (a shared date range, a multi-select) | Zustand with selectors, in the app or ui-logic (never in Views or packages/ui) |
| Remote data | never in the UI: services write it into the store |

No new ad hoc Context for app data; a broad context re-renders every consumer.

## Events and materializers

- Event schemas follow `packages/store/spec/events.md` (envelope, HLC, conflict rule per entity). A
  new user-authored fact needs: event type + zod schema, the gid rule (`gid.md`), the conflict rule,
  the materializer branch, an upcaster plan and a convergence test with shuffled delivery.
- Materializers are deterministic folds: same set of events, same rows, in any order.
- Device-local or derived-only data never goes into synced events.

## Errors

Expected outcomes are unions returned and shown by the screen hook. Unexpected errors throw to the
route's error boundary (then the root one), which records them in the **local** crash log (Electron
`crashReporter` with `uploadToServer: false`, a rotating log in the data dir on mobile) and offers
retry. Export of a log happens only on the user's action. No cloud crash reporting or analytics SDK,
ever (Biome bans the imports).
