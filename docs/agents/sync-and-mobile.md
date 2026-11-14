# Multi-device sync and the phone companion

What this is: how a profile's data moves between the owner's Mac and phone, what the sync relay sees,
how pairing, the fetch lease and the phone's engine work, how to run the phone against the local
emulator, and what is still planned. The code is the authority; file names are given for each part.

## Current state

- **One encrypted, append-only log per profile (vault) and per device** is the source of truth; every
  device materializes its own SQLite view from it (`packages/sync`, `packages/store`). The log is
  compress-then-encrypt segments (XChaCha20-Poly1305), frames signed by the writing device (Ed25519
  heads), one HLC (`packages/sync/src/hlc.ts`), 32-hex ids and keyed deterministic gids with a
  per-vault salt.
- **The Mac** (the local host, `apps/host`) keeps each vault's own log in a local folder
  (`FolderTransport`, `apps/host/src/nativeVault.ts`) and, when the owner switched sync on for that
  vault, adds the **sync relay** as the vault's only remote (`apps/host/src/relay/service.ts`).
- **The relay is Firebase Firestore, spoken over its REST API** (no Firebase SDK:
  `packages/sync/src/transports/firestore/`), with anonymous Firebase Auth identities. The same code
  runs on the Mac (Node `fetch`), the phone (Hermes `fetch`), the tests (an in-memory fake) and the
  local emulator. The relay only stores and forwards sealed bytes (below).
- **The phone** (`apps/mobile`, Expo / React Native, iOS first) holds either the on-phone demo or the
  vaults it was paired with. A paired vault syncs with the relay; the demo never leaves the phone.
- **Pairing** is a QR code on the Mac plus six digits shown on the phone and typed on the Mac, carried
  over the relay (`apps/host/src/pairing/service.ts`, `packages/sync/src/devices/pairing.ts`). Pairing
  over the local network (LAN) was removed; the host deletes its old `lan-carrier` folder once at
  start (`apps/host/src/host.ts`, `nativeVault/paths.ts`).
- **The Mac is the only device that fetches** (bank, prices, connectors, the daily worker): the
  pinned fetch lease (`packages/sync/src/devices/lease.ts`). Phones never lead.
- Nothing about sync is reachable from the `cashu` CLI or the MCP server: the switch, pairing, purge
  and the status live in the desktop's Settings > Devices (Sync row, pairing card) over the host
  RPCs `native.relay.*` and `native.pairing.*` (`packages/host-protocol/src/relay.ts`,
  `pairing/messages.ts`).

## The sync relay

### What the relay holds

Layout (`packages/sync/src/transports/firestore/layout.ts`, `relayAdmin.ts`, `pairingLink.ts`):

| Document | Fields | Written by |
|---|---|---|
| `vaults/{vault}` | `createdAt`, `admins` (uids), `recoveryHash` | the Mac |
| `vaults/{vault}/members/{uid}` | `device`, `role` (`admin` / `member`), `addedAt` | an admin (the Mac) |
| `vaults/{vault}/recoveries/{uid}` | `proof` (never readable, deleted right after use) | a recovering admin |
| `vaults/{vault}/segments/{device}_{seg}` | `device`, `seg`, `size`, `updatedAt`, `writer`, `rev` | the device that owns the segment |
| `.../segments/{id}/chunks/{start}` | `start`, `end`, `bytes` (ciphertext, at most 700 KiB) | the same device |
| `vaults/{vault}/pairings/{sid}` | `inviter`, `joiner`, `expiresAt`, `createdAt` | the Mac opens it, the phone claims it |
| `.../pairings/{sid}/messages/{n}` | `from`, `n`, `box` (sealed), `part`, `parts`, `createdAt` | the two parties |

So the relay sees: opaque 32-hex vault and device ids, anonymous uids, which uid is bound to which
device id and with which role, segment numbers and sizes, write counters, timestamps (the writer's
clock and the server's), and ciphertext. It never sees a name, an IBAN, an amount, a merchant, a
profile name or a device name: device names travel inside the encrypted registry events.

What a relay operator can still correlate: how many devices a vault has and when each one writes and
how much; that one Mac holds several vaults (the Mac has **one anonymous uid per data dir**, shared by
every vault of that Mac, `apps/host/src/relay/auth.ts`; the phone has one uid shared by every paired
vault, `apps/mobile/src/platform/relayAuthStore.ts`); and whatever Firebase itself logs about the
requests (network addresses, not visible in this code base). Accounts (planned) would link the uids
anyway.

### Security rules

`/firestore.rules` (the header explains every rule and its access budget):

- A vault document is created only together with its creator's admin membership, holds only its known
  fields and is never deleted (a missing document would let anyone re-create the vault id).
- Members are read only by members. Only an admin adds, changes or removes a member; an admin never
  removes, demotes or rebinds itself.
- Segment metas and chunks are written only by the member bound to the device the segment id names.
  A meta is created empty, grows by at most 8 MiB per commit and never shrinks; a chunk is written only
  at or beyond the committed size (committed bytes are never rewritten).
- Abuse caps: segment numbers below 100000, metas up to 64 MiB, chunks up to 700 KiB, four-digit
  pairing message numbers. Anyone can still sign up anonymously and create vaults: no per-uid quota is
  expressible in the rules, so this stays open until accounts exist (planned).
- Pairings: only an admin opens and lists them; whoever knows the session id may read an unclaimed
  one and claim it once before it expires; messages only by the two parties, before expiry.

The in-memory fake (`packages/sync/src/testing/firestore-fake.ts`) applies no rules, so the rules are
tested only against the emulator (Tests, below).

### Membership roles

- `admin`: the Mac that switched sync on for the vault (written in the same commit as the vault
  document). It adds and removes members, opens pairings and may purge.
- `member`: a paired phone. It reads the vault and writes its own segments only.
- The phone as an admin (a trust role on the member document) is planned, not built.
- The role also tells the lease which devices could ever lead: the host keeps each device's kind apart
  from the membership, so a purge, a removal or a re-pair never turns a phone into a possible leader.

### Recovery of the Mac's relay identity

When the anonymous identity's refresh token is refused for good, a new uid is signed up and the old
uid's membership no longer matches (`identityLost` in the status). Enabling sync writes a **recovery
secret** per vault: 32 random bytes kept only in the Mac's OS keychain beside the relay identity
(`@cashu/node-host/relay-auth`), its sha256 stored as `recoveryHash` in the vault document. The
owner's "Reconnect" (`native.relay.reconnect`) proves the secret in one commit: a proof document, its
own admin membership and a new hash, so a secret works exactly once; the old uid's membership is then
removed. A vault enabled before the secret existed, or whose secret the keychain lost, answers
`no_recovery_secret`: only turning sync off and on helps. This relay secret is separate from the
vault's 24 recovery words.

### Switching sync on and off, purge

- The switch is per vault and per Mac (`relay.<vaultId>` in the device store, default off). Turning it
  on or off writes the setting and reopens the vaults (the engine reads its remotes at open).
- **Purge** (`native.relay.purge`) turns the switch off first, then deletes at the relay, in this
  order: every member document except this Mac's (so no phone uploads again: it reads 403 from then
  on), every recovery proof, every pairing with its messages, then every segment with its chunks (at
  most 20 deletes per commit). The vault document stays as a tombstone. A purge that stopped part way
  answers `retry`. A phone whose membership is gone shows that sync was turned off or that it was
  removed (it cannot tell the two apart) and offers "Remove this copy".
- Removing a device (revocation, `apps/host/src/nativeVault/revocation.ts`) needs the vault's
  recovery words, rotates the vault key, and removes the device's relay membership only after the
  revocation batch reached the relay, so a phone still able to pull reads its own removal first
  (`apps/host/src/pairing/members.ts`). A removal the relay refuses is retried after every pass and
  shown as `removalsFailing` until it lands.

### When the Mac syncs

`apps/host/src/relay/service.ts`, `policy.ts`: a pass at vault open, a push 2 s after own writes
(debounced), a pull every 5 minutes while the host runs (at most one per 60 s), a pull every 5 s for
up to 3 minutes while a new phone's first sync is awaited, and one final push before the idle exit.
Every pass runs in the vault's queue like a UI command. After a failure the passes back off: 60 s
doubling to 30 minutes when the relay is unreachable or refuses, 1 h when the daily quota is used up;
reads and writes are judged apart.

## Pairing

Protocol (`packages/sync/src/devices/pairing.ts`): the QR carries the vault id, the Mac's device id and
signing key, an ephemeral key and the expiry, so scanning it in person authenticates the Mac to the
phone. The phone commits to a nonce before it sees the Mac's, then shows six digits derived from the
transcript; the owner **types** them on the Mac (the Mac never shows its own digits), which
authenticates the phone to the Mac. Only then does the Mac seal the vault's keyring for the phone and
send the welcome (certificate, registry events in pages). Every message is sealed; the relay link
(`packages/sync/src/transports/firestore/pairingLink.ts`) only moves boxes, polled every 1.5 s. The
session id is a hash of the QR's ephemeral key, so only someone who saw the QR finds the session; the
first device that claims it is the only other party.

**Commit point** (`apps/host/src/pairing/service.ts`, `apps/host/src/nativeVault/pairing.ts`): the
phone's relay membership (`members/{uid}`, role `member`), written after the six digits matched and the
whole welcome was written to the session. Every check that can refuse runs before it, behind a durable
`admitting` journal row. Before the commit point a cancel, expiry or failure on either side leaves
nothing behind and a new code pairs again. After it nothing refuses: the `device.added` append is
retried until it lands, an unknown outcome is resolved from the relay's member list, and a member
document no device explains is removed after 7 days.

**Session lifetime**: the QR is good for 5 minutes (first claim), the six digits for 2 minutes, the
welcome for 3 minutes; the relay session lives 10 minutes after the invite. When the Mac closes the
link it deletes the session document and its messages (a phone cannot: only an admin deletes).

**States on the Mac** (`native.pairing.inspect`): `pending` (with `phoneConnected` once the phone's
hello arrived and it shows the digits), `waiting_for_phone` (admitted, the phone's first sync has not
reached the Mac), `completed` (its first signed head arrived), `phone_cancelled`, `outcome_unknown`,
`not_started`; refusals include `relay_off` and `no_config`. Cancel before the commit point answers
`cancelled`, after it `already_added` (removing the phone is then a revocation).

**States on the phone** (`apps/mobile/src/screens/pair/pairState.ts`): scan (camera or paste) ->
connecting -> code (the six digits) -> receiving -> storing -> role (owner or partner, for the
notifications) -> first sync, plus `discard` (this phone holds the vault with changes that never
reached the Mac: an explicit yes first) and `failed` (expired, taken, taken here, another sync
project, offline, no sync in this build, refused, failed). Everything before `storing` can be
cancelled and leaves nothing; from `storing` on the pairing only moves forward. The flow survives the
app's remount after the vault was added (`pairFlow.ts`).

## The fetch lease

`packages/sync/src/devices/lease.ts` (spec: `packages/store/spec/events.md` section 8 "The fetch
leader"). Data-safety rule 6 (one bank fetcher per vault) rests on it.

- **Pinned leader**: the device that created the vault is pinned as fetch leader (mode `pinned`, the
  default on every backend). Leadership moves only by an explicit owner action (a pin the owner
  confirmed, or one signed with the recovery key), and the new leader acts only after the old one
  acknowledged, unless the owner forced it. Mode `auto` (automatic hand-over) is an owner opt-in that
  only works over a transport with a declared propagation bound. Every device warns after 36 h without
  a fetch report from the leader.
- **The leader acts only after a recent pull** (within the publish deadline), so it sees a newer pin
  before it fetches. A vault used on one device has no peer to trigger that pull, so every fetch path
  runs the vault's normal sync pass first (`apps/host/src/nativeVault/fetchAuthority.ts`).
- **Offline rule**: in mode `pinned`, a pass that reached every remote it could and missed only
  unreachable ones (network, timeout, 5xx, quota, the host's own back-off) counts as that pull. Why:
  leadership only moves by a person's action, so the worst case is one extra fetch per Mac until they
  see each other, and imports dedupe. So a relay outage pauses sync, never the bank fetch. A refusal
  (this Mac removed, its identity lost) is never an outage. Mode `auto` keeps the strict rule.
- **The 7-day bound**: while the registry holds another device that could be pinned (a second Mac, or a
  device of unknown kind), the offline rule holds only for 7 days after the last complete pull
  (`OFFLINE_LEAD_MAX_MS`). A Mac whose other devices are all phones has no bound.
- **The owner override**: while the bound refuses this Mac, the desktop offers "keep fetching on this
  Mac" (`native.relay.keepFetching`). It records the acknowledgement in the vault's relay setting; the
  bound then counts 7 days from it; the next complete pull clears it. Refused in mode `auto` and for
  any other refusal.
- **Zero remotes** (sync off): a pass with no remote reads as offline since the last complete pull (or
  since the engine opened), so the same rule decides: a sole possible leader keeps fetching, one with
  another possible leader stops after the bound. The last complete pull is kept when sync is switched
  off.

## The phone

### Demo or paired

`apps/mobile/src/services/services.ts`: a phone with paired vaults (`pairedVaults` in the device store)
shows those; otherwise it builds the **companion demo** on first launch (two synthetic vaults,
`apps/mobile/src/fixture/companionDemo.ts`), local only: no relay remote, seeded prices, no app lock by
default. The demo's remaining shortcuts are marked `TRANSITIONAL(S44)`.

What the phone shows (both modes): tabs Today / Activity / Investments / Net worth per enabled module,
the profile sheet with the switch between vaults and Hide amounts, local notifications (counts only,
`apps/mobile/src/notifications/`), the app lock (a screen gate, not a second key). Its reads use the
store entries `@cashu/store/budget/companion`, `@cashu/store/overview/companion` and the derived tables
of `StoreOptions.companionReads` (below). Its commands append to the vault's log through the engine
and reach the Mac with the next push.

### The phone's engine

`apps/mobile/src/services/vaultEngine.ts`, `vaultBootstrap.ts`:

- **Files**: per vault a view database and a private log database `log-<vault>.db` (WAL, synchronous
  FULL) holding the own-log tables of `SqlLogTransport`, the durable command journal, the key
  provenance, the bootstrap row (certificate chain, registry events from the welcome) and the recovery
  checkpoint. Every SQLite file on the phone is SQLCipher under one device key (Keychain item
  `cashu.db.key`); secrets (identity, keyrings, the relay refresh token under `cashu.relay.auth`) live
  in the KeyStore. A file the key does not open is handled per file: a rebuildable one is recreated, a
  paired vault's files are never deleted and the vault shows `needs_repair`
  (`apps/mobile/src/platform/sqliteKeying.ts`).
- **Phases**: `opening` -> `ready`, or `receiving` (paired, profile not arrived yet; commands
  refused), `waiting` (a key rotation is due; another device rotates, never the phone), `removed` (this
  phone was revoked: the wipe is offered), `failed` (fail closed; retried with back-off 1, 5, 30
  minutes when the code allows).
- **Recovery checkpoint** (`packages/sync/src/carrier.ts` `RecoveryCheckpointOptions`,
  `packages/store/src/sync/recoveryCheckpoint.ts`): after a complete local replay the engine records,
  per writer, how far the log was verified, signed by the device. The next open verifies only the
  frames after it. Anything that does not check out (signature, binding to the keyring, log prefix,
  cursors, fork evidence), a tail with a registry or key statement, or a change of `SYNC_RULES_VERSION`
  (`packages/sync/src/engine.ts`: bump it with any change to what a frame yields) replays everything.
- **Verifier port** (`packages/sync/src/crypto/ed25519.ts`): every signature check goes through one
  bound verifier. The Mac and the tests use @noble/curves; the phone binds the native libsodium of
  `react-native-libsodium` (Hermes has no JIT), falling back to @noble whenever libsodium says no, so
  both platforms accept exactly the same signatures.
- **Yields**: the engine applies at most 1500 events per transaction on the phone and yields to the UI
  between slices of about 8 ms, so a long first sync leaves frames to the UI and live queries refresh
  per committed chunk.
- **Triggers** (`apps/mobile/src/sync/syncRunner.ts`, `usePhoneSync.ts`): a pass after the first frame,
  on the return to the foreground (at most every 30 s per vault), every 4 minutes while in the
  foreground, a push-only pass on the way into the background when own writes wait, and inside the iOS
  background task before the notification plan (bounded to 20 s; iOS decides when it runs). A trigger
  that finds a vault still opening runs once the open settled. There is no "sync now" button and no
  push service.
- **Status** (`VaultSyncStatus`): phase, syncing, last complete pull, unpushed own writes, the relay's
  last outcome, progress of a first sync, replay progress, stuck writers (frames the phone cannot read
  yet). Today's banner slot (`useSyncNotice.ts`) turns it into a quiet line (paused, today's limit,
  unreadable changes) or a notice that asks (removed, sync turned off on the Mac, profile does not
  open) with "Remove this copy", always confirmed first.
- "Remove this phone" (`apps/mobile/src/services/wipe.ts`) stops the notification plans, deletes the
  Keychain items, closes and deletes every database and rebuilds the demo.

### Running the phone against the emulator

[running.md](running.md) "Phone against the emulator". The phone reads its relay config at bundle
time (`apps/mobile/src/platform/relayConfig.ts`, template `apps/mobile/.env.example`):

| Variable | Meaning |
|---|---|
| `EXPO_PUBLIC_FIREBASE_PROJECT_ID`, `_API_KEY`, `_APP_ID`, `_AUTH_DOMAIN` | a real Firebase project's web config (public identifiers, still kept out of the repo: `apps/mobile/.env.local` is git-ignored). Plain values, no quotes |
| `EXPO_PUBLIC_FIRESTORE_EMULATOR_HOST`, `EXPO_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST` | dev builds only: the local emulators (loopback, both or neither; half set or not loopback turns sync off). Without project variables the project is `demo-cashu` |

No config: every sync surface on the phone stays off. The Mac host reads its config from
`<data dir>/relay/firebase.json` (a packaged app reads only that), or from a checkout
`CASHU_FIREBASE_CONFIG=<path>`, and switches to the emulators with `CASHU_FIRESTORE_EMULATOR_HOST` and
`CASHU_FIREBASE_AUTH_EMULATOR_HOST` (`apps/host/src/relay/config.ts`). A test build of the host takes
the emulators only.

## Store option `companionReads`

`StoreOptions.companionReads` registers the three derivers only the phone reads (`budget.months`,
`budget.recurring`, `budget.search` FTS5). The phone sets it; the desktop host, the MCP server and the
CLI do not, so the Mac does not pay their write cost. Their tables are out of snapshots and the view
hash; a companion query on a store without them fails with `CompanionReadsOffError`. Details:
`packages/store/spec/events.md` section on companion derivers,
`tools/claude-dev/skills/cashu-ts-architecture/references/performance.md`.

## Tests

| Tier | What | Command |
|---|---|---|
| default | the fake relay (no rules), the engine, lease, pairing, host relay service and pairing, the phone engine under Node (`apps/mobile/src/services/vaultEngine.test.ts`: better-sqlite3 and libsodium-wrappers) | `pnpm test` |
| exhaustive | multi-device simulations, lease and pairing sweeps | `pnpm test:exhaustive` |
| emulator | the real `firestore.rules` and the REST wire shapes against the Firebase emulators (project `demo-cashu`, offline, nothing deployed): `rules.emulator.test.ts`, `firestore.emulator.contract.test.ts`, `pairingLink.emulator.test.ts` in `packages/sync/src/transports/firestore/`; then end to end `apps/host/src/testing/relayE2e.emulator.test.ts` (a native host and a Node joiner composed like the phone's engine: pairing, sync both ways, only allowed fields and no plaintext in the stored documents, purge, a stranger reads nothing) | `pnpm test:emulator` (needs Java 21+ and firebase-tools; CI job `emulator` in `.github/workflows/ts.yml`) |

The emulator files skip themselves inside `pnpm test`; only `pnpm test:emulator` (which starts the
emulators with `firebase emulators:exec`) runs them.

## Data safety as it applies to sync

- Ciphertext only: the relay holds sealed frames and sealed pairing boxes, never a readable value.
  Identifiers at the relay are opaque (random 32-hex ids, anonymous uids); no names.
- One vault per profile at the relay too: a device holds a vault's key only after pairing for that
  vault, and a membership covers one vault.
- Bank fetching stays on the pinned Mac (rule 6); the phone never fetches from a bank.
- Net worth on the phone is per currency, with the NBP-labelled conversion the desktop uses (rule 5).
- Tests and the emulator use synthetic data and the `demo-cashu` project only; the real Firebase
  project's config never enters the repository.

## Planned, not built

- Push notifications (APNs): today the phone notifies only locally from synced data.
- Accounts and paid hosted sync (the Obsidian-like model); they would also close the open sign-up
  (anyone can create vaults today) with a per-account entitlement in the rules.
- The phone as an admin of a vault (adding devices, purging).
- A signed retirement step for an old key after a rotation: a lagging device may still seal a few
  frames under the old key; authenticity holds through signed heads.
- A synced-folder remote (iCloud Drive, Syncthing): the folder transport exists and passes the carrier
  contract, but no app offers it as a remote.
- A Hermes release-build measurement of the phone's open and first sync with the checkpoint (V8
  numbers in `performance.md`).

## Why it is built this way

- **Own log over a library**: Evolu was 30-50x slower and had no folder transport or Node runtime;
  LiveStore's sync backends see plaintext. Owning the format keeps the data readable whatever happens
  to a library.
- **Firestore over REST, no SDK**: one code path on the Mac, the phone and the tests; the cost is that
  the wire shapes are ours to keep right, which is why the emulator tier runs in CI.
- **Claim-based pairing with the Mac writing the membership**: the phone needs no admin rights, and
  one commit point means a failed pairing leaves nothing behind.
- **LAN pairing removed**: the relay carries pairing anyway, and the Mac works fully without it (the
  offline rule above), so the always-reachable LAN path no longer earned its code.
- **Pinned leader**: needs no propagation bound, so it is safe over any transport; automatic hand-over
  depends on timing and stays an opt-in.
- **Conflicts**: per-field last-writer-wins by HLC for short fields, both versions kept for concurrent
  long text, tags as a union, imports as a union with content-hash dedup, decisions and notes append,
  deletions are tombstones (`packages/store/spec/events.md`).
- **What never syncs**: price and FX caches, the MCP audit, connector code and approvals, bank keys and
  sessions (`packages/store/spec/events.md` section 10).
