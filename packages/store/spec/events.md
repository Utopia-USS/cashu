# cashU event catalog v1 (normative)

Status: v1 draft for lead review (scope S04, 2026-10-31). Consumers: S23 store-core, S24/S25
materializers, S26 genesis, S28a carrier contract, S30 Python outbox, S31a/b bridge.

Companion documents: [`gid.md`](gid.md) (global ids, canonical inputs, id-coupled strings). Machine
schemas: `packages/store/src/events/v1/*.ts` (zod). The zod schemas are normative for field names
and types; this document is normative for semantics (ordering, conflict rules, compatibility).
Where they disagree it is a bug in one of them: fix both in the same change.

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

## 2. Envelope

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
| `eid` | yes | ULID (26 chars, Crockford base32, upper case) | Event id. Globally unique. Idempotency key: an event with an `eid` already applied is a no-op. |
| `vault` | yes | ULID | The profile's vault gid (= the profile gid). MUST equal the vault of the segment it was read from; a mismatch is rejected (never applied, logged). |
| `device` | yes | 16 chars `[0-9a-z]` | The writing device's id (minted at pairing, S29). |
| `hlc` | yes | see section 3 | Hybrid logical clock stamp. Its device suffix MUST equal `device`. |
| `at` | yes | timestamp (section 4) | The writer's wall clock when the event was created. Informational and the default source of domain timestamps (section 4.4); never used for ordering. |
| `type` | yes | `<entity>.<verb>`, `^[a-z][a-zA-Z]*\.[a-z][a-zA-Z]*$` | Event type (section 8). |
| `v` | yes | integer >= 1 | Schema version of this type's payload. Every v1 catalog type starts at `v: 1`. |
| `gid` | yes | gid ([`gid.md`](gid.md)) | The primary entity the event is about (the row it creates or changes). |
| `data` | yes | JSON object | Payload, validated by the (type, v) schema. |
| `cause` | no | ULID | The `eid` of the event that caused this one in the same batch (side effects of a proposal approval, a candidate acceptance, a decision). Used for causal suppression (section 6.6). |
| `origin` | no | `genesis` \| `bridge` | `genesis`: produced by the genesis exporter (S26) from an existing database. `bridge`: produced by the Python outbox shipper (S31a). Absent: a native TS writer. Informational; reducers MUST NOT branch on it. |

Rules:

- `eid` collision with a different body (any field differs) is corruption: keep the first applied,
  reject the other, report it. It never happens with correct writers.
- The envelope schema is a loose object: unknown envelope fields MUST be preserved in the log and
  ignored by the reader (future fields, e.g. a signature).
- The total order of events is the order of `hlc` strings (section 3). `eid` is not an ordering key.

## 3. Hybrid logical clock

### 3.1 Format

```
<wall>-<counter>-<device>
wall    = 9 chars base36 [0-9a-z], zero-padded: milliseconds since 1970-01-01T00:00:00Z
counter = 4 chars base36, zero-padded: 0 .. 1679615 (zzzz)
device  = 16 chars [0-9a-z]: the writing device id
regex   = ^[0-9a-z]{9}-[0-9a-z]{4}-[0-9a-z]{16}$
```

Example: `2026-10-31T12:00:00.000Z` = `1793448000000` ms = `0mvwcmtc0` (base36, lower case, padded to
9), so the first event of a device in that millisecond is `0mvwcmtc0-0000-<device>`. 9 base36 digits
hold wall times up to year 5188.

### 3.2 Comparison

- `a < b` iff `a` sorts before `b` by plain code-unit string comparison (JS `<`, SQLite `BINARY`
  collation, Python `<` on `str`). Fixed widths and lower-case base36 make this equal to the numeric
  order of `(wall, counter, device)`.
- A device never emits two events with the same `hlc` (the counter or the wall strictly increases),
  and the device id is part of the string, so `hlc` is unique across the vault: it is a strict total
  order of all events. The device id is the deterministic tie-break between devices that share
  `(wall, counter)`.

### 3.3 Generation (normative behaviour for S23 `hlc.ts`)

State per device per vault: `last = (wall, counter)`, persisted durably together with the events it
stamped (a restart MUST NOT go backwards; the spike found this bug class).

- **Send / local event**: `pt` = physical time ms. If `pt > last.wall`: `(pt, 0)`. Else
  `(last.wall, last.counter + 1)`.
- **Receive** (every event applied from another device, before stamping the next local event):
  `w = max(pt, last.wall, remote.wall)`; counter = `max of the counters of those equal to w` + 1, or
  0 when only `pt` equals `w`. Standard HLC.
- **Counter overflow** (would exceed `zzzz`): use `(wall + 1, 0)`.
- **Drift**: a received event whose wall is more than 5 minutes ahead of `pt` is accepted (the log
  must converge) and the clock advances, but the device SHOULD warn (clock skew); see Open item O7.
- Genesis (S26) stamps its events with the generating device's clock like any local writer, in
  dependency order (an entity's create before its changes, a referenced entity before the reference).

## 4. Encoding rules

### 4.1 JSON

UTF-8 JSON. No `NaN` / `Infinity`. Object key order is irrelevant. Strings are stored exactly as
written (no Unicode normalization, no trimming) except where a field says otherwise; matching data
(Polish texts, merchant keys) stays byte-identical.

### 4.2 Absent vs null

In change events (`*.updated`, `*.set` patches) a key that is **absent** leaves the field unchanged;
a key present with `null` **clears** it. In create events an absent optional key means null.

### 4.3 Values

| Kind | Format |
|---|---|
| Decimal (money, quantity, rate, price) | JSON string, plain notation, `^-?(0\|[1-9][0-9]*)(\.[0-9]+)?$`. Scale preserved as written (`"10.50"` stays `"10.50"`); exponent forms (`1E+1`) MUST be rewritten to plain notation by the writer (Python: `format(d, "f")`). Never a JSON number. Compare by value, never by text, except in gid inputs where [`gid.md`](gid.md) section 3 defines the canonical text. |
| Calendar date | `YYYY-MM-DD` (local calendar date as today, no time zone). |
| Timestamp | UTC, `YYYY-MM-DDTHH:MM:SS[.f{1,6}]Z`. TS writers emit milliseconds (3 digits); genesis keeps the microseconds Python stored. Naive datetimes from SQLite are UTC (as `reviews.py` assumes). |
| Currency | `^[A-Z]{3}$`. Exception: instrument and quote currencies may be any upper-case code the importers produce (`^[A-Z0-9]{2,10}$`, e.g. crypto). |
| Reference to another entity | its gid (ULID or UUIDv5, [`gid.md`](gid.md)). Never a local integer id. |
| JSON blobs (`params`, `raw`, `stats`, `payload`, `scope`, ...) | JSON object; any id inside MUST be a gid ([`gid.md`](gid.md) section 6). |

### 4.4 Domain timestamps

A view column like `created_at`, `updated_at`, `done_at`, `acknowledged_at`, `plan_at` is set from
the `at` of the event that sets it, unless the payload carries an explicit value for it (payload
fields named like the column, camelCase: `createdAt`, `doneAt`, ...). Payloads carry explicit
timestamps only where the time is not "now" (a backdated review, `observedAt` of a research note,
`expiresAt`, `snoozedUntil`) and in genesis events (`origin: "genesis"`), which carry every
timestamp column of the row they snapshot so the view stays byte-equal to the Python database.

## 5. Batches

- A **batch** is the unit a device appends atomically (carrier contract, S28a): its events become
  visible together or not at all. A materializer applies a batch in one SQLite transaction.
- Events of one batch have strictly increasing `hlc` from one device. A command that produces
  several events (an import, a proposal approval with its side effects, a decision that links
  signals) MUST put them in one batch.
- Batches carry no semantics beyond atomicity: every event is ordered by its own `hlc`.

## 6. Conflict rules (reducers)

### 6.1 The fold

The state of an entity is the left fold of its relevant events sorted ascending by `hlc`:

```
state(gid) = events touching gid (own events + cross-entity effects, 6.5), sorted by hlc
             .reduce(reducer[type], initial = absent)
```

Every reducer is a pure function of (state, event). Validation guards that must hold under
concurrency are re-evaluated **inside** the reducer against the folded state, not only at emit
time (e.g. "the agent never overwrites the owner's segment"): a guarded event that fails its guard
at its position in the order is a **no-op** (it stays in the log). This makes every rule below
convergent by construction. An implementation MAY apply incrementally when a new event sorts after
everything already applied to that entity, and MUST re-fold the entity (or rebuild) when an event
arrives that sorts before already-applied events of it.

### 6.2 Rule vocabulary

| Code | Rule | Reducer behaviour |
|---|---|---|
| **CREATE** | create-once (union) | The first create event (lowest `hlc`) creates the entity and supplies initial field values. Later create events for the same gid are no-ops (dedup of the same fact seen twice: imports, DET gids). |
| **LWW-F** | last writer wins per field | Each field is a register; an event sets the fields present in its `data` (4.2). The later `hlc` wins per field. A "record" event (`*.set` with all fields of its version) is LWW-F over the fields its version defines: fields added by newer versions survive an older writer's set. There is no whole-record replacement in v1. |
| **SOFT** | soft delete register | `removed`/`deleted` sets a timestamp register, `restored`/re-`added` clears it; LWW by `hlc`. The row stays (Python keeps it too). |
| **TOMB** | tombstone | A delete event ends the entity: every later event for that gid (by `hlc`) is a no-op, and the view drops the row. An explicit `restore` type exists only where named; there is no implicit resurrection. Earlier events (lower `hlc`) still fold before it. |
| **APPEND** | append-only | Each event creates its own immutable entity (decisions, reviews, notes, runs, versions). Its only later change is the listed TOMB or LWW-F side fields. |
| **FWW** | first writer wins (state transition) | Among concurrent terminal transitions of one entity (approve / reject / fail, book / cancel), the lowest `hlc` wins; later terminal transitions are no-ops and their caused events are suppressed (6.6). Used for actions with side effects. |
| **GUARD** | precedence register | LWW-F whose reducer first checks a precedence condition against the folded state (owner > agent, locked manual > learned). |
| **LEADER** | emit constraint | Only the current fetch-lease holder (S29) emits it. Reducers accept it from any device (lease state is not part of the fold); split-brain duplicates converge because LEADER entities have DET gids or are append-only. |
| **DERIVED** | not an event | The column is recomputed by the materializer from other state after apply (section 9). Never carried in a payload, never captured by the outbox. |

### 6.3 Tombstones and soft deletes

- Hard deletes in Python become TOMB events: decision undo, review undo, thesis delete, cash expense
  delete, connector binding removal. The view row disappears; the log keeps the history.
- Soft deletes stay SOFT (accounts `removed_at`, alerts `deleted_at`, watchlist `removed_at`,
  topic thesis `rejected_at`).
- Undo windows (review, decision: 15 minutes; alert restore window) are checked at emit time against
  the view; the reducer applies an emitted undo unconditionally (a window is not a concurrency
  invariant).

### 6.4 References, dangling references, merges

- A reference to a gid the view does not have yet (its creating event has not arrived) **parks**
  the referencing event: kept, not applied, re-applied when the target arrives. Partial delivery of
  per-device segments makes this normal. Parked events never block other entities.
- A reference to a TOMB-ended entity applies normally to the referencing entity (e.g. a research
  note pointing at a deleted thesis keeps the pointer); views decide what to show.
- Instrument merges (`instrument.merged`, section 8.6) form a union-find: every reference to a
  merged source gid resolves to its final target at materialize time. A merge whose source is
  already merged, or whose source and target resolve to the same gid, is a no-op. Merges are never
  undone.

### 6.5 Cross-entity effects

Some events change entities other than their `gid`. These are part of the target entity's fold:

| Event | Also affects | Effect |
|---|---|---|
| `decision.recorded` | each signal in `data.signals` | marks it acknowledged at this `hlc` if open |
| `decision.undone` | the undone decision's signals | reverts acknowledged to active if no other live decision links the signal at this point of the order |
| `signal.escalated` with `reactivate: true`, `signal.woken` | itself | clears acknowledged |
| `instrument.merged` | every entity referencing the source | references redirect (6.4); per-table collision rules of section 8.6 |
| `alert.statusSet` (muted / snoozed), `alert.deleted` | that alert's open signal | the acting device also emits `signal.closed` in the same batch (no implicit effect) |

### 6.6 Causal suppression

An event with `cause` = E is applied only if E is applied and not a no-op. When a proposal approval
loses an FWW race, every event it caused is suppressed. Suppression is part of the fold (an event
that arrives later can flip it), so implementations re-fold affected entities like any out-of-order
arrival.

## 7. Forward compatibility and upcasting

1. **Unknown type** (a newer client's event): store it, do not apply it, do not drop it. The view
   records `unknown_events` (count per type) so the UI can say "update the app to see everything".
   After an upgrade the device rebuilds (or re-applies the parked events).
2. **Known type, newer `v`** than the reader knows: same as an unknown type.
3. **Known (type, v), unknown fields** in `data`: ignored by the reader, preserved in the log
   (payload schemas are loose objects).
4. **Known (type, v) that fails validation** (e.g. a new enum value an old schema rejects): same as
   an unknown type. Never partially applied, never dropped.
5. **Old events on a new reader**: upcasters `(type, v) -> (type, v + 1)` are pure functions applied
   on read, chained up to the current version. The stored event never changes.
6. **Evolving a type**: adding an optional field whose absence keeps the old meaning MAY keep `v`.
   Any other change (new required field, changed meaning, new enum value, changed unit) MUST bump `v`
   and ship an upcaster. A type name is never reused for a different meaning; removing a type means
   no new writer emits it while readers keep its reducer.
7. **Writers never round-trip records.** An older client changes only the fields it edits (LWW-F
   patches), so it cannot clear a field it does not know.
8. **No write on stale semantics.** A device that holds parked events of an entity (unknown type or
   newer `v`) MUST NOT emit GUARD or FWW events for that entity (its guard check may be wrong); it
   shows the entity read-only until upgraded.
9. Schema changes of the view are rebuilds, not migrations (the view is derived).

## 8. Catalog

Payload fields are listed in camelCase (the zod schemas hold types and optionality). `@x` = a gid
reference to entity x. All money / quantities are decimal strings.

### 8.1 Per-table summary

Every user-authored table of the data profile (scopes.md section 1) is listed. "gid" codes are
defined in [`gid.md`](gid.md): **DET(...)** = UUIDv5 over the named canonical input, **ULID** = minted
at creation (genesis: `DET-G`).

| Table | Events (v1) | gid | Rule |
|---|---|---|---|
| profiles | `profile.created`, `profile.renamed`, `profile.settingsChanged` | vault ULID | CREATE; fields LWW-F |
| profile_modules | `module.enabled`, `module.disabled` | DET(module_id) | `enabled` LWW register |
| accounts | `account.opened`, `account.renamed`, `account.typeSet`, `account.removed`, `account.restored` | DET(bank, external_id) for external / implicit keys (bank uid, `csv:<IBAN>`, `cash:<CUR>`), else ULID ([`gid.md`](gid.md) 4.3) | CREATE (identity first-wins); name, type LWW-F; removed SOFT |
| balances | `balance.recorded` | DET(account, date, source) | CREATE + amount/currency LWW-F |
| transactions | `txn.imported`, `txn.cashExpenseAdded`, `txn.categorySet`, `txn.categoryCleared`, `txn.deleted` | imported: DET(account, dedupHashV2, occurrence); cash expense: ULID | CREATE; category claim GUARD+LWW; delete TOMB (cash expenses only); transfer columns, rule categories and cash legs DERIVED |
| category_rules | `categoryRule.set` | DET(merchant_key) | GUARD (locked manual beats llm) + LWW-F |
| import_batches | `importBatch.recorded` | ULID | APPEND |
| loans | `loan.termsSet`, `loan.paymentMatchingSet` | DET(account) | CREATE on first termsSet; LWW-F |
| depreciations | `depreciation.set` | DET(account) | LWW-F |
| asset_details | `assetDetails.noteSet` | DET(account) | LWW-F |
| budget.json (cushion) | `budgetSettings.cushionSet` | DET("cushion") | LWW-F |
| inv_account_settings | `invAccount.settingsSet` | DET(account) | LWW-F |
| inv_import_batches | `invImport.recorded` | ULID | APPEND |
| inv_transactions | `invTxn.imported` | DET(account, dedupHashV2) | CREATE |
| inv_position_snapshots | `position.snapshotImported` | DET(account, instrument, as_of) | CREATE; later identical key = no-op (the first import's line stays, as Python's UNIQUE does) |
| inv_instrument_renames | `instrumentRename.recorded` | DET(date, old, new) | CREATE |
| inv_manual_valuations | `valuation.set` | DET(instrument, as_of) | LWW-F |
| inv_instruments | `instrument.created`, `instrument.updated`, `instrument.merged` | DET(creation alias), else ULID | CREATE; fields LWW-F; merge union-find |
| inv_instrument_aliases | `instrument.aliasAdded` | DET(namespace, value) | CREATE (first claim owns the alias; a second instrument's claim is a no-op and flags a collision, 8.6) |
| inv_profile_instruments | `instrumentOverride.set`, `instrumentOverride.planSet`, `instrumentOverride.segmentSet` | DET(instrument) | LWW-F; segment GUARD |
| inv_strategy_versions (+ strategy files) | `strategy.versionSaved` | ULID | APPEND; current = highest `hlc`; version numbers DERIVED |
| inv_theses | `thesis.created`, `thesis.updated`, `thesis.deleted` | ULID | CREATE; LWW-F; TOMB; `*_changed_at` DERIVED |
| inv_topic_theses | `topicThesis.ownerSaved`, `topicThesis.draftProposed`, `topicThesis.rejected`, `topicThesis.marketViewSet` | DET(segment) | GUARD (owner > agent draft, rejection cooldown) + LWW-F; rejected SOFT |
| watchlist_items | `watchlist.added`, `watchlist.updated`, `watchlist.removed` | DET(instrument) | CREATE; note/tags LWW-F; removed SOFT |
| alerts | `alert.created`, `alert.updated`, `alert.statusSet`, `alert.deleted`, `alert.restored`, `alert.evaluated` | ULID | CREATE; config LWW-F; deleted SOFT; runtime LEADER LWW-F; effective status DERIVED |
| inv_planned_deposits | `plannedDeposit.created`, `plannedDeposit.cancelled`, `plannedDeposit.booked` | ULID | CREATE; cancel / book FWW |
| inv_signals | `signal.opened`, `signal.refreshed`, `signal.escalated`, `signal.closed`, `signal.woken` (LEADER); `signal.snoozed`, `signal.closed` (owner-caused), `signal.reopened` (any device) | DET(dedupKeyV2, firstSeenOn, seq) | lifecycle state machine in fold order (8.7); snooze LWW; acknowledged DERIVED from decisions (6.5) |
| inv_rule_runs | `ruleRun.finished` | ULID | APPEND, LEADER (D5: view keeps the last N) |
| inv_decisions + inv_decision_signals | `decision.recorded`, `decision.undone` | ULID | APPEND; links embedded; undo TOMB |
| reviews | `review.done`, `review.undone` | ULID | APPEND; undo TOMB |
| proposals | `proposal.created`, `proposal.approved`, `proposal.rejected`, `proposal.failed` | ULID | CREATE; terminal FWW; side effects caused (6.6) |
| research_runs | `researchRun.started`, `researchRun.finished` | ULID | APPEND; finish LWW-F |
| research_notes | `note.added`, `note.read`, `note.dismissed`, `note.restored` | ULID | APPEND; read / dismissed LWW-F |
| connector_bindings | `connectorBinding.set`, `connectorBinding.removed` | DET(account, connector_id) | LWW-F; removed TOMB; cursor / backoff / last_* leader-local, never synced (D7) |

### 8.2 Core

- `profile.created` (gid = vault) `{slug, name, baseCurrency, mcpPrivacy: strict|amounts, createdAt?}`.
  The first event of every vault. `slug` is the device-local folder / URL key; see O9.
- `profile.renamed` `{name}`. `profile.settingsChanged` `{baseCurrency?, mcpPrivacy?}` (LWW-F; O8).
- `module.enabled` / `module.disabled` `{moduleId}`. `enabled` is one LWW register; `enabled_at` =
  `at` of the winning `module.enabled`. Disabling keeps the data (as today).
- `account.opened` `{bank, externalId|null, iban|null, currency, type, name, active?}`. CREATE:
  identity fields (`bank`, `externalId`, `currency`, `iban`) come from the first open and never change;
  `name` and `type` are initial values of LWW registers. A second `account.opened` for the same gid
  (two devices importing the same account) is a no-op, which is how the materializer guard "an Open
  Banking import never overwrites the type or the owner's name" holds: OB code emits `opened`, never
  `renamed`.
- `account.renamed` `{name}`, `account.typeSet` `{type}`, `account.removed` `{}`, `account.restored`
  `{}` (SOFT on `removed_at`). Key parking (`<key>~<id>`, `core/accounts.py:park_removed_key`) is
  DERIVED in the view, never an event ([`gid.md`](gid.md) 4.3).
- `balance.recorded` `{account@, date, source: open_banking|csv|manual|connector, amount, currency}`.
  Same key recorded again = LWW on `amount`/`currency` (a corrected statement). Loans
  `record_balance` and the assets revaluation emit this type.
- `budgetSettings.cushionSet` `{enabled, currency|null, targetAmount|null, targetMonths|null,
  accounts: @account[], monthlyMax|null}`. Replaces `profiles/<slug>/budget.json`, which becomes a
  projection (or is dropped once readers use the view). `account_ids` are rewritten to gids.

### 8.3 Budget

- `txn.imported` (gid DET, [`gid.md`](gid.md) 4.4) `{account@, batch@|null, bookingDate, valueDate|null,
  amount, currency, counterpartyName|null, counterpartyIban|null, description|null, reference|null,
  bankTransactionId|null, source, dedupHash (v2), occurrence, raw}`. CREATE. One event per row.
  Union by gid reproduces Python's multiset rule for the content path: two devices importing
  overlapping CSVs converge to max(multiplicity) per content key, exactly like sequential imports.
  The newest-day rule (Open Banking, connectors, cashu-format documents) depends on what the view
  holds at import time, so those imports are LEADER (Open Banking and connectors already are, rule 6);
  cashu-format uploads are O3.
- `txn.cashExpenseAdded` (gid ULID) `{account@ (a cash account), bookingDate, amount (negative), currency,
  title, category}`. View: `source = manual`, `category_source = manual_txn`, `dedup_hash =
  "cashexp:" + gid`, `raw = {"cash_expense": true}`.
- `txn.categorySet` `{category, source: manual_txn|llm_full|llm_fallback}`: a **per-transaction
  claim** (D8). `manual_txn` = the owner's choice (`set_transaction_category`), `llm_full` = the full
  LLM reclassification result per transaction, `llm_fallback` = legacy value, genesis only. LWW
  register of the claim with GUARD: an `llm_*` claim is a no-op while the folded claim is
  `manual_txn` (a deterministic re-run never clobbers a manual choice).
- `txn.categoryCleared` `{}`: removes the claim (Python `recategorize_one` after the transaction's cash
  mirror leg is deleted, `budget/cash.py:delete_cash_transaction`); the effective category falls back
  to the engine.
- `txn.deleted` `{}`: TOMB, valid only for cash-account entries (`delete_cash_transaction`). Deleting
  a withdrawal **mirror leg** is not a delete: legs are DERIVED (section 9), so it emits
  `txn.categoryCleared` on the source bank transaction, which removes the leg.
- Effective `category` / `category_source` (DERIVED, after apply, S08/S09): `manual_txn` claim >
  structural transfer / locked merchant rule / loan pattern (`engine.owner_decision`) > `llm_full`
  claim > engine (`keyword`, `subscription`, cached `llm` / `manual` merchant rule, `default`). This
  is today's precedence in `budget/service.py` and `engine.py`.
- `categoryRule.set` (gid DET(merchant_key)) `{merchantKey, category, source: manual|llm, locked}`.
  GUARD: a `source: llm` set is a no-op while the folded rule is `locked` (`rules.upsert_rule`).
  No remove type in v1 (no Python writer removes rules).
- `importBatch.recorded` `{source, bank|null, account@|null, filename|null, startedAt, finishedAt|null,
  numSeen, numInserted, numDuplicates, notes|null, archive?: {sha256, ext}}`. `archive` points to the
  encrypted content-addressed blob of the imported file (D9).

### 8.4 Loans and assets

- `loan.termsSet` (gid DET(account)) `{account@, principal, annualRate, termMonths, startDate,
  originationDate|null}`. View `updated_at` = `at` of the latest `termsSet` (the balance-precedence
  rule in `loans/valuation.py` compares balances against it).
- `loan.paymentMatchingSet` `{paymentIban|null, paymentText|null}`.
- `depreciation.set` `{account@, purchasePrice, purchaseDate, annualRate, floor|null}`.
- `assetDetails.noteSet` `{account@, note|null}` (`note` <= 500 chars, `NOTE_MAX`).

### 8.5 Investments: accounts, imports, transactions

- `invAccount.settingsSet` `{account@, wrapper?, importer?|null, mappingYaml?|null}`.
- `invImport.recorded` `{account@, importer, broker, fileName, fileSha256, archive?: {sha256, ext},
  txnCount, duplicateCount, positionCount, renameCount, statusChangeCount, instrumentCount,
  correctionCount, warnings[]}`. `archive_path` (a device path) is replaced by the blob ref.
- `invTxn.imported` (gid DET(account, dedupHashV2)) `{account@, batch@|null, type, tradeDate,
  settleDate|null, instrument@|null, quantity|null, price|null, currency, grossAmount, fee, tax,
  cashAmount, cashCurrency, fxRate|null, splitRatio|null, note|null, source: import|manual|reconciliation,
  externalRef|null, dedupHash (v2), createdAt}`. `createdAt` is REQUIRED: it is the chronological rank
  of same-day rows (`domain.chronological_key`), not just a timestamp. No edit or delete type: Python
  has none (`service/transactions.py` only adds).
- `position.snapshotImported` `{account@, instrument@, asOf, quantity, currency, avgPrice|null,
  marketValue|null, batch@|null}`.
- `instrumentRename.recorded` `{date, old@instrument, new@instrument, note|null, batch@|null}`.
- `valuation.set` `{instrument@, asOf, unitValue, currency, note|null}`.

### 8.6 Instruments (per vault, D3)

- `instrument.created` `{name, currency, assetClass, symbol|null, isin|null, mic|null, region|null,
  sector|null, tags[], needsClassification, valuationMode, status, creationAlias|null}`.
  `creationAlias` = the `namespace:value` the gid was derived from ([`gid.md`](gid.md) 4.6), null for a
  ULID instrument.
- `instrument.updated` `{...patch of the shared fields}` (LWW-F): metadata refresh, classification,
  symbol / ISIN filled in.
- `instrument.aliasAdded` (gid DET(namespace, value)) `{instrument@, namespace, value, guessed}`. The
  first claim (lowest `hlc`) owns the alias. A later claim by another instrument is a no-op that
  records a collision in the view; the lease holder then emits `instrument.merged` with the
  lexicographically smaller gid as target and `reason: alias_collision` (two devices that both emit
  it produce the same pair: idempotent).
- `instrument.merged` (gid = source) `{source@, target@, reason: owner|alias_collision}`. Applied
  through union-find (6.4). Per-table collisions follow `store/instrument_merge.py` deterministically,
  the target always winning: watchlist (target entry stays; empty note takes the source's; tags
  joined; watched again when only the source's was live), profile overrides (target identity stays;
  plan group, tags, region, sector move only when the target has none; an owner segment beats an
  agent segment), position snapshots / manual valuations (target row for the same key stays),
  renames (X to X dropped, duplicates dropped), signals (dedup keys rewritten to the target gid; an
  open source signal whose new key is already open for the target is resolved). This replaces the
  raw SQL of `instrument_merge.py` (refactor 3).
- `instrumentOverride.set` (gid DET(instrument)) `{instrument@, name?, assetClass?, tags?, region?,
  sector?, valuationMode?, status?, needsClassification?}`. `null` = back to the shared default; `""`
  clears a text attribute for this profile (as today).
- `instrumentOverride.planSet` `{instrument@, plan|null, reason|null}`. `plan_at` = `at`; the plan
  group (`plan`, `plan_at`, `plan_reason`) is one register (set and cleared together).
- `instrumentOverride.segmentSet` `{instrument@, segment|null, by: owner|agent}`. GUARD: `by: agent`
  is a no-op while the folded segment is non-null and set by the owner (`store/instruments.py:388`).
  `segment_by` becomes null when `segment` is null.

### 8.7 Signals, rule runs, alerts

Signal lifecycle is a state machine folded in `hlc` order; a transition not allowed from the
current state is a no-op:

```
(absent) --opened--> active
active|acknowledged --refreshed/escalated--> same (escalated{reactivate} -> active)
active|acknowledged --closed{resolved|expired}--> resolved|expired
expired --reopened{alert_restored}--> previous open state (alert restore within the window)
acknowledged: DERIVED overlay from decisions (6.5), cleared by escalated{reactivate} and woken
```

- `signal.opened` (LEADER, gid DET) `{ruleId, kind, dedupKey (v2), severity, polarity, message,
  instrument@|null, account@|null, payload, run@|null, firstSeenOn}`.
- `signal.refreshed` (LEADER) `{severity?, message?, payload?, run@|null, seenAt}`.
- `signal.escalated` (LEADER) `{severity, message, payload, reactivate, run@|null, seenAt}`.
- `signal.closed` `{status: resolved|expired, reason}`. LEADER for rule outcomes; any device for
  owner-caused closes with `reason` in `snooze|mute|delete|alert_expired` (Python writes it as
  `payload.closed_by`).
- `signal.reopened` `{reason: alert_restored}` (any device, same batch as `alert.restored`).
- `signal.snoozed` `{until|null}` (any device, LWW). `signal.woken` (LEADER) `{}`: snooze passed,
  ack cleared (`store/signals.py:wake_snoozed`).
- `ruleRun.finished` (LEADER) `{trigger, asOf, status, strategyVersion@|null, stats, errors[],
  report: {new: @signal[], escalated: @signal[]}, startedAt, finishedAt|null}`.
- `alert.created` `{instrument@|null, scope, kind, params, polarity, severity, title, note|null, source:
  user|agent, createdBy: app|cli|mcp, cooldownDays|null, expiresAt|null}`.
- `alert.updated` `{title?, note?, params?, polarity?, severity?, cooldownDays?, expiresAt?}` (kind
  and instrument never change, as today).
- `alert.statusSet` `{status: active|muted|snoozed, snoozedUntil|null}`: the **owner state**.
- `alert.deleted` `{}` / `alert.restored` `{}`: SOFT on `deleted_at` (restore window at emit time).
- `alert.evaluated` (LEADER) `{triggered, lastCheckedAt?, lastValue?, lastTriggeredAt?}`: the
  **runtime state**.
- Effective `alerts.status` (DERIVED at read, evaluated with the reader's clock): `muted` if owner
  state muted; else `expired` if `expiresAt <= now`; else `snoozed` if owner state snoozed and
  `snoozedUntil > now`; else `triggered` if runtime triggered; else `active`. This splits today's
  mixed column (`service/alerts.py:594-598`, `housekeeping`) into owner and runtime registers.
- Signals of an alert use `rule_id = dedup_key = "alert:<alert gid>"` ([`gid.md`](gid.md) section 6).

### 8.8 Journal, theses, strategy, planned deposits

- `decision.recorded` (APPEND) `{signals: @signal[], instrument@|null, account@|null, action,
  quantity|null, price|null, currency|null, reason|null}`. `inv_decisions.signal_id` (first link)
  is DERIVED = `signals[0]`; `inv_decision_signals` rows come from `signals`.
- `decision.undone` `{}` (TOMB; cross-entity revert of acks, 6.5).
- `thesis.created` `{instrument@, entryType, thesis, invalidation|null, exitPlan|null, sizePlan|null}`;
  `thesis.updated` `{entryType?, thesis?, invalidation?, exitPlan?, sizePlan?, reviewed?: true}`;
  `thesis.deleted` `{}`. DERIVED: `core_changed_at` = `at` of the latest event that changed
  (by value, in fold order) `entryType`, `thesis` or `invalidation`; `exit_plan_changed_at` = `at` of
  the latest change of `exitPlan`, null when the plan is null; `reviewed_at` = `at` of the latest
  `reviewed: true`.
- `strategy.versionSaved` (gid ULID) `{yamlText, mdText|null, sha256, state: valid|partial|invalid,
  issues[]}`. The current version = highest `hlc`; `version` numbers are DERIVED (1, 2, ... in `hlc`
  order). `strategy.yaml` / `strategy.md` are a projection written from the current version (D15).
  A desktop that detects an external edit of the projection files emits a new version (O5).
- `plannedDeposit.created` `{account@|null, amount, currency, plannedDate, note|null}`;
  `plannedDeposit.cancelled` `{}`; `plannedDeposit.booked` `{txn@invTxn}`. Booked and cancelled are
  terminal FWW.

### 8.9 Topic theses, research

- `topicThesis.ownerSaved` (gid DET(segment)) `{segment, thesis, invalidation|null}`: clears `draft`
  and `rejected_at`, `created_by` stays the creator, `core_changed_at` = `at` when text changed.
- `topicThesis.draftProposed` `{segment, thesis, invalidation|null}`. GUARD (`topic_theses.upsert_draft`):
  no-op if an owner thesis exists (non-draft, not rejected) or the topic was rejected less than
  `TOPIC_DRAFT_COOLDOWN_DAYS` before this event's `at`.
- `topicThesis.rejected` `{}`: SOFT `rejected_at` (the row stays as a rejection).
- `topicThesis.marketViewSet` `{segment, assessment|null, outlook|null, sources|null, by: owner|agent}`;
  `view_updated_at` = `at`.
- `researchRun.started` `{scope, createdBy}` (`scope.instrument_ids`, `scope.covered_instrument_ids`
  rewritten to gids); `researchRun.finished` `{status: done|failed, counts}`.
- `note.added` `{run@|null, instrument@|null, theme|null, segment|null, kind, polarity, strength,
  thesisRelation, thesisField|null, title, summary, sources[], details|null, candidateKey|null,
  signal@|null, observedAt, expiresAt, createdBy}`. Owner-written notes are born read (`readAt` = `at`).
- `note.read` `{}`, `note.dismissed` `{cooldownUntil|null}`, `note.restored` `{}` (LWW-F on `read_at`,
  `dismissed_at`, `cooldown_until`). Accepting a candidate emits `watchlist.added` / `thesis.created`
  with `cause` = the accepting event and writes the ids into `details` as gids.

### 8.10 Agent layer, connectors

- `review.done` `{module, doneAt?, notes|null, stats}`; `review.undone` `{}` (TOMB).
- `proposal.created` `{kind: strategy|custom_rule|import|budget_import, summary, reason|null, payload,
  source}`. `payload` uses gids and blob refs: `account_id` -> `account@`, `staged` (a device path)
  -> `blob: {sha256, ext}` ([`gid.md`](gid.md) section 6).
- `proposal.approved` `{result}` / `proposal.rejected` `{note|null}` / `proposal.failed` `{result}`:
  terminal FWW. The approving device emits the side-effect events (`strategy.versionSaved`,
  `invImport.recorded` + `invTxn.imported` ..., `txn.imported` ...) in the same batch with `cause` =
  the `proposal.approved` eid. `applying` is a device-local lock state and never synced. Approval is
  desktop only for now (D14).
- `connectorBinding.set` (gid DET(account, connector_id)) `{account@, connectorId, params, autoCommit}`;
  `connectorBinding.removed` `{}` (TOMB). `params` holds no secrets (secrets stay in the device
  keychain, keyed per device).

### 8.11 Reserved

Type prefixes `device.*`, `lease.*` (S29: device registry, fetch lease) and `snapshot.*` (S32
projection channel) are reserved and defined by those scopes against this envelope.

## 9. Derived columns (never in a payload, never captured by the outbox)

| Column | Recomputed from |
|---|---|
| `transactions.is_internal_transfer`, `transfer_group_id` | the whole account set, `ingestion/transfers.py` (counterparty IBAN only, rule 5) |
| `transactions.category`, `category_source` | claims + rules + engine (8.3); rule-engine categories recomputed on every device (D8) |
| cash pool mirror legs (`dedup_hash = cashleg:<id>`, `raw.cash_leg_of`) and the cash account they need | bank transactions whose effective category is `cash_withdrawal` (`budget/cash.py:sync_cash_leg`) |
| `alerts.status` (effective), `last_*` come from `alert.evaluated` | 8.7 |
| `inv_signals.status = acknowledged`, `acknowledged_at` | decisions (6.5) |
| `inv_theses.core_changed_at`, `exit_plan_changed_at`, `reviewed_at` | 8.8 |
| `inv_topic_theses.core_changed_at`, `view_updated_at` | 8.9 |
| `inv_strategy_versions.version`, "current" | `hlc` order (8.8) |
| `inv_decisions.signal_id` | first of `signals` |
| `loans.updated_at`, `profile_modules.enabled_at`, `plan_at` | `at` of the setting event |
| `research_notes.signal_id` when the note joined a signal | carried in `note.added` (`signal@`) because the join is a leader-time fact; not recomputed |

## 10. What never syncs

| Data | Why |
|---|---|
| `inv_price_bars`, `inv_fx_rates`, `inv_macro_bars`, `market/calendar.json` | refetchable caches (D4: the phone gets leader projections) |
| `change_events` | replaced by store subscriptions |
| `mcp_calls` | per-device audit (D6) |
| `inv_notification_log` | each device notifies itself; dedup by (signal gid, severity) |
| `connectors`, `connector_runs` | code + approval is a security act on that machine (D7) |
| `connector_bindings.cursor`, `last_run_at`, `last_status`, `last_ok_at`, `backoff_until` | leader-local fetch state (D7) |
| `proposals.status = applying` | device-local approval lock |
| `alembic_version`, `settings.json`, `desktop.json`, `profiles/<slug>/workspace.json` | per device (absolute paths, window state); app language pin may sync later |
| Enable Banking keys / sessions, connector secrets, the API token, run locks | device keychain / per device |
| local integer ids | view-internal only |

## 11. Notes for genesis (S26) and the outbox (S30)

- Genesis emits, per vault, one create / snapshot event per row in dependency order, with
  `origin: "genesis"` and every timestamp column explicit (4.4). Soft-deleted rows are emitted with
  their deletion state (`account.removed`, `alert.deleted`, `watchlist.removed`, `topicThesis.rejected`)
  so the view round-trips; derived columns are not emitted (section 9).
- Genesis gids follow [`gid.md`](gid.md) section 7 (deterministic, re-runnable).
- The outbox captures field diffs of synced columns only (section 9 excluded) and maps them to the
  types above; the explicit-emit sites are `instrument_merge.py` (-> `instrument.merged`), decision
  undo, review undo, thesis delete, cash expense delete, binding removal, and every bulk
  `update()/delete()` on a synced table (risk R6).
- Python-side derived writes (rule-engine categories, cash legs, transfer groups, alert expiry /
  wake, version numbers) MUST NOT be shipped as events.
- The Python side SHOULD validate outbound events against JSON Schema generated from the zod
  schemas (`z.toJSONSchema`), so both runtimes share one definition.

## 12. Open items (not decided here)

- **O1 Instrument merge vs dedup keys.** `invTxn` gids are fixed at import with the instrument gid of
  that moment. A re-import after a merge computes `dedupHashV2` with the target gid, so the same
  broker row gets a new gid. Proposal: the import command dedups by `dedupHashV2` recomputed with
  merge-resolved instrument gids against the view (as Python's UNIQUE check does today) before
  emitting; concurrent pre/post-merge imports on two devices can still duplicate. Python has the same
  gap today (`instrument_merge.py` never rewrites `inv_transactions.dedup_hash`). Needs a decision on
  whether to also emit `invTxn.superseded` or accept the rare duplicate.
- **O2 Genesis rows whose stored hash cannot be reproduced** (merged instruments, legacy namespace,
  normalization drift) get a `legacy:` gid input ([`gid.md`](gid.md) 7). A later TS re-import of the
  same file will not match them by gid, only by the view-level dedup check. Acceptable?
- **O3 cashu-format budget documents uploaded manually** use the newest-day rule, which is
  order-dependent. Restrict them to the lease holder, or accept possible duplicates when two devices
  import overlapping documents concurrently?
- **O4 `budget_import` proposals** (connector fetches) save the binding cursor on approval, but the
  cursor is leader-local (D7). Proposal: only the lease holder may approve them; confirm.
- **O5 Strategy projection files edited outside the app** (an editor, the agent despite D15):
  last-writer by detection time decides. Two desktops detecting different external edits produce two
  versions; the higher `hlc` becomes current and the other is history. Confirm that is acceptable,
  and whether the projection writer should refuse to overwrite an unsaved external edit.
- **O6 `inv_rule_runs` retention** (D5 "last N"): the log keeps every `ruleRun.finished` forever
  (append-only). Should old run reports be omitted from the log altogether (keep only the run summary
  without `report`) to bound growth?
- **O7 Future-dated device clocks.** A device whose clock runs hours ahead wins LWW races until real
  time catches up (the spike documented this). Options: refuse to emit while `pt` is behind the HLC
  wall by more than X, or cap remote wall advancement. Needs a policy.
- **O8 `mcp_privacy` syncs** (LWW). A phone could loosen what the desktop MCP server may send. Should
  loosening (strict -> amounts) be desktop-only or require confirmation on each desktop?
- **O9 Slug collisions across vaults** on one device (two vaults both named `profile-a`): `slug` is a
  device-local folder key today. Proposal: keep `slug` in the vault but let a device map a colliding
  slug to a local alias; decide in S29 pairing.
- **O10 `plannedDeposit.booked` from two devices** could book two different transactions to one plan
  (FWW keeps the first) or one transaction to two plans (both apply). Python prevents the latter in
  one transaction. Add a GUARD (a transaction books at most one plan, lowest `hlc` wins)?
- **O11 Research note payload size**: `note.added` carries full Polish summaries and sources; 211
  notes on lab are small, but a research-heavy profile grows the log permanently. Accept, or move
  note bodies to blobs?
- **O12 `txn.imported.raw`** carries the bank's raw row (all CSV columns / OB fields) into the
  encrypted log on every device. Needed for re-parsing; confirm it should sync (it contains the same
  personal data as the other columns, under the vault key).
