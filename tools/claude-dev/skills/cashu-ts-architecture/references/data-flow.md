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
  target + `queryKey(query, args)` (canonical JSON args), with ref-counted subscriptions (the last
  reader leaving releases the live query after a short linger) and structural sharing (unchanged rows
  keep their identity, and a re-run with an equal result re-renders nobody, so list rows and the
  compiler skip work). Code: `packages/store-react` (`useQuery`, `QueryCache`), live re-runs by
  `watchQuery` in `packages/store/src/query.ts`.
- A query is `defineQuery({ id, scope?, run(read, args) })`: `scope` `vault` (default, the current
  profile's store) or `device` (the device store). The id is what crosses the desktop port, so it is
  stable and unique (`<module>.<name>`); args are JSON.
- **Suspends only on the first read when the read is async**: in the Electron renderer the store runs
  in the utility process, so a query with no cached snapshot suspends to the route's `<Suspense>`
  (`use(entry.ready)`, called unconditionally: React tracks `use` by position, and the thenable carries
  React's `status` fields so a settled read returns at once); later changes are pushed. On mobile the
  driver is synchronous (`createSyncClient`) and it never suspends.
- Clients: `createSyncClient(stores)` (`@cashu/store-react/local`, phone and tests: the engine in
  process) and `createPortClient(channel)` (`@cashu/store-react/client`, desktop renderer). The store
  process serves a port with `serveStore` (`./host`): zod-validated messages both ways
  (`./protocol`), only registered query / command ids, `Decimal` and `Money` tagged across the port
  (structured clone drops prototypes), a snapshot pushed only when its encoded value changed.
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
  boundary (React 19 rethrows an error of an async transition there; `run`'s promise then never
  settles). No `error` state to forget. `run` accepts the command's input before zod defaults
  (`Command<I, R, In>`). A device command (`defineDeviceCommand`) writes the device store instead.
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
| Persistent app state (current profile, settings, privacy mode, language pin) | device-local store tables (`@cashu/store/device`: `device_settings`), read with `useQuery`, written by device commands; `ProfileProvider` reads `device.currentVault` and makes that vault the store of every vault query |
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

## Crash model of the view database

The durable copy of a vault is its encrypted segment log (the carrier, S28); the store's SQLite
database (log copy + view) is derived and rebuildable. So the store opens it with `journal_mode = WAL`
and `synchronous = NORMAL`, and commits once per apply batch (no flush per commit).

- **Power loss or a killed app** loses at most the last committed apply batches since the WAL was last
  synced. The database stays consistent (a torn WAL tail fails its frame checksums and is dropped),
  and the sync cursors live in the same transactions as the events they cover, so they roll back
  together: the carrier re-delivers exactly what was lost, and re-delivery is idempotent by eid.
  Local commands are appended to the device's own segment log before the store applies them, so a
  lost local apply is re-applied from there too.
- **A damaged database** (storage that ignores flushes, a database file copied while written) is
  detected when SQLite reports it (CORRUPT / NOTADB, `isCorruption`) and, after a session that was
  not closed cleanly, by `PRAGMA quick_check` on open. `Store.openOrRecover` then deletes the
  database and opens an empty one without cursors; the carrier replays the whole log into it
  (`recovery.test.ts`). An error raised later by an apply is handled the same way.
- Limit: SQLite has no page checksums, so damage confined to cell contents can pass `quick_check`.
  On honest storage it cannot happen (the main file is written only at checkpoints, after the WAL is
  synced); otherwise "rebuild the view" (discard and replay) is the owner's remedy.
