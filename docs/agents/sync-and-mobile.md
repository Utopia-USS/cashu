# Multi-device sync, a mobile app and the TypeScript stack (design spike)

Status: the spike below is the original proposal (2026-10-30). The owner's questions are answered and
the stack is being built as a strangler on the lab branch `ts-stack` (not on `staging` / `main`, not
shipped). What is decided and built now is in "Status" right below; where it differs from the spike
text, the status wins.

## Status (2026-11-01): decided and built

Decided (owner and lead; the plan of record keeps the full list and the scope ids):

- **Strangler**, same repo: Python keeps running and writing; TypeScript packages and apps grow next to
  it (`packages/*`, `apps/*`, pnpm + turbo); a Python module is retired only after TS parity on the
  synthetic demo set and a local copy of real data, translated Python test oracles and a clean shadow run.
  (Since then the strangler finished: the Python app is retired.)
- **Carrier: our own log** (phase 0 spike): Evolu was 30-50x slower, has no folder transport and no
  Node runtime; LiveStore needs a sync backend that sees plaintext and lost data in the spike. The log
  is per profile (vault) and per device: compress-then-encrypt segments (XChaCha20-Poly1305, the
  compression flag inside the ciphertext), a sealed manifest, capped decompression, a segment
  completeness gate; one HLC (`packages/sync` `./hlc`), 32-hex ids, keyed deterministic gids with a
  per-vault salt (HMAC).
- **Transports behind one interface**: the synced folder transport (iCloud Drive / Syncthing, temp +
  rename, conflict copies merged, forks reported) is built; the blind relay waits for the owner's
  answer to question 4 (ciphertext on third-party storage) and runs on synthetic data only until then.
  Each transport declares its consistency.
- **Fetch leader is pinned**: the device that created the vault is the pinned fetch leader on every
  backend (PSD2, prices, rules, imports); it changes only by an explicit owner action signed by a
  non-revoked device or the recovery key; automatic hand-over is an owner opt-in on a relay that
  declares bounded propagation. Every device warns after 36 h without a fetch. This replaces the
  expiring lease of section (b).
- **Devices and trust**: pairing with a short authentication string, revocation with key rotation,
  recovery words (24) as the default way to revoke a device not in the owner's hands, a single
  chain-of-trust rule at every acceptance site. Signed heads / per-device frame signatures are still to
  come and are required before real multi-device use.
- **Conflicts**: per-field last-writer-wins by HLC for short fields; concurrent edits of long text
  (theses, notes) keep both versions as an Obsidian-like conflict copy; tags merge as a union; imports
  are a union with content-hash dedup; decisions, notes and review closures append; deletions are
  tombstones.
- **Imports run on the fetch leader**; another device hands the file over as an encrypted blob, so two
  devices never import overlapping statements on their own.
- **Instruments are per vault**; price and FX caches are device-local, keyed by provider + symbol,
  never synced; the phone first shows leader-computed snapshots, later a compact price snapshot.
- **Desktop = Electron** (Electron 45, single instance, deep links, notifications, tray). The store runs
  in an Electron **utility process** on `node:sqlite` and talks to the renderer over a MessagePort;
  the main process only routes ports. The desktop UI becomes a **new store-backed renderer, ported tab
  by tab**; the legacy SPA over the Python sidecar stays until its last tab is ported. There is no TS
  HTTP API for the legacy SPA.
- **One local host process per data dir** (store, sync, worker, MCP) with Electron, the CLI and the MCP
  stdio server as its clients, also with the app closed: the design is in progress; until it lands
  the TS MCP server, CLI and worker are not built.
- **Mobile = Expo / React Native**, iOS first, Android in scope. UI stack on both platforms: Tailwind v4
  + Uniwind + tailwind-variants, `@expo/ui` for native controls (react-strict-dom / StyleX were
  rejected); charts are shared SVG scenes (DOM svg / react-native-svg). React Compiler on, no manual
  memo; live reads via `useQuery` (useSyncExternalStore).
- **Phone hardening before real data**: encrypted view DB at rest, local notifications from synced
  data (APNs later), signing and TestFlight / Play distribution.
- Proposal approval stays desktop only; the agent never writes strategy files directly; the MCP audit
  stays per device; connector code and approval stay per device (bindings sync, cursors are
  leader-only); rule categories are recomputed on each device, LLM and manual categories ship as
  events.

Built on `ts-stack` (synthetic data in tests; parity on the demo set and a local copy of real data):

- Domain ports with parity: Python-decimal primitives, core net worth per currency, bank CSV parsers
  and dedup, internal transfers (IBAN only) and the cash pool, keyword categorization (Polish rules
  byte-identical) and the LLM port, investments domain, lots / valuation / allocation, performance,
  macro, market sources (leader-only `@cashu/market`), importing (contract, CSV, plan), research pure
  logic, the MCP privacy layer (stricter than Python, thousands of adversarial vectors).
- Store: event catalog v1 with a reference fold and convergence property tests, materializers for
  every synced table, commands for core / budget / loans / assets / investments, crash recovery from
  the encrypted log (WAL + replay), React bindings (`@cashu/store-react`).
- Sync: crypto and keys, carrier engine and contract suite, the own-log carrier, the folder transport,
  devices / pairing / revocation / fetch-leader phase A.
- Bridge: genesis (an existing `cashu.db` -> per-vault event logs), the Python outbox and inbound
  applier behind a lab-only switch (to become a persisted per-vault flag), the shipper (Python writes
  -> encrypted log -> TS view equals the Python DB on a lab copy) in review.
- Apps: the Electron shell over the Python sidecar with the store utility process behind a dev flag;
  the Expo app (expo-router, expo-sqlite store, crypto self-test on iOS and Android, debug screens),
  Hermes bundle under a ratchet ceiling (performance.md).
- Gates: `pnpm arch:check` (layers, imports, knip, catalogs PL / EN, story coverage, TRANSITIONAL
  markers must name a live scope), test tiers (default + exhaustive), parity staleness guard.

Not built yet (planned): budget analytics, loans / assets math, strategy, rules, alerts, investments
views / write services / daily run, research services, the store-backed desktop renderer, the TS MCP
server and CLI, worker and notifications (also with the app closed), connectors host, workspace
renderer, packaging and auto-update, phone screens / edits / pairing UI, the relay, the cut-over and
migration of other installs.

Owner requirements this answers:

- **R1** Obsidian-like sync: every device holds the full data of a profile locally, works offline,
  and devices converge without a central database. Editing on two devices at once never loses data.
- **R2** a mobile app (iOS first, Android possible) in React / React Native, sharing as much code as
  possible with the desktop app.
- **R3** the data-safety rules stay: nothing readable leaves the owner's devices, profiles never mix,
  bank credentials are entered only in the bank's browser, PSD2 is fetched about once a day, net worth
  is per currency, internal transfers are matched by counterparty IBAN only.
- **R4** state of the art, not a stop-gap: the design should hold for years, not just get a read-only
  copy onto a second device.

## Summary

1. **Today cashU cannot sync.** All state lives in one SQLite file in WAL mode (`core/db.py:21`).
   43 tables use autoincrement integer keys (no global ids), nothing records deletions,
   `change_events` (`core/events.py`) is pruned after a day and stores no payloads, run locks are local
   file locks (`core/locks.py`), every start migrates the DB to head (version skew breaks an older
   client), and the worker on each machine would fetch PSD2 and prices on its own.
2. **Python cannot run on the phone**, so R2 forces the domain logic (parsers, net worth, transfers,
   recurring payments, loans, investments rules) into TypeScript at least for what the phone shows. The
   Python code is 84k lines (core 25k, investments 46k, budget 8k, loans 1k, assets 1k) plus 59k lines of
   tests, and it depends on no numeric library (no numpy / pandas), so a port is mechanical, not a
   research problem. Connectors are already Deno / TypeScript (`connector-runtime.md`), the frontend is
   React + TS (33k lines), and the MCP SDK is first class in TS.
3. **Recommendation: one TypeScript monorepo**, local-first with an **encrypted, event-sourced log per
   profile** as the source of truth and SQLite on every device as a materialized, rebuildable view.
   Transport is pluggable: a synced folder (iCloud Drive, Syncthing: the literal Obsidian model, no
   server) or a blind relay that only sees ciphertext. Desktop = Electron (Node runtime for MCP,
   connectors, keychain, Ollama), mobile = Expo / React Native.
4. **Migrate as a strangler, not a big bang.** Python keeps running and becomes the first event
   producer (the `after_flush` hook that feeds `change_events` today is the tap point); a read-mostly
   mobile companion ships early; modules move to TS one by one with the Python test suite as the
   oracle; Python is retired when the last module reaches parity.

## (a) What "state of the art" means here

Local-first sync in 2026 falls into three families:

| Family | Examples | Fit for cashU |
|---|---|---|
| Server-authoritative replication (Postgres on a server, SQLite replica on the client) | PowerSync, Zero, ElectricSQL, InstantDB | **No.** The server holds plaintext; breaks R3. Fine for SaaS, wrong for a local finance app. |
| CRDT databases with E2E encryption | Evolu (SQLite, per-cell LWW with HLC, XChaCha20 E2E, stateless relay, Electron + RN), Jazz (CoValues, crypto groups), Automerge | **Candidates.** Evolu matches R1 + R3 closely. Risks: young (Evolu 8 changed its storage format without a migration path), mnemonic-only accounts, our domain events become row diffs. |
| Event sourcing with a materialized SQLite | LiveStore (Expo adapter on `expo-sqlite`, Node adapter), or our own thin log | **Candidate.** Domain events are an audit trail (what the user decided and when), schema changes become a rebuild instead of a migration, the sync unit is an append-only log. LiveStore has no built-in E2E; its sync backends see events. |

The properties we want, whichever library carries them:

- **Append-only log per device per profile**, encrypted (XChaCha20-Poly1305, libsodium), ordered by a
  hybrid logical clock (HLC) plus device id. Each device writes only its own segment files, so a file
  sync (iCloud) never produces conflicts at the file level, and a relay only stores and forwards blobs.
- **Materialized SQLite on each device**, rebuilt from the log (snapshots for fast start on mobile).
  The app reads SQLite exactly as today; only writes go through events.
- **Conflict rules per entity, explicit in code**: last-writer-wins by HLC for edits (merchant
  category, asset value, alert mute), union with dedup for imports (transactions already dedupe by a
  content hash), append-only for decisions, notes, review closures. Deletions are tombstone events.
- **Global ids** (ULID) for every entity; integer keys stay only inside the materialized view.
- **Forward-compatible events**: versioned event types, upcasters on read; an older client ignores
  unknown types and fields and can still show what it understands. Schema changes rebuild the view.
- **Not everything syncs**: market price history, FX rates and calendars are refetchable caches;
  logs, locks, the API token and absolute paths are per device; Enable Banking keys / sessions and
  connector secrets stay in the device keychain of the device that fetches.

## (b) Security and keys (R3)

- **One data key per profile.** A profile is its own vault: a device without its key cannot read any
  of its segments. This turns rule 7 (profiles never mix) from a query discipline
  into cryptography. A household profile shared by two people = both devices hold its key.
- **Device pairing like 1Password / Signal**: the desktop shows a QR code with the profile key wrapped
  for the new device's public key; keys live in the macOS / iOS Keychain (Android Keystore).
- **Recovery key** (printable, 24 words) per profile, shown once; losing all devices and the recovery
  key loses the data by design.
- **Ciphertext in the cloud is still a decision** (rules 1 and 3 say nothing leaves the machine).
  With the folder transport on iCloud Drive or Syncthing between own devices the data never touches a
  server we run; a relay sees only ciphertext and HLC timestamps (timing metadata).
- **Fetch leader**: one device per profile holds a lease (an event: device, until) and is the only one
  that fetches PSD2, prices and runs the daily worker, so rule 6 holds with many devices. The lease
  moves when the leader is gone for longer than its expiry. Ollama categorization and the MCP server run
  where the owner has a desktop; their results arrive on the phone as ordinary events.

## (c) Target stack

```
cashu/
├── packages/domain/      # pure TS: models, parsers (Polish CSV headers stay Polish), net worth,
│                         # transfers, recurring, loans, investments rules / backtests; no I/O
├── packages/store/       # event types + upcasters, materializers, SQLite schema, queries, HLC
├── packages/sync/        # crypto, key wrapping, segment format, transports (folder, relay), lease
├── packages/ui-logic/    # hooks and view models shared by desktop and mobile (today's *logic.ts)
├── apps/desktop/         # Electron: today's React DOM UI, worker, MCP server (stdio), connectors
│                         # (Deno, unchanged), keychain, Ollama, notifications, auto-update
├── apps/mobile/          # Expo / React Native: expo-sqlite, own UI, charts via react-native-svg
├── apps/relay/           # optional blind relay (Cloudflare Worker + R2, or a tiny Node server)
└── apps/cli/             # `cashu` on Node (the agent's commands keep their names)
```

- **Electron over Tauri**: the desktop needs a Node runtime anyway (MCP server over stdio for the
  owner's Claude Code, connector runner, SQLite, keychain); Tauri would add a Rust shell plus a Node
  sidecar. The current React DOM UI moves into Electron almost as is.
- **UI is shared at the logic level, not the component level**: phone screens are different
  (review deck, alerts, spending, net worth), desktop keeps its dense dashboard. The SVG charts port to
  `react-native-svg`; Recharts stays desktop only.
- **SQLite everywhere**: `node:sqlite` or `better-sqlite3` on desktop, `expo-sqlite` on mobile; the
  same schema and queries from `packages/store`.
- **i18n**: the `*.strings.ts` catalogs move to `packages/ui-logic`; backend `tr()` texts move with the
  modules. Matching data stays Polish.
- **MCP**: the server and its privacy layer (`core/mcp/redaction.py`, `labels.py`) port to TS with
  the tool names unchanged, so the shipped skills keep working; `tests/test_fxb_mcp_privacy.py` becomes
  its first TS test.

## (d) Migration plan

| Phase | What | Ships to the owner |
|---|---|---|
| 0. Spike (1-2 weeks) | Evolu vs LiveStore vs own log on 3 entities (transaction, merchant category, decision): Expo app on iOS + Node, E2E, iCloud folder and relay transports, 60k transactions, cold start and rebuild time, concurrent edits on two devices, one schema change. Pick one. | A written result, no product change |
| 1. Monorepo + sync core | `packages/sync`, `packages/store` for core entities (profiles, accounts, balances, transactions, categories), key management, pairing. Python writes events through its `after_flush` hook and applies inbound events for the few entity types the phone may edit. | Nothing visible yet |
| 2. Mobile companion | Expo app: net worth, cashflow, spending, alerts, review deck, decisions, merchant category fixes. Read-mostly; edits limited to the types Python can apply. | iOS TestFlight build |
| 3. Port modules | budget, assets, loans, then core services, then investments (largest, 46k lines). Each port runs against the same synthetic fixtures as the Python version and must produce identical outputs before the Python module is switched off. | Desktop parity, module by module |
| 4. Electron desktop | Today's UI in Electron, TS worker, TS MCP server, Deno connectors, Sparkle replaced by electron-updater. Python and pywebview retired. | New desktop app, same data |

The guard tests travel with the code: profile isolation, per-currency net worth, IBAN-only transfers,
migration (now: event upcasting and rebuild), skills shape, MCP privacy.

## Risks

- **Size**: 84k + 59k lines is months of work even with agents; phase 3 dominates. The strangler keeps
  the app shippable throughout, at the price of running two runtimes for a while.
- **Dual writers during the transition**: Python and the phone both writing core entities needs the
  conflict rules from day one; keeping phone edits to a few entity types limits the blast radius.
- **Library maturity**: every E2E local-first library is young. Owning the log format (even if a
  library carries it) keeps the data readable if the library dies.
- **iOS file sync**: the iCloud ubiquity container needs a native module and is eventually consistent
  with no change notifications on iOS; the relay transport is the reliable path for live updates.
- **Push notifications** for alerts need APNs and therefore a server; until then alerts show when the
  app opens or via a local notification scheduled from synced data.

## Open questions for the owner (answered; see Status)

Answers: 1 strangler; 2 own log (spike); 3 both behind one interface, folder built first, relay on hold;
4 still open (the relay and any non-synthetic transport wait for it); 5 Electron; 6 Android in scope,
iOS first.

1. **Strangler or big bang?** Recommendation: strangler with an early mobile companion.
2. **Sync carrier**: adopt Evolu (or LiveStore) or own a thin event log on SQLite? Recommendation:
   decide in the phase 0 spike; the lean is an own log format with a library underneath only if it
   keeps E2E and our domain events.
3. **Transport**: iCloud Drive folder only (Apple devices, no server), a self-hosted blind relay, or
   both behind one interface? Recommendation: both, relay as the live path.
4. **Ciphertext on third-party storage** (iCloud, a relay we host): acceptable under rules 1 and 3?
5. **Desktop shell**: Electron (recommended) or Tauri?
6. **Android** in scope from the start, or iOS only at first?
