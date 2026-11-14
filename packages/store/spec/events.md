# cashU event catalog v1.3 (normative)

Status: v1.3 (S29c-B4, 2026-11-03), building on v1.2 (scope S04, 2026-10-31), after the independent review and its v1.1 re-check
(`~/cashu-lab/checkpoints/S04-review.md`) and the lead's decisions on both. Consumers: S23 store-core,
S24/S25 materializers, S26 genesis, S28a carrier contract, S29 devices / lease,
S31a/b bridge.

Companion documents: [`gid.md`](gid.md) (global ids, keyed DET construction, id-coupled strings).
Machine schemas: `packages/store/src/events/v1/*.ts` (zod). The convergence-critical rules are
executable as scenarios with explicit expected views (`packages/store/src/testing/scenarios.ts`), run
against the store under shuffled delivery in `src/convergence.test.ts` (a few orders) and
`src/convergence.exhaustive.test.ts` (40 orders, duplicates, every prefix).
The zod schemas are normative for field names and types, this document for semantics. Where they
disagree it is a bug in one of them: fix both in the same change.

MUST / MUST NOT / SHOULD are used in the RFC 2119 sense.

## 1. Model

- One **vault** = one profile. Every event belongs to exactly one vault and is encrypted with that
  vault's key (rule 7 becomes cryptographic). Nothing in an event refers to another vault.
- The **log** of a vault is the set of all events of all its devices. Each device appends only its
  own events. The log is append-only and immutable: an event is never edited or removed.
- The **view** (SQLite, today's table and column names minus `profile_id`, plus `gid`) is a pure
  function of the set of events a device holds. Two devices holding the same set MUST produce the same
  view, whatever the order or duplication of delivery (convergence). The view is rebuildable at any
  time.
- **One view database per vault** (lead decision, S23). A device keeps one SQLite database per vault
  it holds: that vault's decrypted log copy and its view. A store instance is bound to one vault and
  refuses a database that belongs to another. Hence view tables carry no `profile_id` column and no
  query filters by profile: isolation between profiles holds by construction (rule 7), each vault
  rebuilds on its own, and a device may hold any subset of the owner's vaults (a phone with one
  profile). The vault is chosen by opening its store; a screen that combines profiles reads each
  vault's store and combines the results in code, never in one SQL statement (no `ATTACH` of two
  vault databases). Device-local state that does not sync (section 10) lives outside the view tables.
- Writers never write the view directly: a command validates against the current view, emits one
  batch of events, and the materializer applies it like any inbound batch.
- **What is plaintext** (own-log carrier, spike-result.md): only the segment address
  (`<vault routing id>/<device>/<seq>.seg`), the frame offset and length, and the AEAD nonce. Every
  envelope field (`eid`, `hlc`, `type`, `gid`, `data`, ...) is inside the ciphertext, and the segment
  address is the frame's AAD. Gids are additionally keyed with a per-vault secret salt
  ([`gid.md`](gid.md) 3), so a gid that leaks (a log line, a bug report) confirms nothing. The MCP server
  never returns gids to an agent; it keeps opaque per-session refs (`core/mcp/labels.py` REF ids).

## 2. Envelope

Logical form (what readers, reducers and tests see):

```json
{
  "eid": "01JC0Z9A2B3C4D5E6F7G8H9J0K",
  "vault": "5f0c3a9e81d24b7690ae13c7d2f4b856",
  "device": "3f9a2c8e1d7b4a6050c3e9f12d8b7a64",
  "hlc": "0mvwcmtc0-0000-3f9a2c8e1d7b4a6050c3e9f12d8b7a64",
  "at": "2026-10-31T12:00:00.000Z",
  "type": "alert.statusSet",
  "v": 1,
  "gid": "01JC0ZA1B2C3D4E5F6G7H8J9K0",
  "data": { "status": "muted", "snoozedUntil": null },
  "cause": "01JC0Z9A2B3C4D5E6F7G8H9J0A"
}
```

| Field | Required | Format | Meaning |
|---|---|---|---|
| `eid` | yes | ULID (26 chars, Crockford base32, upper case) | Event id. Idempotency key: an event with an `eid` already applied is a no-op. Target of `cause`. |
| `vault` | yes | vault id: 32 lower-case hex ([`gid.md`](gid.md) 2) | The profile's vault gid (= the profile gid, S27 `createVaultId`). MUST equal the vault of the segment it was read from. |
| `device` | yes | 32 lower-case hex, not all zero | The writing device's id (S27 `DeviceIdentity`, minted at pairing, S29). MUST equal the segment's device. |
| `hlc` | yes | section 3 | Hybrid logical clock stamp. Its device suffix MUST equal `device`. |
| `at` | yes | timestamp (section 4) | The writer's wall clock when the event was created. Default domain time (4.4); never used for ordering. |
| `type` | yes | `<entity>.<verb>`, `^[a-z][a-zA-Z]*\.[a-z][a-zA-Z]*$` | Event type (section 8). |
| `v` | yes | integer >= 1 | Schema version of this type's payload. Every v1 catalog type is at `v: 1`. |
| `gid` | yes | gid ([`gid.md`](gid.md)); the vault id for `profile.*` events | The entity the event is about (the row it creates or changes, as the writer saw it; identity resolution may redirect it, 6.4). |
| `data` | yes | JSON object | Payload, validated by the (type, v) schema. |
| `cause` | no | ULID | The `eid` of the event that caused this one in the same batch (side effects of an approval, a candidate acceptance). Causal suppression (6.6). |
| `origin` | no | `genesis` | `genesis`: produced by the genesis exporter (S26); absent on events the app writes. Any other value is invalid. Informational; reducers MUST NOT branch on it. |

Rules:

- The total order of events is `(hlc, eid)`: `hlc` first, `eid` only breaks the tie that a
  rolled-back device could create (3.2).
- An `eid` seen again with a different body is corruption: keep the first applied, reject the other,
  report it.
- The envelope is a loose object: unknown envelope fields MUST be preserved and ignored.

### 2.1 Wire form (own-log carrier)

The decided carrier (spike-result.md, "own thin log") frames events as `EventEnvelope { t, v, h, d }`
with the device implied by the segment. v1.1 keeps those keys and adds what the domain needs:

| Wire key | Logical field | Why the spike did not have it |
|---|---|---|
| `t`, `v`, `h`, `d` | `type`, `v`, `hlc`, `data` | (same) |
| `i` | `eid` | `cause` references, rollback tie-break, idempotency independent of segment offsets |
| `g` | `gid` | delete / mark events carry no subject in `data` |
| `a` | `at` | domain timestamps (4.4) |
| `c`, `o` | `cause`, `origin` | causal suppression, provenance |
| (segment) | `vault`, `device` | implied by `<vault>/<device>/<seq>.seg` and authenticated as AAD; re-attached on read |

`toWire` / `fromWire` in `envelope.ts` implement the mapping; unknown keys travel under their own
names. A frame event whose HLC device suffix differs from its segment's device is rejected.

## 3. Hybrid logical clock

### 3.1 Format

```
<wall>-<counter>-<device>             ("wall36-counter36-device", as in the spike)
wall    = 9 chars base36 [0-9a-z], zero-padded: milliseconds since 1970-01-01T00:00:00Z
counter = 4 chars base36, zero-padded: 0 .. 1679615 (zzzz)
device  = 32 chars [0-9a-f]: the writing device id (S27, lower-case hex)
regex   = ^[0-9a-z]{9}-[0-9a-z]{4}-[0-9a-f]{32}$
```

Example: `2026-10-31T12:00:00.000Z` = `1793448000000` ms = `0mvwcmtc0`, so the first event of a device
in that millisecond is `0mvwcmtc0-0000-<device>`. 9 base36 digits hold wall times up to year 5188.

### 3.2 Comparison

- `a < b` iff `a` sorts before `b` by plain code-unit string comparison (JS `<`, SQLite `BINARY`,
  Python `<` on `str`). Fixed widths and lower-case digits (base36, hex) make this the numeric order
  of `(wall, counter, device)`; the device id is the tie-break between devices.
- A correct device never reuses an `hlc`. A device whose state was rolled back (restored backup,
  cloned disk) can; `eid` then breaks the tie (2). A device that finds its persisted clock behind its
  own events already in the log MUST stop writing and get a new device id (S29).

### 3.3 Generation (normative for the HLC in `@cashu/sync`)

State per device per vault: `last = (wall, counter)`, persisted durably with the events it stamped.

- **Send**: `pt` = physical ms. If `pt > last.wall`: `(pt, 0)`, else `(last.wall, last.counter + 1)`.
- **Receive** (every applied remote event, before the next local stamp): `w = max(pt, last.wall,
  remote.wall)`; counter = 1 + the max counter among the inputs equal to `w`, or 0 when only `pt`
  equals `w`.
- **Counter overflow**: `(wall + 1, 0)`.
- **Emit guard (O7)**: a device MUST refuse to stamp (and show a clock error) while `pt` is behind
  its persisted `last.wall` by more than 5 minutes; receivers accept every event (convergence) and
  warn when a remote wall is more than 5 minutes ahead of `pt`. Such a far-future remote event is
  applied but NOT merged into the receiver's `last` (the Receive rule skips its wall), so one device
  with a wrong clock cannot drag every other device's clock into the future (S28a, `packages/sync`
  clock). Pairing (S29) compares the clocks of the two devices and refuses a skew above 5 minutes.
- The single HLC implementation lives in `@cashu/sync` (`./hlc`); the store imports it.
- Genesis stamps its events with the generating device's clock, in dependency order.

## 4. Encoding rules

### 4.1 JSON

UTF-8 JSON, no `NaN` / `Infinity`, key order irrelevant. Strings stored exactly as written (no Unicode
normalization, no trimming) unless a field says otherwise; matching data stays byte-identical.

### 4.2 Absent vs null

In change events a key that is **absent** leaves the field unchanged; present with `null` **clears**
it. In create events an absent optional key means null unless the type says "absent = keep" (topic
draft `invalidation`, market-view `sources`).

### 4.3 Values

| Kind | Format |
|---|---|
| Decimal | JSON string, plain notation, `^-?(0\|[1-9][0-9]*)(\.[0-9]+)?$`, scale preserved (`"10.50"`). Exponent forms rewritten by the writer (Python `format(d, "f")`). Never a JSON number. Floats stored by Python (the `budget.json` cushion) are rendered with Python `repr` then `format(Decimal(repr(x)), "f")` (TS `floatRepr` in `packages/domain/src/decimal.ts`). |
| Calendar date | `YYYY-MM-DD`. |
| Timestamp | UTC `YYYY-MM-DDTHH:MM:SS[.f{1,6}]Z`; TS writers emit 3 fractional digits, genesis keeps Python's 6. Naive SQLite datetimes are UTC. |
| Currency | `^[A-Z]{3}$`; instrument / quote currencies `^[A-Z0-9]{2,10}$`. |
| Reference | a gid ([`gid.md`](gid.md)), never a local integer id. |
| JSON blob | JSON object; every id inside is a gid ([`gid.md`](gid.md) 6). |
| Number in event data | A safe integer only. Event data, the native batch proof (`packages/sync/src/batchProof.ts`) and every hash over it hold integers, so they are byte-identical on every device; an emit with any other number is refused (`command.ts`). A free JSON blob (`params`, `payload`, `stats`, `details`, `raw`) that holds a float (an agent's `max_weight: 0.5`, a signal's `weight`) is written by `eventBlob`: each such number becomes Decimal text as above (`"0.5"`), and its path (key / array-index segments) is listed in the sibling field `<blob>Floats` (`payloadFloats: [["rule","params","max_weight"]]`, absent when there is none). The fold restores those numbers (`restoreFloats`), so views and readers keep the JSON numbers; events without the sibling are read as written. |
| Informational labels | open lower-case keys, not enums, where Python treats them as free labels (rule-run `trigger`, alert `createdBy`, proposal `source`) so real data never parks (M4). Enums stay for values with behaviour. |

### 4.4 Domain timestamps

The **domain time** of an event for a view column `c` is `data.stamps[c]` when present, else the
payload's explicit field for it (`doneAt`, `observedAt`, `expiresAt`, `seenAt`, ...), else `at`.

- Every column set "when this happened" (`created_at`, `updated_at`, `added_at`, `enabled_at`,
  `plan_at`, `view_updated_at`, `acknowledged_at`, ...) takes the domain time of the event that set
  it. Derived timestamps (section 9) take the domain time of the event that triggered the change.
- `stamps` is an optional typed object on every payload: view column name -> timestamp or null.
  Genesis events (`origin: "genesis"`) MUST carry every timestamp column of the row they snapshot,
  derived ones included (`core_changed_at`, `exit_plan_changed_at`, `acknowledged_at` as the linked
  decision's `created_at`, `loans.updated_at`, `profile_modules.enabled_at`, ...). A reducer uses a
  stamp of a derived column as its initial value; later events recompute it normally. Native writers
  rarely need `stamps`.

### 4.5 Log copy encoding (store-local)

This section binds the store's `event_log.data` column only; it is not an interchange format. The wire
form (2.1) carries `d` as a JSON object with field names, so it does not depend on any field order.

- A payload whose top-level keys all have a position in its type's **field table** is stored
  positionally: `[mask, ...values]`, bit `i` of `mask` set when the field at position `i` is present
  (absent and `null` stay distinct, 4.2), values in position order. Only positions 0-51 are used (a
  JSON number is exact to 2^53). Any other payload (a field without a position, a type without a table,
  a field at position 52 or later) is stored as a JSON object with its names. Decoding gives back the
  same keys and values; nested objects (`stamps`, `raw`, JSON blobs) keep their names.
- The field table (`packages/store/src/engine/field-table.ts`) is data checked into the repo: per event
  type, an ordered list of field names. Positions come only from it, never from a schema's key order,
  so reordering a schema or adding a field anywhere in it (7.6) changes nothing stored.
- **One table per type, covering every version.** The table names fields, it gives them no meaning,
  so a name keeps its position across versions and decoding needs no version. This matters because
  `data` holds the payload as upcast to the reader's version at write time (the original is kept in
  `raw_data` only when it differs), a version the row does not record. A field a later version drops
  keeps its position; a renamed field is a new name appended.
- **Append-only.** An entry is never edited, reordered or removed. A new field of any registered schema
  version is appended at the end of its type's list (`CASHU_FIELD_TABLE=append` regenerates the file;
  it never rewrites an entry). `field-table.test.ts` fails when a locked entry changes (a per-type lock
  of the entry count and an FNV-1a hash of the entries), when entries are not locked, and when a field
  of a registered schema version (built-in modules, every version) has no position. A positional row
  with more values than its mask selects (a shortened table) fails to decode instead of shifting fields.
- The first table was generated from the v1 schema order of S23b's encoder, so log copies written
  before the table existed decode unchanged (system schema 2 is kept).

## 5. Batches

- A **batch** is the unit a device appends atomically (one frame or a frame group, S28a); a
  materializer applies it in one SQLite transaction.
- Events of a batch have strictly increasing `hlc`. A command producing several events (an import,
  an approval with its side effects, a decision linking signals, an alert mute with its signal close)
  MUST put them in one batch.
- Batches carry no semantics beyond atomicity.

## 6. Conflict rules (reducers)

### 6.1 The fold

```
view = fold over the applied events (6.6) sorted by (hlc, eid), after identity resolution (6.4)
```

Every reducer is a pure function of (state, event). Guards that must hold under concurrency are
re-evaluated **inside** the reducer against the folded state: a guarded event that fails its guard at
its position in the order is a **no-op** (it stays in the log). An implementation MAY apply
incrementally when a new event sorts after everything already applied to the affected rows, and MUST
re-fold those rows (or rebuild) when an event arrives that sorts before already-applied ones, or that
changes identity resolution (6.4) or causal suppression (6.6).

### 6.2 Rule vocabulary

| Code | Rule | Reducer behaviour |
|---|---|---|
| **CREATE** | create-once (union) | The first **applied** create event (lowest `(hlc, eid)` among creates that are not suppressed and not parked) creates the row and supplies initial values. Later creates for the same row are no-ops. |
| **LWW-F** | last writer wins per field | Each field is a register; an event sets the fields present in its `data` (4.2). There is no whole-record replacement: a "record" event (`*.set`) is LWW-F over the fields its version defines. |
| **SOFT** | soft delete register | `removed` / `deleted` sets a register, `restored` / a later `added` / `set` clears it; LWW by order. The row stays (Python keeps it too). Used where re-creation is a normal flow (accounts, alerts, watchlist, topic theses, connector bindings). |
| **TOMB** | tombstone | A delete ends the row: later events for it are no-ops, the view drops it. Only for rows that are never re-created under the same gid (ULID rows: decisions, reviews, theses, cash expenses). |
| **APPEND** | append-only | Each event creates its own immutable row; later changes only via listed TOMB / LWW-F side fields. |
| **FWW** | first writer wins (transition) | Among terminal transitions of one row the lowest `(hlc, eid)` wins; later ones are no-ops and their caused events are suppressed (6.6). |
| **GUARD** | precedence register | LWW-F whose reducer first checks a condition against the folded state. |
| **IDENTITY** | identity claim / merge | Feeds identity resolution (6.4). |
| **EPISODE** | signal episode fold | Signal lifecycle per resolved dedup key (8.7). |
| **LEADER** | emit constraint | Only the current fetch leader emits it (`holdsLease` true right before: the pinned leader, or in mode auto the settled holder, 8.11). Reducers accept it from any device; convergence never depends on lease state. |
| **DERIVED** | not an event | Recomputed after apply (section 9). Never in a payload except as a genesis stamp (4.4); never captured by the outbox. |

### 6.3 Tombstones, soft deletes, windows

- Python hard deletes become TOMB events where the row is never re-created under its gid: decision
  undo, review undo, thesis delete, cash expense delete. A connector binding removal is SOFT (M1): the
  same (account, connector) is bound again with a higher-`hlc` `connectorBinding.set`.
- Undo / restore windows (review, decision, alert restore, note restore) are checked at emit time
  against the view; the reducer applies an emitted undo unconditionally.

### 6.4 Identity resolution and row keys

Some facts reach the log under several gids: one bank account seen by CSV (no IBAN) and by Open
Banking (IBAN, uid); one instrument created by two devices under different aliases, or merged by the
owner. The view resolves them deterministically **inside the fold**, so writes that target an old gid
from a device that has not seen the merge land on the canonical entity, in any delivery order.

**Claims and merges.** Processed in `(hlc, eid)` order over the applied events with a union-find per
kind:

| Kind | Claim events (gid, key) | Merge events |
|---|---|---|
| accounts | `account.opened` and `account.identified`: each `data.keys[]` item (`iban:<ibanKey>`, `ext:<bank>:<key>`) claimed by the event's `gid` | none (accounts merge only through shared keys) |
| instruments | `instrument.aliasAdded`: `namespace:value` claimed by `data.instrument` | `instrument.merged {source, target}` |

- A claim of an unheld key makes the claimer its holder. A claim of a key already held folds the
  claimer's root into the holder's root (`parent[find(claimer)] = find(holder)`), unless they already
  share a root. The earlier holder therefore survives.
- **One IBAN per account (N2).** An account component holds at most one `iban:` key. An `iban:` claim
  is accepted only when the same event carries an `iban` that passes the mod-97 check (a bare 26-digit
  Polish NRB is checked as `PL` + NRB) and whose iban key equals the claimed key (`claimAllowed` in
  `identity.ts`). A claim of a different `iban:` key by a component that already holds one, and a
  union (through an `ext:` key) of two components holding different `iban:` keys, are no-ops recorded
  as **identity conflicts** in the view (`account_conflicts`, shown to the owner), in `(hlc, eid)` order.
  This mirrors Python's sequential refusal (`budget/imports.py:376`, `import_account_mismatch`) under
  concurrency, and a malformed number (masked, short, mistyped) can never fuse two accounts. The rest
  of the event (other keys, fill-if-null of `external_id`, the raw `iban` below) still applies; a
  refused IBAN never becomes the account's identity IBAN (`iban_key`).
- A merge folds `find(source)` into `find(target)` unless they already share a root. Concurrent
  opposite merges (A->B and B->A) end in one root: the second is a no-op in the order.
- `resolve(g)` = `find(g)` over the whole held event set. Resolution is recomputed (per affected
  component) whenever a claim or merge arrives; it never depends on delivery order.
- Merges are permanent, as Python's `get_or_create_account` matches for good; with the N2 guard a
  merge needs a checksum-valid shared IBAN or a shared external key, never two different IBANs.

**Row keys.** Every table whose row identity contains an account or instrument reference is keyed by
the **resolved** reference. All events of all member gids that map to one row key fold together as
one row, in `(hlc, eid)` order, with the table's normal rule:

| Table | Row key |
|---|---|
| accounts | `resolve(gid)` |
| balances | `resolve(account)`, date, source |
| transactions (imported) | `resolve(account)`, dedupHash, occurrence (so a CSV row and the same Open Banking row collapse once their accounts resolve together: Python's cross-source content dedup) |
| loans, depreciations, asset_details, inv_account_settings | `resolve(account)` |
| connector_bindings | `resolve(account)`, connectorId |
| inv_instruments | `resolve(gid)` |
| inv_profile_instruments, watchlist_items | `resolve(instrument)` |
| inv_manual_valuations | `resolve(instrument)`, asOf |
| inv_position_snapshots | `resolve(account)`, `resolve(instrument)`, asOf |
| inv_instrument_renames | date, `resolve(old)`, `resolve(new)`; dropped when both resolve to one instrument |
| inv_transactions | `resolve(account)`, dedupHash |
| inv_signals | episode per resolved dedup key (8.7) |

- **Row addressing (N1).** The view row's `gid` is always one of its **member** gids: the identity
  root for accounts and instruments, and for every other row-keyed table its **anchor**, the first
  applied keyed member (lowest `(hlc, eid)` among the creates that put a member into the row). A gid
  that no event carries never appears in the view. Writers address the gid the view shows, or any
  member gid they hold; every member gid maps to the row through its own keyed events (6.4 row keys),
  so an edit reaches the merged row whichever member it names. An event that names no subject in
  `data` (`watchlist.removed`, `txn.categorySet`, ...) maps through its gid's row key; until that gid's
  keyed event is held it is parked. The anchor may move to an earlier member when a merge brings one
  in; edits addressed to the old anchor still land, because it stays a member.
- To change a merged row **as a whole**, the writer emits the change for every member the view lists
  (one batch): e.g. removing a merged watchlist entry emits `watchlist.removed` for each live member.
- Field precedence on a collapsed row is the table's rule over the merged event stream (latest write
  wins per field, GUARDs re-evaluated), replacing the target-first rules of `store/instrument_merge.py`
  for field registers (lead decision on R-2, an intentional difference from Python). **Presence** combines per
  member instead (N3): a watchlist row is live when any member's own SOFT register is live, so
  "remove the duplicate, then merge" keeps the target watched, as Python does.
- Accounts: the view's `iban` is the raw IBAN text exactly as an event carried it (Python stores and
  shows the number it was given, valid or not, so display, export and parity keep it: no data loss).
  Which raw value: the `iban` of the component's **first accepted** `iban:` claim in `(hlc, eid)`
  order when the component holds an `iban:` key; otherwise the **first non-null** `iban` among the
  component's `account.opened` / `account.identified` events in `(hlc, eid)` order (fill-if-null, the
  rule of `external_id` and of Python's `get_or_create_account`; a later number never replaces it).
  A valid claim therefore wins over an earlier raw one in any delivery order, and two devices that
  learn different invalid numbers converge on the earlier one. The view's `iban_key` is the
  component's `iban:` key without the prefix (checksum-valid by N2), null when `iban` is raw only.
  Only `iban_key` is identity: writers resolve by it first (a raw-only `iban` may still route a write
  to its account, as Python matches it, but never claims a key or merges, so it never fuses two
  accounts); `external_id` is the first non-null over the component's events; `type` is LWW over
  `account.typeSet` initialised from the first applied open; `name` is the latest explicit
  `account.renamed` of any member, else the **root's own** opened name (N4), so an older CSV account
  folding into an Open Banking account does not rename it. Internal transfers match by counterparty
  IBAN only (rule 5), against every `iban:` key of the resolved account (at most one per component by
  N2, so the CSV NRB and the Open Banking IBAN of one account both match it; N5). The own-IBAN set
  that transfers and categories match is Python's `own_ibans` (lead decision D-08.1): `iban_key` of
  the raw `iban` column of every account, removed ones included, checksum or not. Matching never
  fuses accounts, so N2's safety argument does not apply; the signal stays the counterparty IBAN
  only (rule 5). `iban_key` (valid only) is identity, never the match set.

### 6.5 Cross-entity effects

| Event | Also affects | Effect |
|---|---|---|
| `decision.recorded` | the episode of each signal in `data.signals` | acknowledged if active |
| `decision.undone` | the undone decision's episodes | back to active if no other live decision links the episode at this point of the order |
| `signal.escalated {reactivate: true}`, `signal.woken` (guard passed) | its episode | clears acknowledged |
| `account.*`, `instrument.aliasAdded`, `instrument.merged` | every row keyed by them | row keys re-resolve (6.4) |
| `alert.statusSet` (muted / snoozed), `alert.deleted`, `alert.restored` | that alert's episode | the acting device emits `signal.closed` / `signal.reopened` in the same batch (no implicit effect) |

### 6.6 Causal suppression and FWW losers

- An event with `cause` = E is applied only if E is held, applied and not an FWW loser. A parked E
  (section 7, including `invalid-gid`) is not applied.
  Suppression is part of the fold: an event arriving later can flip it.
- Causal revocation (S31c): an event type may revoke the side effects of one event of another type
  (catalog `revokes {cause, field}`). An event with `cause` = E is also suppressed when a held
  revoker with E's gid names E's eid in `field` and sorts after E; E itself stays applied.
  `proposal.applyFailed {approval}` revokes what exactly that `proposal.approved` caused:
  first-writer-wins decides the DECISION, the execution result after it can still undo the approved
  change (Python `_finish` undoes the recorded strategy version when the files cannot be written). A
  losing approver's failure names a suppressed approval and changes nothing. A revoker carries no
  `cause`.
- An FWW loser MUST NOT have done anything outside the log that the log cannot undo. Therefore:
  - connector fetch cursors live in the log (`connectorBinding.cursorAdvanced`, caused by the
    approval or auto-commit batch, M5): a suppressed approval rolls the cursor back, and the next
    fetch re-reads the gap;
  - projection files (strategy files) are written from the view's current state, never from the
    approving command, so a suppressed version disappears from them on the next projection write;
  - approvals never delete blobs (staged files, archives); blob garbage collection (S28) deletes only
    blobs no applied event references;
  - import-like proposals (`import`, `budget_import`) are approved, rejected and failed only on the
    lease holder (O3, O4), which makes a concurrent terminal transition a lease-handover edge case
    that the rules above still repair.

### 6.7 Convergence argument (B2 and the rest)

1. Every reducer reads only the folded state and the event, and the fold order `(hlc, eid)` is a
   strict total order on the event **set**; identity resolution and causal suppression are functions
   of the set as well. Hence two devices with the same set compute the same view (determinism), and
   delivery order or duplication cannot matter (re-delivery is a no-op by `eid`).
2. Lease handover, split brain, non-leader opens: the episode rule (8.7) keys "at most one open
   signal" by the **resolved dedup key**, not by who opened it. Two `signal.opened` for one key
   (old and new leader, two leaders in a split, a research desktop and the leader) are ordered; the
   later one joins the open episode as an alias. No lease state enters the fold, so a lease conflict
   cannot fork the view; it can only add events, and added events are ordered like any others.
3. Partial sets: a device holding a prefix of another device's events computes the fold of that
   subset. When the rest arrives, rows touched by earlier-sorting events are re-folded (6.1), giving
   the fold of the union. The invariants (one open episode per key, one row per row key) hold for
   every subset because they are properties of the reducer, not of the arrival order.
4. Causality keeps the guards meaningful: a device that emits an event has applied everything it saw,
   and its HLC is above all of it (3.3), so an event never sorts before the state its writer checked.

`src/convergence.exhaustive.test.ts` exercises 1-3 on every blocker scenario: 40 shuffled deliveries
plus re-delivered duplicates, invariants checked on every prefix, all final views equal.

## 7. Forward compatibility and upcasting

1. **Unknown type**: store, do not apply, do not drop. The view counts `unknown_events` per type.
2. **Known type, newer `v`**: same as an unknown type.
3. **Known (type, v), unknown fields**: ignored, preserved in the log (loose schemas).
4. **Known (type, v) failing validation** (e.g. a new enum value): same as an unknown type.
5. **Upcasters** `(type, v) -> (type, v + 1)` are pure, applied on read; stored events never change.
6. **Evolving a type**: an optional field whose absence keeps the old meaning MAY keep `v`; anything
   else (new required field, changed meaning, new enum value, changed unit) MUST bump `v`. A type name
   is never reused.
   Field order in a schema is free: the store's log copy takes positions from the append-only field
   table (4.5), so a new field may go anywhere in the schema; its name is appended to the table.
7. **Writers never round-trip records**: they send only the fields they change.
8. **No write on stale semantics**: a device holding parked events of a row MUST NOT emit GUARD or
   FWW events for it.
9. **After an upgrade the device MUST rebuild the view** (M10): re-applying only the parked events is
   not enough, because events applied earlier with ignored fields may mean more to the new reader.
   View schema changes are rebuilds too (`viewVersion`, spike `Materializer`).
10. **Invalid deterministic gid** (`invalid-gid`): an event whose type has a payload-derived DET gid
    ([`gid.md`](gid.md) 4, the per-type parts are `detPartsOf` in
    `packages/store/src/events/v1/det-parts.ts`) MUST carry exactly `DET(table)[parts]`, the parts read
    from its payload after upcasting to the reader's version, references **unresolved** (the gid the
    writer named, not its root). An event whose gid differs is **parked** with reason `invalid-gid`:
    held in the log, never folded, never a valid `cause` (6.6), counted in `unknown_events` like other
    parked events, but **not** an upgrade signal (no newer reader would fold it either; it is a writer
    bug). Without this rule one gid could stand for two row keys and devices would fork on which
    payload they saw first. The check runs before the fold and depends on the event alone (its type,
    gid, payload and the vault salt), so every device holding the event parks it, in any order.
    Upcasters MUST NOT change a DET part.

## 8. Catalog

Payload fields in camelCase; `@x` = gid reference to x. Every payload also accepts `stamps` (4.4).

### 8.1 Per-table summary

| Table | Events (v1) | gid | Rule |
|---|---|---|---|
| profiles | `profile.created`, `profile.renamed`, `profile.settingsChanged` | vault id | CREATE; LWW-F |
| profile_modules | `module.enabled`, `module.disabled` | DET(module_id) | `enabled` LWW register |
| accounts | `account.opened`, `account.identified`, `account.renamed`, `account.typeSet`, `account.removed`, `account.restored` | DET(iban) or DET(ext key), else ULID ([`gid.md`](gid.md) 4.3) | IDENTITY (6.4); name / type LWW-F; iban / externalId fill-if-null; removed SOFT |
| balances | `balance.recorded` | DET(account, date, source) | row key 6.4; amount (and `created_at`) LWW; currency = the first applied record's (Python `upsert_balance`, S24 D-24.5) |
| transactions | `txn.imported`, `txn.cashExpenseAdded`, `txn.categorySet`, `txn.categoryCleared`, `txn.deleted` | imported DET(account, dedupHashV2, occurrence); cash expense ULID | imported CREATE on the row key; claim GUARD; delete TOMB (cash expenses); transfers, rule categories, cash legs DERIVED |
| transfer_runs | `transferRun.started`, `transferPair.claimed` | run ULID | append per-run header and bounded pair claims; latest complete run determines pinned pairs |
| category_rules | `categoryRule.set` | DET(merchant_key) | GUARD (locked manual beats llm) + LWW-F |
| import_batches | `importBatch.recorded` | ULID | APPEND |
| loans | `loan.termsSet`, `loan.paymentMatchingSet` | DET(account) | LWW-F; the row is visible once terms exist |
| depreciations | `depreciation.set` | DET(account) | LWW-F |
| asset_details | `assetDetails.noteSet` | DET(account) | LWW-F |
| budget.json (cushion) | `budgetSettings.cushionSet` | DET("cushion") | LWW-F |
| inv_account_settings | `invAccount.settingsSet` | DET(account) | LWW-F |
| inv_import_batches | `invImport.recorded` | ULID | APPEND |
| inv_transactions | `invTxn.imported` | DET(account, dedupHashV2); manual entries ULID | CREATE on the row key |
| inv_position_snapshots | `position.snapshotImported`, `position.snapshotUpdated` | DET(account, instrument, as_of) | newest wins on the row key in fold order (create or update, same gid); another member gid keeps the first applied (merge collision) |
| inv_instrument_renames | `instrumentRename.recorded` | DET(date, old, new) | CREATE on the row key |
| inv_manual_valuations | `valuation.set` | DET(instrument, as_of) | LWW-F on the row key |
| inv_instruments | `instrument.created`, `instrument.updated`, `instrument.merged` | DET(creation alias), else ULID | CREATE; LWW-F; IDENTITY (merge) |
| inv_instrument_aliases | `instrument.aliasAdded` | DET(namespace, value) | IDENTITY (claim) |
| inv_profile_instruments | `instrumentOverride.set`, `instrumentOverride.planSet`, `instrumentOverride.strengthSet`, `instrumentOverride.segmentSet` | DET(instrument) | LWW-F on the row key; segment GUARD |
| inv_strategy_versions (+ files) | `strategy.versionSaved` | ULID | APPEND; no-op when its sha equals the current version's; current = highest `hlc`; numbers DERIVED; `base` kept; files follow the current version per device (8.8) |
| inv_theses | `thesis.created`, `thesis.updated`, `thesis.deleted` | ULID | CREATE; LWW-F; TOMB; `*_changed_at` DERIVED |
| inv_topic_theses | `topicThesis.ownerSaved`, `topicThesis.draftProposed`, `topicThesis.rejected`, `topicThesis.marketViewSet` | DET(segment) | GUARD + LWW-F; restart on a rejected row (8.9); rejected SOFT |
| watchlist_items | `watchlist.added`, `watchlist.updated`, `watchlist.removed` | DET(instrument) | row key 6.4; added = create or restore + LWW of `added_at`, `source`, given note / tags (M2); removed SOFT per member; presence = any member live (N3) |
| alerts | `alert.created`, `alert.updated`, `alert.statusSet`, `alert.deleted`, `alert.restored`, `alert.evaluated` | ULID | CREATE; config LWW-F; deleted SOFT; runtime LEADER LWW-F; effective status DERIVED |
| inv_planned_deposits | `plannedDeposit.created`, `plannedDeposit.cancelled`, `plannedDeposit.booked` | ULID | CREATE; cancel / book FWW; a transaction books at most one plan (GUARD, O10) |
| inv_signals | `signal.opened`, `signal.refreshed`, `signal.escalated`, `signal.closed`, `signal.reopened`, `signal.snoozed`, `signal.woken` | ULID | EPISODE per resolved dedup key (8.7); snooze LWW; woken GUARD; acknowledged DERIVED (6.5) |
| inv_rule_runs | `ruleRun.finished` | ULID | APPEND, LEADER (D5: the view keeps the last N) |
| inv_decisions + inv_decision_signals | `decision.recorded`, `decision.undone` | ULID | APPEND; links embedded; undo TOMB |
| reviews | `review.done`, `review.undone` | ULID | APPEND; undo TOMB |
| proposals | `proposal.created`, `proposal.approved`, `proposal.rejected`, `proposal.failed`, `proposal.applyFailed` | ULID | CREATE; terminal FWW; caused side effects (6.6); `applyFailed` GUARD (approved only) + revokes the approval's caused events (6.6); import-like kinds leader-only |
| research_runs | `researchRun.started`, `researchRun.finished` | ULID | APPEND; finish FWW on the status (8.9) |
| research_notes | `note.added`, `note.read`, `note.dismissed`, `note.restored`, `note.candidateUpdated`, `note.signalLinked` | ULID | APPEND; read / dismissed / candidate / signal link LWW-F |
| connector_bindings | `connectorBinding.set`, `connectorBinding.removed`, `connectorBinding.cursorAdvanced` | DET(account, connector_id) | LWW-F on the row key; removed SOFT (M1); cursor LWW, LEADER, caused (M5) |

### 8.2 Core

- `profile.created` (gid = vault) `{slug, name, baseCurrency, mcpPrivacy: strict|amounts}`. `slug` is
  a device-local alias for folders and URLs (O9): a device that already has a vault with that slug
  maps it to a local alias; the vault gid is the identity.
- `profile.renamed` `{name}`. `profile.settingsChanged` `{baseCurrency?, mcpPrivacy?}` (LWW-F). The MCP
  server uses the **stricter** of the synced `mcpPrivacy` and the device-local acknowledged level;
  loosening (strict -> amounts) takes effect on a desktop only after its owner confirms it there (O8).
- `module.enabled` / `module.disabled` `{moduleId}`: one LWW register; the row appears with the first
  applied enable; `enabled_at` = domain time of the `module.enabled` that flipped the register to
  enabled (a redundant enable never moves it, Python `set_modules`; S24 D-24.4).
- `account.opened` `{bank, externalId|null, iban|null, currency, type, name, active?, keys[]}`.
  `keys` are the identity keys the writer knows (`iban:<ibanKey(iban)>` when an IBAN is known,
  `ext:<bank>:<key>` for an external natural key); empty for manual, vehicle and brokerage accounts.
  Writers resolve first: look up the view by IBAN key, then by external key, and emit
  `account.identified` on the found account instead of opening a new one; concurrent opens that miss
  each other are joined by identity resolution. Open Banking never emits `account.renamed` (its
  "name" is the holder's name); the first applied open supplies the initial name.
- `account.identified` `{iban?, externalId?, keys[]}` (min 1 key): the account learned an IBAN (Open
  Banking, a statement, a parser that found it) or a new external key (an Enable Banking re-consent
  uid). Fills `iban` / `external_id` when still null (a valid accepted `iban` replaces a raw one,
  6.4) and claims `keys`, which may merge accounts; an `iban:` key is claimed only with a
  checksum-valid `iban` and never as a second IBAN of one account (N2, 6.4).
- `account.renamed` `{name}`, `account.typeSet` `{type}`, `account.removed` / `account.restored` `{}`
  (SOFT). Key parking (`<key>~<id>`) is DERIVED in the view ([`gid.md`](gid.md) 4.3).
- `balance.recorded` `{account@, date, source: open_banking|csv|manual|connector, amount, currency}`.
- `budgetSettings.cushionSet` `{enabled, currency|null, targetAmount|null, targetMonths|null,
  accounts: @account[], monthlyMax|null}`. Replaces `profiles/<slug>/budget.json` (a projection while
  Python reads it). Genesis renders the stored floats per 4.3 (m13).

### 8.3 Budget

- `txn.imported` `{account@, batch@|null, bookingDate, valueDate|null, amount, currency,
  counterpartyName|null, counterpartyIban|null, description|null, reference|null,
  bankTransactionId|null, source, dedupHash (v2), occurrence, raw}`. CREATE on the row key (6.4).
  Union by row key reproduces Python's multiset rule for the content path (max multiplicity).
- **Newest-day-rule imports** (Open Banking, connectors, cashu-format documents) depend on the view
  at import time and MUST be emitted by the lease holder only. A non-leader that receives a
  cashu-format document creates an `import`-like proposal instead (O3). A new leader MUST NOT run them
  before it has applied, for every device, the highest VALID cursor any lease event of the chain
  names (M6; `catchUpMissing` in `packages/sync/src/devices/lease.ts`, validated by `catchUp.ts`:
  registered devices only, capped at a revoked device's cut, conflicted devices dropped, minus owner
  waivers; R3b adds signed heads). Imports a leader made after its last lease event are not covered (a
  leader must not import while it cannot publish); the hand-over acknowledgement and the leader's
  `lease.fetched` reports carry its watermark.
- `txn.cashExpenseAdded` (ULID) `{account@ (cash account), bookingDate, amount (< 0), currency, title,
  category}`. View: `source = manual`, `category_source = manual_txn`, `dedup_hash = "cashexp:" + gid`.
- `txn.categorySet` `{category, source: manual_txn|llm_full|llm_fallback}`: a per-transaction claim
  (D8). GUARD: an `llm_*` claim is a no-op while the folded claim is `manual_txn`. A claim may target a
  derived cash leg (the owner recategorizes a leg, m2): the view shows the leg as
  `DET(transactions)["cashleg", anchor]`, and a claim addressed to the leg gid of **any** member of the
  source row (`DET["cashleg", member]`) applies to that row's leg, so leg edits survive anchor changes
  after account merges (N1). Leg claims persist while the leg is absent and apply when it reappears.
- Marking a bank transaction `cash_withdrawal` (the `manual_txn` claim, on a row not on a cash account)
  makes the derived mirror leg appear on the cash pool account `cash:<CUR>` while that account is open
  (section 9); the emitting device MUST include an `account.opened` for that DET account in
  the same batch when its view does not have it (m3; concurrent opens collapse by gid).
- `txn.categoryCleared` `{}`: removes the claim (Python `recategorize_one` after the leg is deleted,
  `budget/cash.py:delete_cash_transaction`).
- `txn.deleted` `{}`: TOMB, only for cash expenses. Deleting a mirror leg emits `txn.categoryCleared`
  on the source bank transaction.
- `transferRun.started` (ULID) `{reset, maxDays, pairCount}` and `transferPair.claimed`
  `{run@, out@, in@, ordinal}` (same run gid) record one explicit transfer matching command. A run
  becomes active only when all `pairCount` distinct ordinals `0..pairCount-1` are present;
  out-of-range claims are ignored. A remote partial batch leaves the previous complete run visible.
  A zero-pair run is complete. The latest complete run by `(hlc, eid)` wins. Its pair claims pin
  currently valid, distinct
  outflow/inflow rows with equal amount keys and own-account IBAN evidence on at least one leg;
  missing,
  deleted, collapsed, or stale claims do not create a pair. A command without reset snapshots
  existing pairs and matches only ungrouped rows. Reset clears existing groups before matching.
  `maxDays` is a signed integer for this command; the default is 3. Until a later `txn.imported`
  creates a new transaction anchor, unclaimed rows remain ungrouped. Cash expenses and duplicate
  imports do not release them. That later import resumes the native default-3 matcher for unclaimed
  rows, while the complete run's valid pairs
  remain pinned.
- Effective category (DERIVED, S09 / S24c): a row on a cash account shows its claim, else none
  (D-09.4); otherwise `manual_txn` claim > structural transfer / locked merchant rule / loan pattern
  (`engine.owner_decision`) > `llm_full` / `llm_fallback` claim > engine. The view is a full
  deterministic recompute over the current set (S24 D-24.1, Python `categorize_all(use_llm=False)`
  after a fresh transfer match); the subscription payees come from the recurring grouping over the
  non-internal rows with the claims as decided categories, never the derived column.
- `categoryRule.set` `{merchantKey, category, source: manual|llm, locked}`; GUARD: `llm` is a no-op
  while the folded rule is locked.
- `importBatch.recorded` `{source, bank|null, account@|null, filename|null, startedAt,
  finishedAt|null, numSeen, numInserted, numDuplicates, notes|null, archive?: {sha256, ext}}`.

### 8.4 Loans and assets

- `loan.termsSet` `{account@, principal, annualRate, termMonths, startDate, originationDate|null}`;
  `loans.updated_at` = domain time of the latest `termsSet`.
- `loan.paymentMatchingSet` `{account@, paymentIban|null, paymentText|null}`. Either event may come
  first; the loan row is visible once terms exist (m7).
- `depreciation.set` `{account@, purchasePrice, purchaseDate, annualRate, floor|null}`.
- `assetDetails.noteSet` `{account@, note|null}` (<= 500 chars). The row appears with the first applied
  set carrying a note (a null note creates no row, Python `set_note`); once it exists a null note keeps
  the row with `note = NULL` (S24 D-24.9).

### 8.5 Investments: accounts, imports, transactions

- `invAccount.settingsSet` `{account@, wrapper?, importer?, mappingYaml?}`.
- `invImport.recorded` `{account@, importer, broker, fileName, fileSha256, archive?, txnCount,
  duplicateCount, positionCount, renameCount, statusChangeCount, instrumentCount, correctionCount,
  warnings[]}`.
- `invTxn.imported` `{account@, batch@|null, type, tradeDate, settleDate|null, instrument@|null,
  quantity|null, price|null, currency, grossAmount, fee, tax, cashAmount, cashCurrency, fxRate|null,
  splitRatio|null, note|null, source: import|manual|reconciliation, externalRef|null, dedupHash,
  createdAt}`. `createdAt` is required (chronological rank of same-day rows). `dedupHash` is
  dedupHashV2 built from the broker's own instrument key, not the instrument gid, so it is
  merge-invariant (O1, [`gid.md`](gid.md) 4.6). Manual entries (`source = manual`) get a ULID gid (a
  migrated row: its genesis gid, [`gid.md`](gid.md) 7) and `dedupHash = "manual:" + gid`, checked by
  `parseEvent`: two identical manual rows from two devices stay two rows (m1).
- `position.snapshotImported` `{account@, instrument@, asOf, quantity, currency, avgPrice|null,
  marketValue|null, batch@|null}`. `position.snapshotUpdated` (same payload, S31c): a re-import whose
  figures for a held (account, instrument, asOf) differ (Python's import upsert keeps the newest
  import's figures, batch and `created_at`). Both types fold newest-wins in fold order `(hlc, eid)`,
  never wall time: an event with the row's anchor gid (the DET gid both types share) replaces the
  figures, batch and `created_at`, so the newest import wins whichever device made it and whether its
  Python inserted (create) or updated (update); a genesis snapshot sorts before every later import. An
  event of another member gid (two instrument gids an identity merge collapsed) is ignored: the first
  applied member keeps the row (R-2). A re-import of the same figures writes nothing (Python skips
  the row), and a provenance-only rewrite never ships.
- `instrumentRename.recorded` `{date, old@, new@, note|null, batch@|null}`.
- `valuation.set` `{instrument@, asOf, unitValue, currency, note|null}`.

### 8.6 Instruments (per vault, D3)

- `instrument.created` `{name, currency, assetClass, symbol|null, isin|null, mic|null, region|null,
  sector|null, tags[], needsClassification, valuationMode, status, creationAlias|null}`. Writers also
  emit `instrument.aliasAdded` for every alias, the creation alias included.
- `instrument.updated` `{...patch of the shared fields}` (LWW-F on the resolved row).
- `instrument.aliasAdded` (gid DET(namespace, value)) `{instrument@, namespace, value, guessed}`: an
  IDENTITY claim (6.4). A claim of an alias another instrument holds merges the claimer into it: no
  leader action is needed (v1's leader-emitted collision merge is gone). The row's `guessed` is the
  AND over every applied claim of the alias gid: a claim with `guessed: false` confirms a guessed
  alias (Python `add_aliases` / `classify` confirming a guess), in any delivery order, and a later
  guessed claim never un-confirms it. `created_at` stays the first applied claim's.
- `instrument.merged` (gid = source, checked by `parseEvent`) `{source@, target@, reason:
  owner|alias_collision}`: an owner merge. With claims handling collisions, `alias_collision` is kept
  only for genesis of merges Python recorded.
- `instrumentOverride.set` `{instrument@, name?, assetClass?, tags?, region?, sector?, valuationMode?,
  status?, needsClassification?}` (null = shared default, `""` clears for this profile).
- `instrumentOverride.planSet` `{instrument@, plan|null, reason|null}` (one register; `plan_at` =
  domain time).
- `instrumentOverride.strengthSet` `{instrument@, strength: strong|neutral|weak|null, basis:
  on_track|fulfilled|undermined|environment_against|no_progress|null, reason|null}` (one register;
  `strength_at` = domain time; `strength: null` clears strength, basis, reason and `strength_at`).
- `instrumentOverride.segmentSet` `{instrument@, segment|null, by: owner|agent}`; GUARD: `agent` is a
  no-op while the folded segment is non-null and set by the owner.

### 8.7 Signals, rule runs, alerts

**Episodes (B2).** "At most one open signal per dedup key" (Python's partial UNIQUE index) is a fold
rule keyed by the **resolved** dedup key `K` ([`gid.md`](gid.md) 5), processed in `(hlc, eid)` order
over the events of all signal gids whose key resolves to `K`:

```
opened(g):   no open episode for K -> g starts a new episode, active
             an episode E is open   -> g becomes an alias of E (refresh semantics: message,
                                       severity, payload updated); events for g go to E
opened(g) again (same g):  no-op (a ULID is created once; the first applied open stands, 6.2 CREATE)
refreshed / escalated(g):  on resolve(g)'s episode if open; escalated{reactivate} -> active (ack cleared)
closed(g, status, reason): resolve(g)'s episode if open -> resolved | expired; K has no open episode
reopened(g, reason):       resolve(g)'s episode back to active (or acknowledged if a live decision links it)
                           only if alert_restored on an expired one / note_restored on a resolved one,
                           and no other episode of K is open (Python reopen_dismissed / alert restore)
snoozed(g, until):         LWW on the episode
woken(g, until):           GUARD: only while the episode's snoozedUntil == until (M7); clears ack
acknowledged:              DERIVED overlay from decisions (6.5)
```

- `signal.opened` (ULID) `{ruleId, kind, dedupKey (v2), severity, polarity, message, instrument@|null,
  account@|null, payload, run@|null}`. Emitters: the lease holder for rule, plan and alert signals; the
  device running the research agent for `research:` keys (`add_research_note` over MCP).
- `signal.refreshed` `{severity?, message?, payload?, run@|null, seenAt, ruleId?, kind?, polarity?,
  instrument@|null?, account@|null?}`; `signal.escalated` `{severity, message, payload, reactivate,
  run@|null, seenAt, ruleId?, kind?, polarity?, instrument@|null?, account@|null?}`: same emitters as
  `opened`. The optional fields rewrite the episode's rule, kind, polarity, instrument and account
  (Python's refresh and the research sync do, S25-F1); absent = keep. `run` (null included) sets the
  episode's `last_run_id` (Python sets it from the refreshing run, also to none, S25-F2).
- `signal.closed` `{status: resolved|expired, reason, run@|null?, payloadSet?}`. Lease holder for rule
  outcomes, alert housekeeping (`alert_expired`, m8), research expiry (`notes_expired`) and research of a
  closed position (`position_closed`: neither held nor watched); any device
  for `snooze|mute|delete` (alert owner actions) and `note_dismissed`. `run` present (null included)
  sets `last_run_id`, absent keeps it (S25-F2). `payloadSet` is merged shallowly into the episode
  payload: the closing writer puts there exactly the keys Python writes on that close (`closed_by` for
  an alert owner close, `closed_reason` + `closed_by` for an age-based expiry, `closed_reason` +
  `previous_status` for a research resolve, S25-F3); the fold applies no policy of its own.
- `signal.reopened` `{reason: alert_restored|note_restored, payloadUnset?}` (any device, in the batch
  of `alert.restored` / `note.restored`). `payloadUnset` lists the payload keys the reopen removes
  (S25-F3).
- `signal.snoozed` `{until|null}` (any device). `signal.woken` `{until}` (lease holder).
- `ruleRun.finished` (LEADER) `{trigger, asOf, status, strategyVersion@|null, stats, errors[], report:
  {new: @signal[], escalated: @signal[]}, startedAt, finishedAt|null}`; `trigger` is an open label
  (`worker`, `api`, `cli`, `app`).
- `alert.created` `{instrument@|null, scope, kind, params, polarity, severity, title, note|null,
  source: user|agent, createdBy, cooldownDays|null, expiresAt|null, tag?: string|null}`;
  `alert.updated` (patch, `tag` included: null clears it). `tag` (S31c, Python `alerts.tag`, Alembic
  0027) is the owner's or agent's label: non-empty, at most 24 characters (Python `validate_tag`
  output); absent on a create = none, so a v1 create still means "no tag";
  `alert.statusSet` `{status: active|muted|snoozed, snoozedUntil|null}` (owner state);
  `alert.deleted` / `alert.restored {rearm?: true}` (SOFT; `rearm` also clears the triggered register:
  Python re-arms a restored alert whose signal was not reopened, S25-F6); `alert.evaluated` (LEADER)
  `{triggered, lastCheckedAt?, lastValue?, lastTriggeredAt?}` (runtime state). The view's stored
  `status` is the clock-free fold status `muted > snoozed > triggered > active` (owner register, then
  the runtime register; `muted` / `snoozed` clear `triggered`, `active` keeps it); an evaluation whose
  `lastCheckedAt` is at or after the folded `snoozedUntil` ends the snooze (owner back to `active`).
- Effective alert status (DERIVED, reader's clock, never in the fold): muted > expired
  (`expiresAt <= now`) > snoozed (`snoozedUntil > now`) > triggered > active; a snooze that ended
  (`snoozedUntil <= now`) reads as active with no `snoozedUntil` (`effectiveAlertStatus(row, now)`
  in `@cashu/domain`).
- Alert signals: `rule_id = dedup_key = "alert:<alert gid>"`.

### 8.8 Journal, theses, strategy, planned deposits

- `decision.recorded` `{signals: @signal[], instrument@|null, account@|null, action, quantity|null,
  price|null, currency|null, reason|null}`; `inv_decisions.signal_id` = first link (DERIVED).
  `decision.undone` `{}` (TOMB).
- `thesis.created` / `thesis.updated {..., reviewed?: true}` / `thesis.deleted`. DERIVED:
  `core_changed_at` = domain time of the latest change by value of `entryType`, `thesis` or
  `invalidation`; `exit_plan_changed_at` = of the latest change of `exitPlan` (null without a plan);
  `reviewed_at` = of the latest `reviewed: true`. Genesis stamps seed them (4.4).
- `strategy.versionSaved` (ULID) `{yamlText, mdText|null, sha256, state, issues[], base?: @|null}`. A
  version whose `sha256` equals the current version's at its position in the order is a no-op (m9;
  two desktops detecting one external edit). Current = highest applied `hlc`; numbers DERIVED.
  `base` = the version the text was edited on top of (null: none was recorded yet); absent in
  versions recorded before base tracking (base unknown). The view keeps it (`base_gid`,
  `base_known`). The recording command refuses a text whose given `base` is no longer the current
  version (`base_changed`), so a device never records older file text over a newer version.
- Strategy files (D15) are a per-device projection: every device keeps its own copy
  (`vaults/<id>/strategy`) and, in its private journal, the version its files were last brought to or
  recorded as (the device's base). The recorded versions are the shared truth; the files follow
  them (`services/strategyFileSync.ts`; host: the daily run, approval preparation, the Strategies
  tab's reload, and a background pass after every sync). The projection writer compares the files
  with the base before writing (detect-before-write, O5) and never overwrites silently:
  - files equal to the current version: in sync;
  - files changed on top of the current version (base = current): a genuine local edit, recorded
    as a new version with `base` = the current one;
  - files still equal to an older base: behind; the current version is written into them;
  - files changed on top of an older base (edited while behind), or a version this device recorded
    or approved superseded by a version whose `base` chain does not reach it (two devices recorded
    concurrently): a **conflict**. The version later in the order stays current (deterministic on
    every device); the text that lost becomes a pending `strategy` proposal (`source: conflict`,
    `payload.conflict` = `local_edit` | `concurrent_version`, `base_sha256` = the current version's
    digest), stored by the device that holds the text (the editing device, or the author of the
    superseded version), and then the files follow the current version. Nothing is lost: the owner
    approves the proposal to make that text current again, or rejects it. An unknown `base` link
    (a version from before base tracking) counts as built on it (no conflict is raised).
  - a device without a journal (first run) takes as its base the newest version its files equal,
    else the current one (an edit on top of it, the behaviour before base tracking).
- `plannedDeposit.created` `{account@|null, amount, currency, plannedDate, note|null}`;
  `plannedDeposit.cancelled` `{}`; `plannedDeposit.booked` `{txn@}`. Booked / cancelled are terminal
  FWW; GUARD: a booking whose transaction already books another plan (earlier in the order) is a
  no-op (O10).

### 8.9 Watchlist, topic theses, research

- `watchlist.added` `{instrument@, note?, tags?, source}`: creates the row or restores a removed one
  (SOFT cleared); `added_at` = domain time and `source` = this adder (LWW); `note` / `tags` set only
  when present (M2, Python `service/watchlist.py:add`). `watchlist.updated` `{note?, tags?}`;
  `watchlist.removed` `{}`.
- `topicThesis.ownerSaved` `{segment, thesis, invalidation|null}` and `topicThesis.draftProposed`
  `{segment, thesis, invalidation?}` (absent = keep the stored invalidation, null = clear). Reducer,
  mirroring `research/topic_theses.py:_write` (M9):
  - on a **rejected** row (folded `rejected_at` set) a write **restarts** it: `rejected_at` cleared,
    `created_by` = the writer, `draft` = (writer is the agent), `created_at` = `core_changed_at` =
    domain time, `invalidation` cleared (then set from the event), the whole market view cleared
    (`assessment`, `outlook`, `view_updated_at`, `view_sources`);
  - GUARD for `draftProposed`: a no-op if the folded row is a live owner thesis (not rejected, not a
    draft), or if it was rejected less than `TOPIC_DRAFT_COOLDOWN_DAYS` before the event's domain time;
  - otherwise text LWW; `core_changed_at` = domain time when `thesis` / `invalidation` changed by
    value; `ownerSaved` clears `draft`.
- `topicThesis.rejected` `{}` (SOFT `rejected_at`).
- `topicThesis.marketViewSet` `{segment, assessment|null, outlook|null, sources?, by}`: `sources`
  absent = keep (Python `KEEP`), null = clear; `view_updated_at` = domain time.
- `researchRun.started` `{scope, createdBy}`; `researchRun.finished` `{status: done|failed, counts}`
  (`stamps.finished_at` may set the close time). Emitters: the run's device (`done` / `failed` with the
  agent's counts), and **any device** that finds the run stale (running, no note for 4 hours) on its
  next run start or note, plus the leader's housekeeping: `failed` with `counts.reason = interrupted`
  and `finished_at` = the run's last activity (Python `_fail_stale_runs`; lead decision 2026-11-01).
  Rule: **first-writer-wins on the run's status** - the first `finished` in fold order `(hlc, eid)`
  sets `status`, `counts` and `finished_at`; every later `finished` of the run is a no-op (a second
  device's close of the same stale run, or a late `done` from the run's own device arriving after the
  close). A completion that sorts before a close wins and the close is the no-op. Delivery order never
  matters (convergence: `investments/research.test.ts`, "research_runs FWW close").
- `note.added` `{run@|null, instrument@|null, theme|null, segment|null, kind, polarity, strength,
  thesisRelation, thesisField|null, title, summary, sources[], details|null, candidateKey|null,
  signal@|null, observedAt, expiresAt, createdBy}`; owner notes are born read. `note.read` (fills
  `read_at` only while it is null: the first applied read wins), `note.dismissed {cooldownUntil|null}`
  (GUARD: no-op while dismissed), `note.restored` (GUARD: only while dismissed) (LWW-F). Dismissing /
  restoring the last note of a research signal emits `signal.closed {note_dismissed}` /
  `signal.reopened {note_restored}` in the same batch. Accepting a candidate emits `watchlist.added` /
  `thesis.created` with `cause`.
- `note.candidateUpdated {instrument@|null, details|null}` (LWW-F, whole values; `updated_at` = domain
  time): candidate accept and undo rewrite the note's instrument and details (S25-F4), in the batch of
  their `watchlist.*` / `thesis.*` events. `note.signalLinked {signal@}` (LWW-F on `signal_id`, no
  `updated_at` change): the research sync re-points a lead note at its episode (S25-F5); emitted by
  the leader or the research device.

### 8.10 Agent layer, connectors

- `review.done` `{module, doneAt?, notes|null, stats}`; `review.undone` (TOMB).
- `proposal.created` `{kind: strategy|custom_rule|import|budget_import|account_removal, summary,
  reason|null, payload, source}` (`account_removal`: `{account@}`, approving it emits `account.removed`; a removed account's transactions
  are out of the budget reads until `account.restored`); `payload` uses gids and blob refs (`account@`, `blob: {sha256, ext}`, never `account_id` or
  `staged`). `proposal.approved {result}` / `rejected {note|null}` / `failed {result}`: terminal FWW;
  side-effect events in the approval batch carry `cause`. `rejected.note` is the owner's note (Python
  `result.note`, view `result = {note}`, `{}` without one). `proposal.applyFailed {result, approval:
  eid}` (S31c): the approved change could not be completed after the decision (Python `approved ->
  failed`); `approval` is the eid of the `proposal.approved` it reports. GUARD: only while that
  approval is the applied (winning) decision of the row, it sets `failed` and `result` and keeps
  `reviewed_at`; not FWW (it follows the decision, it does not compete with it) and it revokes that
  approval's caused events (6.6), so the strategy version the approval recorded leaves the view as it
  left Python. A failure of a losing approval (two desktops approved offline) changes nothing. Approval is desktop only (D14); for
  `import` and `budget_import` all three terminal types are emitted by the lease holder only (O3, O4).
  `applying` is a device-local lock state.
- `connectorBinding.set` `{account@, connectorId, params, autoCommit}` (creates or re-creates);
  `connectorBinding.removed` `{}` (SOFT); `connectorBinding.cursorAdvanced` `{cursor|null}` (LEADER,
  `cause` = the approval when it comes from one). The cursor now syncs, so a new lease holder resumes
  where the old one stopped; backoff and `last_*` stay leader-local (refines D7).

### 8.11 Reserved

`device.*`, `lease.*` (S29) and `snapshot.*` (S32) are defined by those scopes (schemas and folds:
`packages/sync/src/devices/events.ts`, `leaseFold.ts`, `lease.ts`). Reserved `device.*`: `added`,
`revoked`, `keysRotated`, `recoveryChanged`, `headsGossiped`. Reserved `lease.*`: `claimed`, `renewed`, `released`,
`pinned`, `fetched`.

#### v1.3 device head gossip (S29c-B4)

`device.headsGossiped` is payload `v: 1`. Its payload is exactly
`{heads: string[], signer: deviceId, sig: lower-case Ed25519 signature}`. `heads` contains 1-16
strictly increasing, unique, lower-case canonical encoded signed heads of data stream 1 in this
vault. Each inner head retains its writer signature. The outer `signer` MUST be the frame writer,
trusted at the statement's actual position. The outer signature uses domain `cashu/gossip/v1` over
`statementBody(vault, "device.headsGossiped", eid, {heads, signer})`: length-prefixed UTF-8 vault,
type and eid, then length-prefixed canonical JSON of the unsigned payload. A signature valid in a
registry or lease context MUST NOT validate here. Wrong vault, stream, cursor, writer, key, chain,
signature, order, duplicate or size is refused. An unknown, forged or ambiguous inner writer key
is an untrusted hint: it is not retained as pending authority and creates no attestation or
candidate. The gate retains an outer gossip statement only after its writer, position and outer
signature are admitted and at least one inner head verifies against an authenticated writer.

The frame gate publishes inner attestations only after the outer frame passes revocation and fork
admission at that exact position. A post-cut gossip frame from a revoked writer contributes no head,
fork proof, freeze or candidate. A signed head attests the writer's chain endpoint; it does not prove
that a remote carrier currently serves its frames. `behind` and unresolved known-writer history are visible
states, not a claim of full synchronization. Gossip never counts as a lease acknowledgement or owner
force. Every revoke warns that unseen writes may be excluded. A local start cursor without a trusted
head requires an explicit one-use local observation confirmation; a non-start cut without an exact
trusted head is an integrity refusal. Recovery or exact target consent remains mandatory authority.

Only a locally inspected non-gossip frame head or an authenticated inner head is eligible for
automatic emission. A gossip-only outer frame head is not. Each device emits a strictly later
per-writer frontier or one previously unpublished same-position fork alternative, excluding its own
writer. One dedicated gossip-only frame may follow an inbound pass when candidates exist; the engine
then performs one bounded remote push. A verified own-log gossip event is the local emission receipt;
remote delivery is tracked separately and can remain pending. An uncertain own append fences all
writes until authenticated `recoverLocal` rebases the writer's segment, size, chain, clock and gossip
receipts. The signed gate snapshot carries compact attestations/receipts, `anchors` and
`freezeFloors`, while independent
append-only fork evidence persists. `anchors` holds at most one encoded, signed data-stream head per
writer: the highest matching pre-conflict head found by complete authenticated history lookup.
Restore rechecks its signature/key and matches the exact local frame. `freezeFloors` holds at most
one `[deviceId, seg, offset]` per writer, the monotonic agreed cut after a proven fork, so a later
refold cannot relax the freeze. Both fields are covered by the snapshot's `cashu/state/v1` signature.
An invalid snapshot signature is a cache miss, never authority.
Late same-position fork checks use exact-end authenticated history. Unavailable history or an
overflow from a still trusted writer refuses ordinary writes; a bounded gossip queue discards
duplicate or stale hints without setting a permanent authority veto. Overflow records identify
their signed writer in the authenticated gate snapshot and remain visible after restart. A checked,
one-use recovery preview may write only its exact prepared revoke, re-certification and key-rotation
batch through unresolved gossip. The engine copies that batch before asynchronous work and refuses
changed contents, ineffective targets and unrelated domain events. Revoking the overflowing writer
removes that writer's capacity veto and pending history lookup. Its signed fork evidence and freeze
floor remain durable.
Unresolved history of other trusted writers still blocks ordinary writes until checked.
One unavailable writer's lookup does not prevent exact local history checks for other writers.

Every new `device.keysRotated` batch that the writer can survive includes a signed wrap addressed
to that writer in the same frame, sealed with the preceding data key. Its authenticated recipient
list names the writer exactly once, the recovery recipient, and each remaining trusted recipient;
the wrap map has exactly those recipients and excludes revoked devices. This allows a cold reopen
after accepted append but before durable ring save to recover the new key from the authenticated
old-key frame. A writer confirms that this replay has supplied the expected key before merging its
prepared clone, saves the ring durably, and only then marks the keyed attempt completed. Readers do
not require the self wrap: it is a recovery property of the writer, not a validity condition.

The store skips `device.*` and `lease.*` events (`packages/store/src/statements.ts`): they are sync
statements the frame gate reads from the encrypted log, so a store neither folds, holds, parks nor
rejects them, and a batch that carries them (a genesis device's announcement and retirement) needs
no upgrade. `snapshot.*` stays parked until S32 defines it.

Every lease event carries `at` (the writer's wall clock, within 5 minutes of the event's own HLC
wall), `watermark: {<device id>: {seg, offset}}` (per writer device, 32 lower-case hex, the cursor up
to which the writer had applied that device's stream: cursors, not HLCs, because a stream's cursor
order is exact; R3b turns them into signed heads) and `prev` (the eid of the last valid lease event the
writer saw). The events form one compare-and-set chain from `prev = null`; concurrent children are
ordered first by the earliest authentic acknowledgement in the recorded leader's own stream
(including a valid descendant acknowledgement through non-forced pins or a valid fetched prefix),
then owner pins, then `(hlc, eid)`. Only
a recovery-signed `lease.pinned` may have
`prev = null`: vault creation writes it next to the creator's `device.added`, pinning the creator.

The fetch leader (S29c R4; rule 6 must not rest on an unstated linearizable remote):

- **Mode `pinned`** (the default on every backend): `lease.pinned {mode: "pinned", leader, force}`
  designates exactly one device. It is written only from an explicit owner action: signed by the
  writing device after the owner typed `pinConfirmationText` (`text`; an accident guard), or signed by
  the recovery identity (`signer` = the recovery id; any device may carry it). A pin by a device after
  its revocation cut never counts. When another device could still act (the previous leader), it
  becomes `pendingFrom` and must acknowledge with a `lease.released` before the new leader acts,
  unless it wrote the pin itself or the owner confirmed `force` (the previous leader is gone; it may
  fetch once more if it is in fact still running). Claims and renewals are ignored. This needs no
  propagation bound, so it is safe on a synced folder.
- **Revocation and pending hand-over safety (S29c rule-6 erratum):** revoking the predecessor is not
  its acknowledgement. A non-force pin keeps the recorded `pendingFrom`, even if that device is now
  revoked, until an authentic pre-cut release on the selected lease chain or a pin written by that
  predecessor acknowledges it. A revoked device cannot act, but its absence does not authorize the
  next leader to act. If it cannot acknowledge, the owner must explicitly confirm a force pin, with
  the existing possible-overlap warning. A subsequent non-force pin waits for the leader established
  by that force pin.
- **Mode `auto`** (an owner opt-in, `lease.pinned {mode: "auto", leader: null}`): claims start a term,
  renewals extend it (`0 < until - at <= 24 h`, optional `waive`), releases end it. A device uses it
  only while its transport declares bounded propagation (`Transport.consistency`, proven by the
  carrier contract's propagation check) and its config covers the bound: `settle >= skew + publish
  deadline + propagation`. Over an eventual transport nobody holds in this mode. Exiting auto for
  pinned leadership requires an owner-confirmed `force` pin, even when the local auto view is free or
  names an expired holder: an unseen settled claim can otherwise overlap the new pinned leader. A
  non-force auto-to-pinned pin is refused by both the local builder and the lease fold. The existing
  force warning applies; an auto-to-auto pin is unchanged.
- The leader reports each completed fetch with `lease.fetched`; every device warns the owner when the
  pinned leader has been silent for more than 36 hours (`leaderLiveness`).
- **Pull evidence and the offline rule (device-local, no event):** a holder acts only within the
  publish deadline after a pull. In mode `pinned` a pass that reached every remote it could and missed
  only unreachable ones (network, timeout, 5xx, quota, the host's back-off; never a refusal such as a
  removed membership) counts as that pull (`LeaseLocal.offlinePull`), so a relay outage pauses sync and
  not the leader. While the registry holds another device that could be pinned (any device not known
  as a phone), this holds only for 7 days after the last complete pull (`OFFLINE_LEAD_MAX_MS`), or 7
  days after the owner's "keep fetching on this Mac" acknowledgement (the host's device-local relay
  setting, cleared by the next complete pull). A vault with no remote (sync off) reads as offline since
  its last complete pull, under the same rule. Mode `auto` ignores offline evidence.

Lease state never enters the view fold (6.2 LEADER), so the convergence scenarios do not model it.

## 9. Derived columns (never in a payload except as genesis stamps)

| Column | Recomputed from |
|---|---|
| `transactions.is_internal_transfer`, `transfer_group_id` | complete explicit transfer-run claims (8.3) plus the S08 matcher over currently unclaimed rows on native imports: counterparty IBAN only (rule 5) against the accounts' raw match key `iban_match` incl. removed accounts (D-08.1), amount key `transferAmountKey` (D-08.2), rows in anchor order, group id = the outflow row's gid (D-24.2) |
| `transactions.category`, `category_source` | claims + rules + payment patterns + recurring payees + engine (8.3), full recompute (S24 D-24.1), rule categories on every device (D8) |
| cash mirror legs (`cashleg:<@txn>`, `raw.cash_leg_of`) | the folded `manual_txn` claim `cash_withdrawal` of a row not on a cash account, while the cash pool account `cash:<CUR>` is open (S24 D-24.3; a locked merchant rule to `cash_withdrawal` makes no leg) |
| account key parking (`<key>~<@account>`) | per (bank, external id) group: live accounts hold the key (several live all show it, m12), else the latest opened (fold order of its first open); every other member is parked (S24 D-24.7) |
| `alerts.status` (effective) | 8.7 |
| `inv_signals.status = acknowledged`, `acknowledged_at` | decisions (6.5) |
| `inv_theses.core_changed_at`, `exit_plan_changed_at`, `reviewed_at` | 8.8 |
| `inv_topic_theses.core_changed_at`, `view_updated_at`, restart fields | 8.9 |
| `inv_strategy_versions.version`, "current" | order (8.8) |
| `inv_decisions.signal_id` | first of `signals` |
| `loans.updated_at`, `profile_modules.enabled_at`, `plan_at`, `strength_at`, `watchlist_items.added_at` | domain time of the setting event |
| view row gids of row-keyed tables | [`gid.md`](gid.md) 4.8 |
| `transactions.merchant_key` | `merchantKey(counterparty_name, reference, description)` of the row's own text (a cash expense: of its title, a cash leg: none), written with the row by `budget.transactions` (v4; until v3 it lived in the internal `fold_txn_keys`) |

Derived internal tables (not hashed, never synced). A table queries read declares `wakesWith`
(`TableDef`): the public tables written in every apply that changes it; `Store.tablesRead` reports them
for a SQL that names the table, so a live query over it wakes without reading them (the aggregates of
`budget.months`: `transactions`, `accounts`; the records of `budget.recurring`: also `category_rules`).
The deriver's other tables (its row memory and environment) declare nothing and are read by no query.

Companion derivers (`Deriver.companion`): `budget.recurring`, `budget.months` and `budget.search` are read only by
the phone's companion queries, so they are registered only on a store opened with `StoreOptions.companionReads`
(the phone; the desktop host, MCP and the CLI open without it). Each writes nothing but its own internal tables,
all `snapshot: false`, and comes after every other deriver (`Store.open` refuses otherwise), so the public view and
its hash are the same with and without them and the other derivers keep their recorded positions. Opening a database
last opened with the other setting is a partial upgrade: without the option their recorded components and tables are
dropped (never the whole-view rebuild a removed deriver otherwise causes), with it they run `deriveAll`. Without the
option `budget.categories` records no `fold_category_changes` (only they take them), and a query over their tables
fails with `CompanionReadsOffError`. A snapshot never carries their tables; `importSnapshot` compares the event
fingerprint and the recorded definitions without them, keeps the importing store's own definitions record, and
`rederiveSnapshotOmitted` derives every table left out (theirs included) on the importing store:

| Tables | Recomputed from |
|---|---|
| `fold_month_cat`, `fold_month_day`, `fold_month_rows`, `fold_month_env` (deriver `budget.months`, after `budget.recurring`); `fold_category_changes` (deriver `budget.categories`) | `fold_month_cat` / `fold_month_day`: per (account, currency, month, category) and per (account, currency, month, day): every row of every account (removed ones too, cash legs included), flow sums by `budget.isFlow` (income, expense, the uncategorized flow outflows), the signed sum of every row, row counts, the first flow outflow (row id), the day's largest inflow; exact decimal text summed in JS. `fold_month_rows`: each row's share of its groups as typed columns (account, currency, month, day, category, row id, amount text, flow and uncategorized flags) by row key, indexed by (account, month, category). `fold_month_env`: the own-IBAN signature. `fold_category_changes`: the row keys whose category the categories deriver wrote or whose transfer flag flipped (`*` after its full pass), taken by `budget.months` in the same apply (`budget.recurring` reads them without taking). Incremental per group: the dirty partitions and the changed rows; an unchanged row is skipped, a new row added to its groups, a changed row recomputes only the groups it left (its day groups only when currency, date, amount or flow changed) from their `fold_month_rows` and is added to the groups it joined, a vanished row recomputes its old groups. The own-IBAN set or a full categories pass runs the full derivation. Read by the phone's month figures, uncategorized count and cash pool balances instead of every row |
| `fold_recurring`, `fold_recurring_rows`, `fold_recurring_keys`, `fold_recurring_groups`, `fold_recurring_env` (deriver `budget.recurring` v2, between `budget.categories` and `budget.months`) | `fold_recurring_rows`: every non-internal outflow with a merchant key on an account that is not removed, clustered per (merchant key, currency) in book order (account id, row id), with its amount, its outflow key `format2(-amount)` when it is a detection member and the category it is judged by (the stored category through `budget.storedRecurringCategory`, else the engine without the recurring signal: `engine` 1). `fold_recurring`: one row per recurring candidate of each group over all its rows, every candidate active (`budget.detectRecurringGroup` + `budget.groupSeries`): typical amount, occurrences, median gap, last date, first-seen book position, newest charge's display payee, account and date, first charge, the last 12 charges as JSON. `fold_recurring_keys`: per (merchant key, currency, outflow key) the detection members (`n`) and those filed `subscriptions` or `other` (`filed`, `budget.RECURRING_FILED_CATEGORIES`), moved with every entry change; `fold_recurring_groups`: the groups with a key at `n >= budget.RECURRING_MIN_OCCURRENCES` or `filed > 0`, the only groups that can hold a candidate. Incremental per group: the dirty partitions, the rows the categories deriver changed (`fold_category_changes`, read without taking them) and the engine-judged rows of a re-ruled payee (every engine-judged row when the rule's row is gone); an unchanged row entry is skipped; a touched group that cannot recur and holds no record is not read. The visible accounts and their types (`fold_recurring_env`), a contribution change, a full categories pass or a bulk dirty set run the full derivation (only the groups that may recur are read). Read by the phone's recurring charges and payee histories (`core.companionMonth` bills, `core.companionUpcoming`, `core.attention`): active (45 days before the newest booking date up to `today`) is decided at query time, a group with a charge after `today` that may recur (`fold_recurring_groups`) or with stale and active candidates is recomputed from `fold_recurring_rows`. The desktop's recurring list (`overview/networth.ts`, `overview/index.ts`, `budget/desktop-queries.ts`) and `cashu stats` still detect over the book (`budget.recurringPayments`) |
| `fold_txn_fts` (deriver `budget.search` v2; a contentless FTS5 virtual table, `unicode61 remove_diacritics 2`), `fold_txn_fts_rows`, `fold_txn_fts_env` | one document per `transactions` row of a visible account (an `accounts` row, not removed; cash legs included), rowid = `<booking day since 1970-01-01> * 2^32 + transactions.id` (the index iterates newest day first; `rowid & 0xFFFFFFFF` is the row id): `text` = `normalizeText(counterparty_name description reference)` and the `merchant_key`, `amount` = the absolute amount as one token `<integer>d<fraction, >= 2 digits>` (`1284.00` -> `1284d00`). Incremental per row, documents written in ascending rowid (FTS5 flushes its pending terms on a lower rowid): the dirty partitions (every cash leg after an account change), the row's id, booking day and indexed text from `fold_txn_fts_rows` (a vanished or re-anchored row is deleted by rowid, an unchanged one skipped). A change of the visible accounts (`fold_txn_fts_env`) or a full re-fold runs the full derivation; a bulk dirty set stays incremental. Virtual tables (`TableDef.virtual`) are never hashed and never in a snapshot, nor are tables marked `snapshot: false` (`fold_txn_fts_rows`, `fold_txn_fts_env`): the import runs their deriver's `deriveAll` (`Store.rederiveSnapshotOmitted`, snapshot.ts). Read by the phone's search (`budgetSearch`: word-prefix tokens, case and diacritics folded both ways, dev-feedback #22.9) instead of a LIKE scan: the newest page from the index with an early exit, the total from its `count(*)`; a category-label token adds its category's rows through the `transactions.category` index |

Upgrade cost: `budget.transactions` v3 -> v4 (the `merchant_key` column) indexes refs, so the first
open after it rebuilds the whole view (rebuild.ts). Since M4 (S14) the desktop runs none of the companion derivers:
its rebuild and upgrading opens are back at the pre-M3 numbers (file mode, loaded machine: rebuild 1.8-1.9 s, a
`budget.transactions` bump's open 3.0-3.2 s CPU; performance.md), and the first desktop open of a database that held
their tables drops them. The M3 numbers below are the phone's store (with them). Before the M3 derivers, at 60k rows (`perf.test.ts`,
memory, load 6-10) the rebuild took 1.9-2.0 s wall and the upgrading open 2.5 s CPU. With the months
(C1), recurring and search (C2) derivers, two runs each, load 9-28 (not idle): rebuild 2.9-3.3 s wall
in memory, 4.1 s in file mode (WAL); a `budget.transactions` bump's open 3.8-3.9 s CPU in memory, 5.8-6.0 s
in file mode; a `budget.category_rules` bump (re-derives categories, recurring, months and search: the
planner does not know search reads no category column) 1.6-1.8 s / 2.1 s CPU. Desktop budget <= 3 s:
the file-mode rebuild and the transactions-bump open are over it (lead's sign-off pending). A bump of
`budget.search` alone (v1 -> v2) rebuilds only the index (~0.44 s at 60k); of `budget.recurring` alone
(v1 -> v2) only its tables.

## 10. What never syncs

| Data | Why |
|---|---|
| `inv_price_bars`, `inv_fx_rates`, `inv_macro_bars`, `market/calendar.json` | refetchable caches (D4) |
| `change_events` | replaced by store subscriptions |
| `mcp_calls` | per-device audit (D6) |
| `inv_notification_log` | each device notifies itself; dedup by (signal episode gid, severity) |
| `connectors`, `connector_runs` | code + approval is a security act on one machine (D7) |
| `connector_bindings.last_run_at`, `last_status`, `last_ok_at`, `backoff_until` | leader-local fetch state (the cursor syncs, 8.10) |
| `proposals.status = applying` | device-local lock |
| `alembic_version`, `settings.json`, `desktop.json`, `profiles/<slug>/workspace.json` | per device |
| Enable Banking keys / sessions, connector secrets, API token, run locks, the vault salt and data key in plaintext | device keychain (the salt and key travel only wrapped, at pairing) |
| local integer ids | view-internal |

## 11. Notes for genesis (S26)

- Genesis emits per vault one create / snapshot event per row in dependency order, `origin:
  "genesis"`, every timestamp column in `stamps` (4.4), soft-deleted rows with their deletion state.
  Derived columns appear only as stamps.
- Accounts: genesis emits `keys` from the stored IBAN (`iban:<ibanKey>`) and the external natural key;
  instruments: an `instrument.aliasAdded` per stored alias; signals: one `signal.opened` per row plus
  its lifecycle state; no open episodes collide on lab (0 duplicate open keys).
- Genesis emits no `instrument.merged` (Python keeps no merge record; `alias_collision` stays reserved).
- Signals are emitted grouped by their rewritten dedup key, keys in the order of their smallest signal
  id; within a key the closed signals first, ordered by (`closed_at`, id), each followed directly by
  its lifecycle events, then the at most one open signal. Plain id order would let an old reopened
  signal followed by a newer closed one alias the newer `signal.opened` to the open episode, whose
  `signal.closed` would then close the reopened one (8.7).
- Genesis clock, device, eids, collisions and dangling references: [`gid.md`](gid.md) 7.1-7.6.
- Genesis gids follow [`gid.md`](gid.md) 7.

## 12. Open items

Resolved in v1.1: O1 (broker instrument key in the hash), O2 / G4 (rebuild v2 from columns, `legacy:`
only for missing columns), O3, O4, O5, O6 (keep every run; compaction is S32's), O7, O8, O9, O10, O11
(inline), O12 (`raw` syncs), G1 (IBAN-first identity), G2 (accepted), G3 (episodes).

Resolved in v1.2 (lead decisions on the re-check):

- R-1 accepted with the N2 guard (one IBAN per component, checksum required).
- R-2 accepted for field registers; presence combines per member (N3). For the parity notes (S02 / S03):
  after a merge a newer edit on the source beats an older target value, where Python keeps the
  target's.
- R-3 accepted: Python also matches across banks (`budget/imports.py:386`, `by_any_bank`); the N2
  checksum keeps malformed numbers from fusing.
- R-4 accepted as a deferral: S29 is a hard gate before two devices may hold or contest the lease
  (multi-device fetching stays off until then).
- R-5 accepted: closes from either side converge in the episode fold; leader-only `notes_expired` only
  delays a close. Superseded for research runs (lead decision 2026-11-01, S21b): v1's leader-only close
  of a stale run no longer holds; any device closes a stale run `failed {interrupted}` on its next start
  / note, made safe by first-writer-wins on the run's status (8.9).

Remaining: none from S04. Hand-offs: the lease payloads and watermark wait (S29), the salt wrapping
and recovery (S27, [`gid.md`](gid.md) G5).
