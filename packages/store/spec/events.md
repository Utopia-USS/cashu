# cashU event catalog v1.2 (normative)

Status: v1.2 (scope S04, 2026-10-31), after the independent review and its v1.1 re-check
(`~/cashu-lab/checkpoints/S04-review.md`) and the lead's decisions on both. Consumers: S23 store-core,
S24/S25 materializers, S26 genesis, S28a carrier contract, S29 devices / lease, S30 Python outbox,
S31a/b bridge.

Companion documents: [`gid.md`](gid.md) (global ids, keyed DET construction, id-coupled strings).
Machine schemas: `packages/store/src/events/v1/*.ts` (zod). Executable reference semantics for the
convergence-critical rules: `packages/store/src/events/v1/reference/fold.ts`, with shuffled-delivery
tests in `reference/convergence.test.ts`; S23/S25 MUST give the same results on those scenarios.
The zod schemas are normative for field names and types, this document for semantics. Where they
disagree it is a bug in one of them: fix both in the same change.

MUST / MUST NOT / SHOULD are used in the RFC 2119 sense.

## 1. Model

- One **vault** = one profile. Every event belongs to exactly one vault and is encrypted with that
  vault's key (rule 7 becomes cryptographic). Nothing in an event refers to another vault.
- The **log** of a vault is the set of all events of all its devices. Each device appends only its
  own events. The log is append-only and immutable: an event is never edited or removed.
- The **view** (SQLite, today's table and column names plus `gid`) is a pure function of the set of
  events a device holds. Two devices holding the same set MUST produce the same view, whatever the
  order or duplication of delivery (convergence). The view is rebuildable at any time.
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
  "vault": "01JC0Z8Y3K7M4N5P6Q8R9S0T1V",
  "device": "k3v9q2m8x1c7b4n6",
  "hlc": "0mvwcmtc0-0000-k3v9q2m8x1c7b4n6",
  "at": "2026-10-31T12:00:00.000Z",
  "type": "alert.statusSet",
  "v": 1,
  "gid": "01JC0ZA1B2C3D4E5F6G7H8J9K0",
  "data": { "status": "muted", "snoozedUntil": null },
  "cause": "01JC0Z9A2B3C4D5E6F7G8H9J0A",
  "origin": "bridge"
}
```

| Field | Required | Format | Meaning |
|---|---|---|---|
| `eid` | yes | ULID (26 chars, Crockford base32, upper case) | Event id. Idempotency key: an event with an `eid` already applied is a no-op. Target of `cause`. |
| `vault` | yes | ULID | The profile's vault gid (= the profile gid). MUST equal the vault of the segment it was read from. |
| `device` | yes | 16 chars `[0-9a-z]` | The writing device's id (minted at pairing, S29). MUST equal the segment's device. |
| `hlc` | yes | section 3 | Hybrid logical clock stamp. Its device suffix MUST equal `device`. |
| `at` | yes | timestamp (section 4) | The writer's wall clock when the event was created. Default domain time (4.4); never used for ordering. |
| `type` | yes | `<entity>.<verb>`, `^[a-z][a-zA-Z]*\.[a-z][a-zA-Z]*$` | Event type (section 8). |
| `v` | yes | integer >= 1 | Schema version of this type's payload. Every v1 catalog type is at `v: 1`. |
| `gid` | yes | gid ([`gid.md`](gid.md)) | The entity the event is about (the row it creates or changes, as the writer saw it; identity resolution may redirect it, 6.4). |
| `data` | yes | JSON object | Payload, validated by the (type, v) schema. |
| `cause` | no | ULID | The `eid` of the event that caused this one in the same batch (side effects of an approval, a candidate acceptance). Causal suppression (6.6). |
| `origin` | no | `genesis` \| `bridge` | `genesis`: produced by the genesis exporter (S26); `bridge`: by the Python outbox shipper (S31a). Informational; reducers MUST NOT branch on it. |

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
device  = 16 chars [0-9a-z]: the writing device id
regex   = ^[0-9a-z]{9}-[0-9a-z]{4}-[0-9a-z]{16}$
```

Example: `2026-10-31T12:00:00.000Z` = `1793448000000` ms = `0mvwcmtc0`, so the first event of a device
in that millisecond is `0mvwcmtc0-0000-<device>`. 9 base36 digits hold wall times up to year 5188.

### 3.2 Comparison

- `a < b` iff `a` sorts before `b` by plain code-unit string comparison (JS `<`, SQLite `BINARY`,
  Python `<` on `str`). Fixed widths and lower-case base36 make this the numeric order of
  `(wall, counter, device)`; the device id is the tie-break between devices.
- A correct device never reuses an `hlc`. A device whose state was rolled back (restored backup,
  cloned disk) can; `eid` then breaks the tie (2). A device that finds its persisted clock behind its
  own events already in the log MUST stop writing and get a new device id (S29).

### 3.3 Generation (normative for S23 `hlc.ts`)

State per device per vault: `last = (wall, counter)`, persisted durably with the events it stamped.

- **Send**: `pt` = physical ms. If `pt > last.wall`: `(pt, 0)`, else `(last.wall, last.counter + 1)`.
- **Receive** (every applied remote event, before the next local stamp): `w = max(pt, last.wall,
  remote.wall)`; counter = 1 + the max counter among the inputs equal to `w`, or 0 when only `pt`
  equals `w`.
- **Counter overflow**: `(wall + 1, 0)`.
- **Emit guard (O7)**: a device MUST refuse to stamp (and show a clock error) while `pt` is behind
  its persisted `last.wall` by more than 5 minutes; receivers accept every event (convergence) and
  warn when a remote wall is more than 5 minutes ahead of `pt`. Pairing (S29) compares the clocks of
  the two devices and refuses a skew above 5 minutes.
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
| **LEADER** | emit constraint | Only the current fetch-lease holder emits it. Reducers accept it from any device; convergence never depends on lease state. |
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
  of the event (other keys, fill-if-null of `external_id`) still applies; a refused IBAN does not fill
  the view's `iban`.
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
  for field registers (lead decision on R-2; the parity notes in `parity/README.md` must list it, S02 / S03). **Presence** combines per
  member instead (N3): a watchlist row is live when any member's own SOFT register is live, so
  "remove the duplicate, then merge" keeps the target watched, as Python does.
- Accounts: the view's `iban` is the IBAN of the component's first accepted `iban:` claim (one key per
  component, N2); `external_id` is the first non-null over the component's events; `type` is LWW over
  `account.typeSet` initialised from the first applied open; `name` is the latest explicit
  `account.renamed` of any member, else the **root's own** opened name (N4), so an older CSV account
  folding into an Open Banking account does not rename it. Internal transfers match by counterparty
  IBAN only (rule 5), against every `iban:` key of the resolved account (at most one per component by
  N2, so the CSV NRB and the Open Banking IBAN of one account both match it; N5).

### 6.5 Cross-entity effects

| Event | Also affects | Effect |
|---|---|---|
| `decision.recorded` | the episode of each signal in `data.signals` | acknowledged if active |
| `decision.undone` | the undone decision's episodes | back to active if no other live decision links the episode at this point of the order |
| `signal.escalated {reactivate: true}`, `signal.woken` (guard passed) | its episode | clears acknowledged |
| `account.*`, `instrument.aliasAdded`, `instrument.merged` | every row keyed by them | row keys re-resolve (6.4) |
| `alert.statusSet` (muted / snoozed), `alert.deleted`, `alert.restored` | that alert's episode | the acting device emits `signal.closed` / `signal.reopened` in the same batch (no implicit effect) |

### 6.6 Causal suppression and FWW losers

- An event with `cause` = E is applied only if E is held, applied and not an FWW loser.
  Suppression is part of the fold: an event arriving later can flip it.
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

`reference/convergence.test.ts` exercises 1-3 on every blocker scenario: 40 shuffled deliveries plus
re-delivered duplicates, invariants checked on every prefix, all final views equal.

## 7. Forward compatibility and upcasting

1. **Unknown type**: store, do not apply, do not drop. The view counts `unknown_events` per type.
2. **Known type, newer `v`**: same as an unknown type.
3. **Known (type, v), unknown fields**: ignored, preserved in the log (loose schemas).
4. **Known (type, v) failing validation** (e.g. a new enum value): same as an unknown type.
5. **Upcasters** `(type, v) -> (type, v + 1)` are pure, applied on read; stored events never change.
6. **Evolving a type**: an optional field whose absence keeps the old meaning MAY keep `v`; anything
   else (new required field, changed meaning, new enum value, changed unit) MUST bump `v`. A type name
   is never reused.
7. **Writers never round-trip records**: they send only the fields they change.
8. **No write on stale semantics**: a device holding parked events of a row MUST NOT emit GUARD or
   FWW events for it.
9. **After an upgrade the device MUST rebuild the view** (M10): re-applying only the parked events is
   not enough, because events applied earlier with ignored fields may mean more to the new reader.
   View schema changes are rebuilds too (`viewVersion`, spike `Materializer`).

## 8. Catalog

Payload fields in camelCase; `@x` = gid reference to x. Every payload also accepts `stamps` (4.4).

### 8.1 Per-table summary

| Table | Events (v1) | gid | Rule |
|---|---|---|---|
| profiles | `profile.created`, `profile.renamed`, `profile.settingsChanged` | vault ULID | CREATE; LWW-F |
| profile_modules | `module.enabled`, `module.disabled` | DET(module_id) | `enabled` LWW register |
| accounts | `account.opened`, `account.identified`, `account.renamed`, `account.typeSet`, `account.removed`, `account.restored` | DET(iban) or DET(ext key), else ULID ([`gid.md`](gid.md) 4.3) | IDENTITY (6.4); name / type LWW-F; iban / externalId fill-if-null; removed SOFT |
| balances | `balance.recorded` | DET(account, date, source) | row key 6.4; amount / currency LWW-F |
| transactions | `txn.imported`, `txn.cashExpenseAdded`, `txn.categorySet`, `txn.categoryCleared`, `txn.deleted` | imported DET(account, dedupHashV2, occurrence); cash expense ULID | imported CREATE on the row key; claim GUARD; delete TOMB (cash expenses); transfers, rule categories, cash legs DERIVED |
| category_rules | `categoryRule.set` | DET(merchant_key) | GUARD (locked manual beats llm) + LWW-F |
| import_batches | `importBatch.recorded` | ULID | APPEND |
| loans | `loan.termsSet`, `loan.paymentMatchingSet` | DET(account) | LWW-F; the row is visible once terms exist |
| depreciations | `depreciation.set` | DET(account) | LWW-F |
| asset_details | `assetDetails.noteSet` | DET(account) | LWW-F |
| budget.json (cushion) | `budgetSettings.cushionSet` | DET("cushion") | LWW-F |
| inv_account_settings | `invAccount.settingsSet` | DET(account) | LWW-F |
| inv_import_batches | `invImport.recorded` | ULID | APPEND |
| inv_transactions | `invTxn.imported` | DET(account, dedupHashV2); manual entries ULID | CREATE on the row key |
| inv_position_snapshots | `position.snapshotImported` | DET(account, instrument, as_of) | CREATE on the row key |
| inv_instrument_renames | `instrumentRename.recorded` | DET(date, old, new) | CREATE on the row key |
| inv_manual_valuations | `valuation.set` | DET(instrument, as_of) | LWW-F on the row key |
| inv_instruments | `instrument.created`, `instrument.updated`, `instrument.merged` | DET(creation alias), else ULID | CREATE; LWW-F; IDENTITY (merge) |
| inv_instrument_aliases | `instrument.aliasAdded` | DET(namespace, value) | IDENTITY (claim) |
| inv_profile_instruments | `instrumentOverride.set`, `instrumentOverride.planSet`, `instrumentOverride.segmentSet` | DET(instrument) | LWW-F on the row key; segment GUARD |
| inv_strategy_versions (+ files) | `strategy.versionSaved` | ULID | APPEND; no-op when its sha equals the current version's; current = highest `hlc`; numbers DERIVED |
| inv_theses | `thesis.created`, `thesis.updated`, `thesis.deleted` | ULID | CREATE; LWW-F; TOMB; `*_changed_at` DERIVED |
| inv_topic_theses | `topicThesis.ownerSaved`, `topicThesis.draftProposed`, `topicThesis.rejected`, `topicThesis.marketViewSet` | DET(segment) | GUARD + LWW-F; restart on a rejected row (8.9); rejected SOFT |
| watchlist_items | `watchlist.added`, `watchlist.updated`, `watchlist.removed` | DET(instrument) | row key 6.4; added = create or restore + LWW of `added_at`, `source`, given note / tags (M2); removed SOFT per member; presence = any member live (N3) |
| alerts | `alert.created`, `alert.updated`, `alert.statusSet`, `alert.deleted`, `alert.restored`, `alert.evaluated` | ULID | CREATE; config LWW-F; deleted SOFT; runtime LEADER LWW-F; effective status DERIVED |
| inv_planned_deposits | `plannedDeposit.created`, `plannedDeposit.cancelled`, `plannedDeposit.booked` | ULID | CREATE; cancel / book FWW; a transaction books at most one plan (GUARD, O10) |
| inv_signals | `signal.opened`, `signal.refreshed`, `signal.escalated`, `signal.closed`, `signal.reopened`, `signal.snoozed`, `signal.woken` | ULID | EPISODE per resolved dedup key (8.7); snooze LWW; woken GUARD; acknowledged DERIVED (6.5) |
| inv_rule_runs | `ruleRun.finished` | ULID | APPEND, LEADER (D5: the view keeps the last N) |
| inv_decisions + inv_decision_signals | `decision.recorded`, `decision.undone` | ULID | APPEND; links embedded; undo TOMB |
| reviews | `review.done`, `review.undone` | ULID | APPEND; undo TOMB |
| proposals | `proposal.created`, `proposal.approved`, `proposal.rejected`, `proposal.failed` | ULID | CREATE; terminal FWW; caused side effects (6.6); import-like kinds leader-only |
| research_runs | `researchRun.started`, `researchRun.finished` | ULID | APPEND; finish LWW-F |
| research_notes | `note.added`, `note.read`, `note.dismissed`, `note.restored` | ULID | APPEND; read / dismissed LWW-F |
| connector_bindings | `connectorBinding.set`, `connectorBinding.removed`, `connectorBinding.cursorAdvanced` | DET(account, connector_id) | LWW-F on the row key; removed SOFT (M1); cursor LWW, LEADER, caused (M5) |

### 8.2 Core

- `profile.created` (gid = vault) `{slug, name, baseCurrency, mcpPrivacy: strict|amounts}`. `slug` is
  a device-local alias for folders and URLs (O9): a device that already has a vault with that slug
  maps it to a local alias; the vault gid is the identity.
- `profile.renamed` `{name}`. `profile.settingsChanged` `{baseCurrency?, mcpPrivacy?}` (LWW-F). The MCP
  server uses the **stricter** of the synced `mcpPrivacy` and the device-local acknowledged level;
  loosening (strict -> amounts) takes effect on a desktop only after its owner confirms it there (O8).
- `module.enabled` / `module.disabled` `{moduleId}`: one LWW register; `enabled_at` = domain time of
  the winning `module.enabled`.
- `account.opened` `{bank, externalId|null, iban|null, currency, type, name, active?, keys[]}`.
  `keys` are the identity keys the writer knows (`iban:<ibanKey(iban)>` when an IBAN is known,
  `ext:<bank>:<key>` for an external natural key); empty for manual, vehicle and brokerage accounts.
  Writers resolve first: look up the view by IBAN key, then by external key, and emit
  `account.identified` on the found account instead of opening a new one; concurrent opens that miss
  each other are joined by identity resolution. Open Banking never emits `account.renamed` (its
  "name" is the holder's name); the first applied open supplies the initial name.
- `account.identified` `{iban?, externalId?, keys[]}` (min 1 key): the account learned an IBAN (Open
  Banking, a statement, a parser that found it) or a new external key (an Enable Banking re-consent
  uid). Fills `iban` / `external_id` when still null and claims `keys`, which may merge accounts; an
  `iban:` key is claimed only with a checksum-valid `iban` and never as a second IBAN of one account
  (N2, 6.4).
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
  cashu-format document creates an `import`-like proposal instead (O3). A new lease holder MUST NOT run
  them before it has applied the previous holder's events up to the watermark of that holder's last
  lease renewal (M6; `lease.claimed` / `lease.renewed` carry `{watermark: hlc}`, S29).
- `txn.cashExpenseAdded` (ULID) `{account@ (cash account), bookingDate, amount (< 0), currency, title,
  category}`. View: `source = manual`, `category_source = manual_txn`, `dedup_hash = "cashexp:" + gid`.
- `txn.categorySet` `{category, source: manual_txn|llm_full|llm_fallback}`: a per-transaction claim
  (D8). GUARD: an `llm_*` claim is a no-op while the folded claim is `manual_txn`. A claim may target a
  derived cash leg (the owner recategorizes a leg, m2): the view shows the leg as
  `DET(transactions)["cashleg", anchor]`, and a claim addressed to the leg gid of **any** member of the
  source row (`DET["cashleg", member]`) applies to that row's leg, so leg edits survive anchor changes
  after account merges (N1). Leg claims persist while the leg is absent and apply when it reappears.
- Marking a bank transaction `cash_withdrawal` makes the derived mirror leg appear on the cash pool
  account `cash:<CUR>`; the emitting device MUST include an `account.opened` for that DET account in
  the same batch when its view does not have it (m3; concurrent opens collapse by gid).
- `txn.categoryCleared` `{}`: removes the claim (Python `recategorize_one` after the leg is deleted,
  `budget/cash.py:delete_cash_transaction`).
- `txn.deleted` `{}`: TOMB, only for cash expenses. Deleting a mirror leg emits `txn.categoryCleared`
  on the source bank transaction.
- Effective category (DERIVED, S08/S09): `manual_txn` claim > structural transfer / locked merchant
  rule / loan pattern (`engine.owner_decision`) > `llm_full` claim > engine.
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
- `assetDetails.noteSet` `{account@, note|null}` (<= 500 chars).

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
  merge-invariant (O1, [`gid.md`](gid.md) 4.6). Manual entries (`source = manual`) get a ULID gid and
  `dedupHash = "manual:" + gid`: two identical manual rows from two devices stay two rows (m1).
- `position.snapshotImported` `{account@, instrument@, asOf, quantity, currency, avgPrice|null,
  marketValue|null, batch@|null}`.
- `instrumentRename.recorded` `{date, old@, new@, note|null, batch@|null}`.
- `valuation.set` `{instrument@, asOf, unitValue, currency, note|null}`.

### 8.6 Instruments (per vault, D3)

- `instrument.created` `{name, currency, assetClass, symbol|null, isin|null, mic|null, region|null,
  sector|null, tags[], needsClassification, valuationMode, status, creationAlias|null}`. Writers also
  emit `instrument.aliasAdded` for every alias, the creation alias included.
- `instrument.updated` `{...patch of the shared fields}` (LWW-F on the resolved row).
- `instrument.aliasAdded` (gid DET(namespace, value)) `{instrument@, namespace, value, guessed}`: an
  IDENTITY claim (6.4). A claim of an alias another instrument holds merges the claimer into it: no
  leader action is needed (v1's leader-emitted collision merge is gone).
- `instrument.merged` (gid = source, checked by `parseEvent`) `{source@, target@, reason:
  owner|alias_collision}`: an owner merge. With claims handling collisions, `alias_collision` is kept
  only for genesis of merges Python recorded.
- `instrumentOverride.set` `{instrument@, name?, assetClass?, tags?, region?, sector?, valuationMode?,
  status?, needsClassification?}` (null = shared default, `""` clears for this profile).
- `instrumentOverride.planSet` `{instrument@, plan|null, reason|null}` (one register; `plan_at` =
  domain time).
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
- `signal.refreshed` `{severity?, message?, payload?, run@|null, seenAt}`; `signal.escalated`
  `{severity, message, payload, reactivate, run@|null, seenAt}`: same emitters as `opened`.
- `signal.closed` `{status: resolved|expired, reason}`. Lease holder for rule outcomes, alert
  housekeeping (`alert_expired`, m8) and research expiry (`notes_expired`); any device for
  `snooze|mute|delete` (alert owner actions) and `note_dismissed`.
- `signal.reopened` `{reason: alert_restored|note_restored}` (any device, in the batch of
  `alert.restored` / `note.restored`).
- `signal.snoozed` `{until|null}` (any device). `signal.woken` `{until}` (lease holder).
- `ruleRun.finished` (LEADER) `{trigger, asOf, status, strategyVersion@|null, stats, errors[], report:
  {new: @signal[], escalated: @signal[]}, startedAt, finishedAt|null}`; `trigger` is an open label
  (`worker`, `api`, `cli`, `app`).
- `alert.created` `{instrument@|null, scope, kind, params, polarity, severity, title, note|null,
  source: user|agent, createdBy, cooldownDays|null, expiresAt|null}`; `alert.updated` (patch);
  `alert.statusSet` `{status: active|muted|snoozed, snoozedUntil|null}` (owner state);
  `alert.deleted` / `alert.restored` (SOFT); `alert.evaluated` (LEADER) `{triggered, lastCheckedAt?,
  lastValue?, lastTriggeredAt?}` (runtime state).
- Effective alert status (DERIVED, reader's clock): muted > expired (`expiresAt <= now`) > snoozed
  (`snoozedUntil > now`) > triggered > active.
- Alert signals: `rule_id = dedup_key = "alert:<alert gid>"`.

### 8.8 Journal, theses, strategy, planned deposits

- `decision.recorded` `{signals: @signal[], instrument@|null, account@|null, action, quantity|null,
  price|null, currency|null, reason|null}`; `inv_decisions.signal_id` = first link (DERIVED).
  `decision.undone` `{}` (TOMB).
- `thesis.created` / `thesis.updated {..., reviewed?: true}` / `thesis.deleted`. DERIVED:
  `core_changed_at` = domain time of the latest change by value of `entryType`, `thesis` or
  `invalidation`; `exit_plan_changed_at` = of the latest change of `exitPlan` (null without a plan);
  `reviewed_at` = of the latest `reviewed: true`. Genesis stamps seed them (4.4).
- `strategy.versionSaved` (ULID) `{yamlText, mdText|null, sha256, state, issues[]}`. A version whose
  `sha256` equals the current version's at its position in the order is a no-op (m9; two desktops
  detecting one external edit). Current = highest applied `hlc`; numbers DERIVED. The strategy files
  are a projection (D15); the projection writer MUST compare the files on disk with the last
  projected content before writing and, on a difference, ingest the external edit as a new version
  first (detect-before-write, O5). It never overwrites silently.
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
- `researchRun.started` `{scope, createdBy}`; `researchRun.finished` `{status, counts}`.
- `note.added` `{run@|null, instrument@|null, theme|null, segment|null, kind, polarity, strength,
  thesisRelation, thesisField|null, title, summary, sources[], details|null, candidateKey|null,
  signal@|null, observedAt, expiresAt, createdBy}`; owner notes are born read. `note.read`,
  `note.dismissed {cooldownUntil|null}`, `note.restored` (LWW-F). Dismissing / restoring the last
  note of a research signal emits `signal.closed {note_dismissed}` / `signal.reopened {note_restored}`
  in the same batch. Accepting a candidate emits `watchlist.added` / `thesis.created` with `cause`.

### 8.10 Agent layer, connectors

- `review.done` `{module, doneAt?, notes|null, stats}`; `review.undone` (TOMB).
- `proposal.created` `{kind: strategy|custom_rule|import|budget_import, summary, reason|null, payload,
  source}`; `payload` uses gids and blob refs (`account@`, `blob: {sha256, ext}`, never `account_id` or
  `staged`). `proposal.approved {result}` / `rejected {note|null}` / `failed {result}`: terminal FWW;
  side-effect events in the approval batch carry `cause`. Approval is desktop only (D14); for
  `import` and `budget_import` all three terminal types are emitted by the lease holder only (O3, O4).
  `applying` is a device-local lock state.
- `connectorBinding.set` `{account@, connectorId, params, autoCommit}` (creates or re-creates);
  `connectorBinding.removed` `{}` (SOFT); `connectorBinding.cursorAdvanced` `{cursor|null}` (LEADER,
  `cause` = the approval when it comes from one). The cursor now syncs, so a new lease holder resumes
  where the old one stopped; backoff and `last_*` stay leader-local (refines D7).

### 8.11 Reserved

`device.*`, `lease.*` (S29) and `snapshot.*` (S32) are defined by those scopes. Requirement on S29
from this spec: lease claims and renewals carry `{watermark: hlc}` (the holder's highest applied hlc),
used by 8.3.

## 9. Derived columns (never in a payload except as genesis stamps)

| Column | Recomputed from |
|---|---|
| `transactions.is_internal_transfer`, `transfer_group_id` | the resolved account set, counterparty IBAN only (rule 5) |
| `transactions.category`, `category_source` | claims + rules + engine (8.3), rule categories on every device (D8) |
| cash mirror legs (`cashleg:<@txn>`, `raw.cash_leg_of`) | effective category `cash_withdrawal` of bank transactions |
| account key parking (`<key>~<@account>`) | removed accounts whose name key a live account holds |
| `alerts.status` (effective) | 8.7 |
| `inv_signals.status = acknowledged`, `acknowledged_at` | decisions (6.5) |
| `inv_theses.core_changed_at`, `exit_plan_changed_at`, `reviewed_at` | 8.8 |
| `inv_topic_theses.core_changed_at`, `view_updated_at`, restart fields | 8.9 |
| `inv_strategy_versions.version`, "current" | order (8.8) |
| `inv_decisions.signal_id` | first of `signals` |
| `loans.updated_at`, `profile_modules.enabled_at`, `plan_at`, `watchlist_items.added_at` | domain time of the setting event |
| view row gids of row-keyed tables | [`gid.md`](gid.md) 4.8 |

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

## 11. Notes for genesis (S26) and the outbox (S30)

- Genesis emits per vault one create / snapshot event per row in dependency order, `origin:
  "genesis"`, every timestamp column in `stamps` (4.4), soft-deleted rows with their deletion state.
  Derived columns appear only as stamps.
- Accounts: genesis emits `keys` from the stored IBAN (`iban:<ibanKey>`) and the external natural key;
  instruments: an `instrument.aliasAdded` per stored alias; signals: one `signal.opened` per row plus
  its lifecycle state; no open episodes collide on lab (0 duplicate open keys).
- Genesis gids follow [`gid.md`](gid.md) 7. A conformance test validates real lab rows through the zod
  schemas (counts only): `lab-conformance.test.ts`, enabled by `CASHU_LAB_DB`.
- The outbox captures field diffs of synced columns (section 9 excluded) and maps them to these types;
  explicit emits for `instrument_merge.py`, decision / review undo, thesis delete, cash expense delete,
  binding removal and every bulk `update()/delete()` on a synced table (R6).
- Python-side derived writes MUST NOT be shipped. The Python side SHOULD validate outbound events
  against JSON Schema generated from these zod schemas (`z.toJSONSchema`).
- The outbox computes DET gids itself, so the per-vault gid salt ([`gid.md`](gid.md) 3) MUST be
  available to the Python outbox (S30) exactly as to the TS store: S27 stores it where both runtimes
  read it (the device keyring entry next to the data key; Python via `keyring`), never in a file in the
  data dir.

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
  delays a close.

Remaining: none from S04. Hand-offs: the lease payloads and watermark wait (S29), the salt wrapping,
recovery and dual-runtime storage (S27, [`gid.md`](gid.md) G5).
