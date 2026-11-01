# Global ids (gid) v1.2 (normative)

Status: v1.2 (scope S04, 2026-10-31), after the review and its v1.1 re-check
(`~/cashu-lab/checkpoints/S04-review.md`) and the lead's decisions (M8 keyed gids, N1-N5). Companion of [`events.md`](events.md). Constants and
the message layout: `packages/store/src/events/v1/namespaces.ts`. The HMAC call lives in S23
(`packages/store/src/gid.ts`, runtime crypto); the vectors in section 8 are its acceptance test and
were produced with Python's `hmac` / `hashlib`, so Python (S26 checks, S30 outbox) and TS agree by
construction. Canonical text uses the S05 primitives in `packages/domain/src` (`@cashu/domain`):
`decimalKey`, `format2`, `floatRepr` (`decimal.ts`), `normalizeText` (`text.ts`), `ibanKey`,
`normalizeIban` (`iban.ts`).

## 1. Why

Today 43 tables use autoincrement integer keys, local to one SQLite file. In the log every entity has
a **gid**; integer ids survive only inside a device's view.

- **DET**: a deterministic, keyed id for facts two devices can observe independently (an imported row,
  an account seen in two statements, a 1:1 settings row, a merchant rule). Both compute the same gid
  without coordination; the log dedups the fact (CREATE, events.md 6.2). Where one fact can still get
  two gids (a CSV account without IBAN vs the same account by IBAN; an instrument created under two
  aliases), identity resolution joins them in the fold (events.md 6.4).
- **ULID**: minted at creation, for things that exist because someone created them (a decision, a
  thesis, an alert, a note, a signal).

## 2. Formats

| Kind | Format | Regex |
|---|---|---|
| ULID | 26 chars Crockford base32, upper case, first char `0`-`7` | `^[0-7][0-9A-HJKMNP-TV-Z]{25}$` |
| keyed DET | RFC 9562 UUID **version 8**, lower case, hyphenated, variant `8`-`b` | `^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| vault id | 16 random bytes, 32 lower-case hex (`createVaultId`, S27) | `^[0-9a-f]{32}$` |

Length tells them apart (26 vs 32 vs 36). The vault gid (= profile gid) is the vault id: the gid of
the `profile.*` events (strategy VAULT) and nothing else; payload references are ULIDs or UUIDv8s.
Device ids (S27 `DeviceIdentity`, minted at pairing, S29) have the same form, 32 lower-case hex, never
all zero (the all-zero id is the recovery signer's). View tables keep their
integer `id` plus `gid TEXT NOT NULL UNIQUE`. v1's unkeyed UUIDv5 gids are invalid in v1.1 (the schema
rejects them); nothing was ever written with them.

## 3. Keyed DET construction (M8)

```
gid = uuid8( HMAC-SHA256( key = vaultSalt, msg = UTF-8( "cashu.gid.v1/" + table + US + part1 + US + ... ) ) )
US  = U+001F (unit separator)
uuid8(d): b = d[0..16); b[6] = (b[6] & 0x0f) | 0x80; b[8] = (b[8] & 0x3f) | 0x80; lower-case hex 8-4-4-4-12
```

- **vaultSalt**: 32 bytes from a CSPRNG, generated when the vault is created (genesis included),
  stored in the device keyring next to the vault data key, and handed to a new device only wrapped,
  together with the data key, at pairing (S27 / S29). It is never derived from the slug, the vault
  gid or any other value that can be public, and it does not change when the data key rotates (gids
  are frozen once written). Losing it with all devices loses the vault anyway (recovery key, S27,
  covers both).
- **Both runtimes compute gids**: the TS store and the Python outbox (S30, during the strangler) MUST
  read the same salt, from the device keyring entry next to the vault data key (Python through
  `keyring`, Electron through `safeStorage` / keychain). It is never written to a file in the data dir,
  never logged, never sent to the MCP agent.
- Without the salt a gid confirms nothing: "is this IBAN theirs" or "did they pay merchant X 12.50 on
  D" cannot be tested against a leaked gid. Inside the carrier, gids are encrypted anyway
  (events.md 1); the salt protects gids that leave the ciphertext (logs, bug reports, a future
  plaintext index).
- Each vault has its own salt, so the same fact in two profiles gets unrelated gids (D3), and the
  vault gid is not part of the message.
- `table` is a domain name from `GID_TABLES` (section 3.2). A part MUST NOT contain U+001F (the writer
  fails loudly).

### 3.1 Canonical text of parts

| Value | Canonical text |
|---|---|
| string | exact UTF-8 as stored (no normalization, no trim, no case change unless the row says so) |
| gid | as in section 2 (ULID upper case, UUID lower case); a reference is first resolved where the table says so |
| integer | base 10, no sign for >= 0, no leading zeros |
| calendar date | `YYYY-MM-DD` |
| decimal (value key) | `decimalKey` (Python `importing/dedup.py:decimal_key`): plain, exact, trailing fractional zeros and `.` removed, `-0` -> `0`, `1E+1` -> `10`; null -> `""` |
| decimal (2 places) | `format2` (Python `format(d, ".2f")`): ROUND_HALF_EVEN, sign kept for a zero result (`-0.001` -> `-0.00`); only in the budget content key |
| merchant / memo / counterparty text | `normalizeText` (upper case, diacritics stripped, `ł` -> `L`, whitespace collapsed with Python's `\s` set, which includes `\x1c`-`\x1f` and `\x85`, unlike JS `\s`) |
| IBAN | `ibanKey` (`normalizeIban`, then a leading 2-letter country code dropped, so CSV NRB and Open Banking IBAN agree) |
| null | `""`, only for the parts listed as nullable |

S05's vectors cover all of these (75k vectors); gids MUST be computed only through those functions.

### 3.2 Domains

`profile_modules`, `accounts`, `balances`, `transactions`, `category_rules`, `loans`, `depreciations`,
`asset_details`, `budget_settings`, `inv_account_settings`, `inv_transactions`, `inv_position_snapshots`,
`inv_instrument_renames`, `inv_manual_valuations`, `inv_instruments`, `inv_instrument_aliases`,
`inv_profile_instruments`, `inv_topic_theses`, `watchlist_items`, `connector_bindings`, `genesis`
(section 7). Never rename or reuse a domain; adding one = a new entry here and in `GID_TABLES`.
(`inv_signals` left the list in v1.1: signals are ULIDs, section 5.)

## 4. Strategy per table

Parts are listed in order. `@x` = gid of x; `R(@x)` = its resolved root (events.md 6.4).

**Payload-derived gids are checked (invalid-gid).** For every event type whose gid is DET over parts
its own payload carries, the reader recomputes `DET(table)[parts]` from the payload (references as
written, never resolved) and parks an event whose gid differs ([`events.md`](events.md) 7.10). The
per-type parts are one table in code, `detPartsOf` in `packages/store/src/events/v1/det-parts.ts`,
normative like the zod schemas; a type whose payload does not carry its parts (a subject-addressed
`watchlist.removed`, `txn.categorySet`, ...) or whose gid may be a ULID (`DET-or-ULID`, and a
manual `invTxn.imported`, 4.6) is not checked. A writer therefore computes such gids only through
the same parts, and genesis (section 7) and the Python outbox (S30) MUST produce exactly them.

### 4.1 Vault / profiles

The vault id (32 lower-case hex, S27 `createVaultId`) minted when the profile is created; it is also
the carrier's routing id and the keyring's vault id. Genesis mints it once per profile and stores it
with the salt; a re-run reuses both.

### 4.2 profile_modules

DET `[moduleId]`.

### 4.3 accounts (B1: IBAN first, as in Python)

- **IBAN known** at open (from any source): DET `["iban", ibanKey(iban)]`. A CSV account and an Open
  Banking account of one IBAN compute the same gid.
- **Else an external natural key**: DET `["ext", bank, externalId]` for an Enable Banking uid, a
  statement's account key (`budget/imports.py`), a parser key of a CSV without IBAN, or the cash pool
  `cash:<CUR>` (`budget/cash.py`).
- **Else ULID**: name-derived keys `manual:<name>`, `vehicle:<name>`, random `brokerage:<uuid4>`, or no
  key at all. Name keys are not identity (a new position with a removed one's name must not revive its
  history, `core/accounts.py:park_removed_key`), and two devices creating `manual:<name>` concurrently
  get two accounts that both show (no UNIQUE on live `(bank, external_id)` in the view; lookups take
  the smallest gid, m12).
- **Identity keys** (claimed by `account.opened` / `account.identified`, events.md 6.4):
  `iban:<ibanKey>` and `ext:<bank>:<externalId>` for natural keys. When a CSV account without IBAN
  later learns its IBAN, or a re-consent brings a new uid, `account.identified` claims the key and the
  accounts resolve to one (the earlier holder survives). Writers look up the view by IBAN key, then by
  external key, before minting.
- **Checksum and one IBAN per account (N2)**: an `iban:` key is claimed only for a number that passes
  the mod-97 check (`isValidIban` in `packages/store/src/events/v1/identity.ts`; a bare 26-digit NRB is
  checked as `PL` + NRB), and an account component holds at most one `iban:` key (events.md 6.4).
  Writers SHOULD not even emit an invalid `iban:` key; the reducer ignores it anyway.
- The `iban:` key ignores the bank id, like Python's cross-bank matching (`budget/imports.py:386`,
  `by_any_bank`; lead decision on R-3).
- Parked keys (`<key>~<local id>`) are derived in the view as `<key>~<@account>`; genesis emits the
  un-parked key.

### 4.4 transactions (budget)

The stored `dedup_hash` is `sha1(str(account_id) + "|" + contentKey)` (`ingestion/normalize.py:82`):
id-coupled. v2 drops the account (it is a gid part, resolved by the row key):

```
contentKeyV2 = bookingDate "|" format2(amount) "|" upper(currency) "|" counterparty "|" normalizeText(memo)
  counterparty = ibanKey(counterpartyIban) or normalizeText(counterpartyName)
  memo         = " ".join(non-empty of [description, reference])
dedupHashV2  = lower-hex sha1(UTF-8(contentKeyV2))
gid          = DET(transactions) [@account, dedupHashV2, occurrence]
row key      = (R(@account), dedupHashV2, occurrence)          (events.md 6.4)
```

`occurrence` keeps Python's meaning (`ingestion/dedup.py`). The row key makes a CSV row and the same
Open Banking row one transaction once their accounts resolve together (Python's cross-source content
dedup), even though their gids differ.

- Manual cash expenses: ULID; view `dedup_hash = "cashexp:" + gid`.
- Cash mirror legs: DERIVED view rows, gid = DET(transactions) `["cashleg", @anchor]` where `@anchor`
  is the source row's view gid (4.8); view `dedup_hash = "cashleg:" + @anchor`, `raw = {"cash_leg_of":
  @anchor}`. A claim addressed to `DET(transactions)["cashleg", @member]` for **any** member of the
  source row applies to its leg (N1), so leg edits survive an anchor change after an account merge.

### 4.5 balances, 1:1 settings, rules

| Table | DET parts | Row key |
|---|---|---|
| balances | `[@account, date, source]` | `R(@account)`, date, source |
| category_rules | `[normalized merchantKey]` | same |
| loans, depreciations, asset_details, inv_account_settings | `[@account]` | `R(@account)` |
| budget_settings | `["cushion"]` | singleton |
| connector_bindings | `[@account, connectorId]` | `R(@account)`, connectorId |

`merchantKey` is what Python stores (`ingestion/normalize.py:merchant_key`, upper-case
`normalizeText` output).

### 4.6 Investments

| Table | Strategy | Row key |
|---|---|---|
| inv_instruments | DET `[creationAlias]` (`isin:<ISIN>` when created with an ISIN, else the `namespace:value` it was created under); ULID without any alias | `R(gid)` |
| inv_instrument_aliases | DET `[namespace, value]` | the alias |
| inv_profile_instruments, watchlist_items | DET `[@instrument]` | `R(@instrument)` |
| inv_manual_valuations | DET `[@instrument, asOf]` | `R(@instrument)`, asOf |
| inv_position_snapshots | DET `[@account, @instrument, asOf]` | `R(@account)`, `R(@instrument)`, asOf |
| inv_instrument_renames | DET `[date, @old, @new]` | date, `R(@old)`, `R(@new)` |
| inv_topic_theses | DET `[segment]` | segment |
| inv_transactions | DET `[@account, dedupHashV2]`; manual entries ULID (genesis: the row's genesis gid, 7) with `dedupHash = "manual:" + gid` (m1) | `R(@account)`, dedupHash |

**inv_transactions dedupHashV2 (O1).** Same algorithm as `importing/dedup.py`, with the account gid,
version tag `v2`, and the **broker's own instrument key** instead of the local instrument id, so the
hash does not change when instruments merge and does not depend on any device's gids:

```
ref path:        ["v2", "ref", @account, brokerId, ref, fillKey, occurrence]
content path:    ["v2", "content", @account, contentKey, occurrence]
reconciliation:  ["v2", "reconciliation", @account, instrumentKey, asOf, type, decimalKey(quantity)]
fillKey    = type US instrumentKey US decimalKey(quantity) US decimalKey(price) US (currency or "")
contentKey = tradeDate US type US instrumentKey US decimalKey(quantity) US decimalKey(price)
             US decimalKey(grossAmount) US decimalKey(cashAmount)
instrumentKey = ""                       for cash rows
              | "gid:" R(@instrument)    for reconciliation rows
              | else the key of the instrument the row RESOLVES to (below), never the row's own hints
brokerId   = the importer's broker id, legacy rename applied (CASHU_NAMESPACE -> LEGACY_NAMESPACE)
parts joined by US, dedupHashV2 = lower-hex sha256
```

**instrumentKey of a resolved instrument (S17d).** One rule for a TS re-import and genesis (7.2), in
`packages/domain/src/investments/importing/instrumentKey.ts` (`instrumentKeyV2`,
`reconciliationInstrumentKey`); nothing else re-implements it. Over the instrument as a commit leaves
it (a re-import: the resolved instrument with the import's new aliases appended; genesis: the stored
instrument, alias rows by ascending id) and the import's broker id (`null` without a batch):

1. the alias in the broker's namespace or an equivalent one (`cashu` and its legacy name are one),
   ranked legacy namespace first, confirmed before guessed, then oldest first ->
   `<canonical namespace>:<value>` (the legacy name never reaches the key);
2. else the `isin` alias (confirmed first, oldest first) -> `isin:<value>`;
3. else the instrument's `isin` column -> `isin:<isin>`;
4. else `gid:` R(@instrument).

A row without a broker starts at step 2. A key from the row's hints (symbol, else ISIN) is wrong: it
differs from the stored instrument's key for an ISIN-only row of a broker-aliased instrument, a batch
stored under the legacy broker name and an instrument with two aliases in one namespace, and the
re-import would insert the row again.

Occurrence counting per occurrence key within one file and the abs of parsed gross / quantity are as
in `importing/dedup.py`.

### 4.7 ULID tables

`import_batches`, `inv_import_batches`, `inv_strategy_versions` (a revert A -> B -> A must not collide),
`inv_theses`, `alerts`, `inv_planned_deposits`, `inv_rule_runs`, `inv_decisions`, `reviews`, `proposals`,
`research_runs`, `research_notes`, `inv_signals`, cash expenses, manual inv entries, accounts and
instruments per 4.3 / 4.6.

### 4.8 View row gids of row-keyed tables (N1)

A row that collapses several member gids (events.md 6.4) shows **one of its members** as its gid,
never a synthetic id:

- accounts and instruments: the identity root (a member by construction);
- every other row-keyed table: the **anchor**, the first applied keyed member (lowest `(hlc, eid)`
  among the events that put a member into the row: `txn.imported`, `watchlist.added`, `balance.recorded`,
  ...).

Writers address the gid the view shows or any member gid; each member maps to the row through its
own keyed events, so the edit lands whatever the delivery order. The anchor can move to an earlier
member when a merge brings one in; the old anchor stays a member and keeps working. (v1.1 proposed a
DET gid over the resolved row key here; no event would carry it, so edits addressed to it would park
forever. Withdrawn.)

## 5. Signals

Signals are ULIDs (v1.1, B2). Identity across devices comes from the episode rule (events.md 8.7)
on the **resolved dedup key**: Python's key with each embedded local id replaced by a gid (section 6),
and at fold time each `i:<@instrument>` / `a:<@account>` part replaced by its root. Two leaders, a
leader and a research desktop, or a new leader that missed the open signal all converge on one open
episode; v1's `firstSeenOn` / `seq` and their failure modes (G3) are gone.

## 6. Id-coupled strings (refactor 1, risk R5)

JSON key names stay (readers keep working); values become gids.

| Where | Today | v1.1 |
|---|---|---|
| signal dedup key, instrument / account scope | `<rule>\|i:<id>`, `<rule>\|a:<id>` (`rules/outcomes.py:80`) | `<rule>\|i:<@instrument>`, `<rule>\|a:<@account>` (resolved at fold time) |
| plan-check key | `plan:<check>\|i:<id>` | `plan:<check>\|i:<@instrument>` |
| research key | `research:<week>\|i:<id>` | `research:<week>\|i:<@instrument>`; `\|s:`, `\|t:` unchanged |
| alert signal rule id / key | `alert:<id>` | `alert:<@alert>` |
| bucket scope `\|s:<bucket>` | strategy string | unchanged |
| budget `dedup_hash` | sha1 with the account id | `dedupHashV2` (4.4) |
| inv `dedup_hash`, reconciliation hash | sha256 with account and instrument ids | `dedupHashV2` (4.6) |
| cash leg `dedup_hash`, `raw.cash_leg_of` | `cashleg:<id>`, int | derived, `cashleg:<@txn>` |
| cash expense `dedup_hash` | `cashexp:<uuid4>` | `cashexp:<gid>` |
| parked account key | `<key>~<id>` | derived, `<key>~<@account>` |
| `inv_signals.payload` | `instrument_id`, `alert_id`, `note_id`, `note_ids[]`, `accounts[]` | gids |
| `inv_rule_runs.report` | signal ids | signal gids |
| `research_notes.details` | `watchlist_item_id`, `thesis_id`, `previous_instrument_id` | gids |
| `research_runs.scope` | `instrument_ids[]`, `covered_instrument_ids[]` | gids |
| `proposals.payload` | `account_id`, `staged` path | `account`, `blob: {sha256, ext}` (schema rejects the old keys) |
| `budget.json` cushion | `account_ids[]` (floats for amounts) | `accounts: @account[]`, decimals (events.md 4.3) |
| `inv_import_batches.archive_path` | data-dir path | `archive: {sha256, ext}` (D9) |

Not affected (device-local): `connector_runs.batch_ref`, keychain secret names keyed by binding id,
`instrument_search` result keys, `inv_notification_log.signal_id`.

Guard (S26 / S30 acceptance): a test that greps Python key builders for f-strings embedding `*id`
and fails on any site not listed here; the zod schemas reject `i:<digits>`, `a:<digits>` and
`alert:<digits>` keys.

## 7. Genesis gids (S26)

Deterministic: two runs on one database with one stored salt give the same gids.

A database whose Python app already synced (rows in `sync_ids` or `sync_vaults`, or unacked
`sync_outbox` rows; schema 0028 / 0029) is refused (`sync_state_present`, exit 65, counts only):
those rows already carry gids that genesis gids would duplicate.

An alert's tag (`alerts.tag`, schema 0027 on; NULL before) travels in `alert.created.tag` (absent when
unset): genesis never drops a stored value.

- DET tables: normal DET inputs, local references mapped to the referenced row's gid.
- ULID tables: `DET(genesis) [table, str(local id)]` (a UUIDv8; valid as a gid). New rows get ULIDs.
- Accounts: 4.3 from the stored `iban` / `external_id`; `keys` emitted for both.
- Instruments: `creationAlias` = the `isin` alias if any, else the alias with the smallest local id;
  none -> the genesis rule. Every stored alias becomes an `instrument.aliasAdded`.
- Budget transactions (O2): **always** compute `dedupHashV2` from the stored columns (what a TS
  re-import of the same file produces) and report rows where `sha1(str(account_id) + "|" +
  contentKeyV2)` differs from the stored hash (counts only). `legacy:<stored hash>` is used only when
  a column needed by the key is missing.
- Investment transactions: rebuild `instrumentKey` from the stored instrument with the shared 4.6
  rule (7.2; the alias in a namespace equivalent to the batch's broker, else `isin:`, else `gid:`);
  recover `occurrence` by recomputing the v1 hash
  with the local ids for k = 0, 1, ... until it matches; if nothing matches (e.g. a merged instrument),
  take the rank of the row among rows of the same batch with the same occurrence key, ordered by
  `created_at` then id. `legacy:` only for missing columns. Lab: 262 rows, 2 reconciliation.
- Signals: genesis emits one `signal.opened` (ULID per the genesis rule) per row with its state; the
  episode fold groups them (lab has no duplicate open keys).
- Manual investment entries (S26-F1): gid = the genesis gid of the row, `dedupHash = "manual:" + gid`
  (the zod alternative accepts a ULID or a UUIDv8 there, `parseEvent` checks it names the event's own
  gid, and `detPartsOf` does not check it).

### 7.1 Genesis device, clock and eids (S26, D-G2 / D-G3)

- Device: a per-vault pseudo-device that never writes again: the first 16 bytes of
  `HMAC-SHA256(salt, UTF-8("cashu.genesis.device.v1"))` as 32 lower-case hex (all zero is refused).
  S29 must accept it as the author of the genesis segment.
- Base wall `W = 1 + max(ms)` over every "happened-at" timestamp of the vault's exported rows (stamps
  and payload timestamps except the future-dated `expires_at`, `snoozed_until`, `cooldown_until`);
  a run with `W > now + 5 min` fails (`clock_skew`). Event n of the vault (n = 0, 1, ...) has the HLC
  wall `W + floor(n / 1679616)`, counter `n mod 1679616`; `at` = W (milliseconds).
- `eid = ULID(time = W, random = first 10 bytes of HMAC-SHA256(salt, UTF-8("cashu.genesis.eid.v1" US
  type US gid US k)))`, k = the index of the event among the vault's events with the same (type, gid).

### 7.2 instrumentKey of a migrated investment transaction

The 4.6 rule (`importing/instrumentKey.ts` `instrumentKeyV2`, imported by genesis through
`@cashu/domain/investments/importing`) over the row's stored instrument (alias rows by ascending id)
with the batch's `broker` as stored (a legacy batch keys under the canonical namespace); none for a
cash row (`""`); a row without an exported batch starts at the `isin` steps; an instrument outside the
vault keys `gid:` with the 7.6 missing-instrument gid. The hash's `brokerId` part is the batch's
broker with the legacy rename applied. Reconciliation rows always use `gid:@instrument`.

### 7.3 Instruments per vault (D-G1)

The reference closure of the profile: every instrument a row of the profile references (columns,
signal keys and payloads, research details and scopes). Unreferenced instruments are not exported.
Genesis emits no `instrument.merged` (Python keeps no merge record).

### 7.4 Collisions (D-G4)

Two source rows of one vault that compute one DET gid stay two rows: accounts: live accounts
(`removed_at` null) claim first, then removed ones, each group by id; the first claimant keeps the DET
gid and the keys, a later one whose gid or any key is taken gets its genesis gid and claims no key
(counted `account_key_collision`). A removed account never takes the key, IBAN or DET gid a live one
(re)uses: Python parks a removed account's key so a new account can take it, and writers route by
key to the live account. The loser keeps its data; investment transactions
(ref / content path) and budget transactions: the later row takes the smallest free occurrence above
its own. A reconciliation collision fails the run.

### 7.5 Vault keys

The genesis core never mints keys: the caller passes, per profile, the vault id (32 hex) and the
salt. Production: the S27 keyring (`Keyring.gidSalt()`); lab / dev: a keys file outside the data dir
and the repo; parity: fixed keys derived from the slug (gids never reach parity output).

### 7.6 Dangling references (D-G13)

A reference whose target is missing, not exported or in another profile, per field:

| Reference | Rule |
|---|---|
| the account a row is scoped through (balances, transactions, loans, depreciations, asset_details, inv_account_settings, inv_transactions, inv_position_snapshots) | row skipped, counted `unscoped` |
| `balance.recorded.account`, `txn.imported.account`, `txn.cashExpenseAdded.account`, `loan.*.account`, `depreciation.set.account`, `assetDetails.noteSet.account`, `invAccount.settingsSet.account`, `invImport.recorded.account`, `invTxn.imported.account`, `position.snapshotImported.account`, `connectorBinding.set.account` | row skipped, counted `dangling_required_<table>` |
| `position.snapshotImported.instrument`, `instrumentRename.recorded.old` / `.new`, `valuation.set.instrument`, `instrumentOverride.*.instrument`, `watchlist.added.instrument`, `thesis.created.instrument` | row skipped, counted `dangling_required_<table>` |
| a cash leg's source transaction (leg claim) | claim skipped, counted `dangling_required_transactions` |
| `txn.imported.batch`, `importBatch.recorded.account`, `invTxn.imported.batch` / `.instrument`, `position.snapshotImported.batch`, `instrumentRename.recorded.batch`, `ruleRun.finished.strategyVersion`, `alert.created.instrument`, `signal.opened.instrument` / `.account` / `.run`, `signal.refreshed.run`, `decision.recorded.instrument` / `.account`, `plannedDeposit.created.account`, `note.added.run` / `.instrument` / `.signal` | `null`, counted `dangling_<table>.<column>` |
| `plannedDeposit.booked.txn` | no `booked` event, counted `dangling_inv_planned_deposits.booked_txn_id` |
| id lists: `decision.recorded.signals`, `ruleRun.finished.report.new` / `.escalated`, `budgetSettings.cushionSet.accounts`, `researchRun.started.scope` lists, `inv_signals.payload` `note_ids` / `accounts` | the id dropped, counted `dangling_<table>.<key>` |
| scalar ids inside JSON (`inv_signals.payload` `instrument_id` / `alert_id` / `note_id`, `research_notes.details` ids, `proposals.payload.account_id` -> `account`) | `null`, counted `dangling_<table>.<key>` |
| ids embedded in signal dedup keys and rule ids (`i:`, `a:`, `alert:`) | the genesis gid of the missing row (`DET(genesis)[table, id]`), counted `dangling_key_id` |

Nothing is dropped silently: every case is a named counter in the genesis report.

## 8. Test vectors

Fixed TEST salt = bytes `00 01 02 ... 1f` (real salts are random). Produced with Python
`hmac.new(salt, msg, hashlib.sha256)`; also asserted in `namespaces.test.ts`.

| Case | Domain and parts | gid |
|---|---|---|
| account by IBAN | `accounts`: `iban`, `00000000000000000000000000` | `70cc61c8-79b5-80ae-b8cc-fdca7caef49e` |
| account by external key | `accounts`: `ext`, `mbank`, `eb:TESTUID0001` | `a1bb665d-9bf1-81e3-916c-f49d32db099a` |
| module | `profile_modules`: `budget` | `fdb0a016-38e3-8d64-8dec-88673f5cdcda` |
| balance | `balances`: `<iban account>`, `2026-01-31`, `csv` | `e912848f-6071-8821-89fb-56c500920eb6` |
| budget txn | contentKeyV2 `2026-01-15\|-12.50\|PLN\|SKLEP TESTOWY\|ZAKUP TESTOWY` (normalizeText output is upper case) -> dedupHashV2 `451a4e645c5442bf030c14db4e9674a3592a8486`; `transactions`: `<iban account>`, hash, `0` | `0b7c2348-a233-87ef-9f1b-4b5bd5161ee0` |
| same, occurrence 1 | `transactions`: `<iban account>`, hash, `1` | `7a9a8c41-5f11-8b3c-94d7-114812fc0227` |
| cash leg of that txn | `transactions`: `cashleg`, `<txn gid>` | `95c48228-d6ec-8832-83ad-15ba530cfe8f` |
| category rule | `category_rules`: `SKLEP TESTOWY` | `cc9078fc-ae3d-8c1d-8381-55311fb4c8b2` |
| loan | `loans`: `<iban account>` | `b3120349-b79c-869e-819b-cd2c34f608d0` |
| cushion | `budget_settings`: `cushion` | `d3f2d51c-4a38-8fbf-be36-7abc2d765266` |
| connector binding | `connector_bindings`: `<ext account>`, `example-broker` | `6ad703ab-383d-8c73-82a5-1ee2d6742735` |
| instrument | `inv_instruments`: `isin:XX0000000001` | `fc9daa13-f073-8a72-8cd0-c1345436bc05` |
| alias | `inv_instrument_aliases`: `yahoo`, `TEST.WA` | `20157f67-f236-82f9-ab83-c6d176f65f27` |
| inv txn | content path, `2026-02-03`, `buy`, instrumentKey `testbroker:TST`, qty `10`, price `12.5`, gross `125`, cash `-125.5`, occurrence `0`, account = `<ext account>` -> dedupHashV2 `a75921e3e5f26dd7918d9b26f7237fbd4cb84d1ffd71686d37f64e6b2eba912e`; `inv_transactions`: `<ext account>`, hash | `f4948051-edd0-8710-babe-0f15b44cc19a` |
| watchlist item | `watchlist_items`: `<instrument>` | `d0a95ad2-2211-8a30-b04b-809c6be84b30` |
| topic thesis | `inv_topic_theses`: `gold` | `21465e71-86fc-8535-ab21-87bbe3ca85ba` |
| genesis ULID-table row | `genesis`: `inv_theses`, `7` | `c1e52d4d-d9a5-84e6-8d7a-c21b36691202` |

S05 owns the raw-fields -> key vectors (`normalizeText`, `ibanKey`, `format2` on real-looking
synthetic bank rows); these vectors start from canonical keys.

## 9. Open items

v1's G1 (resolved by IBAN-first identity and `account.identified`), G2 (accepted: duplicates with
disjoint aliases wait for an owner merge, which is now order-safe), G3 (removed with episodes) and
G4 (genesis rebuilds v2 from columns) are closed. Remaining:

- **G5 Salt distribution** is specified here only as "wrapped with the data key at pairing" and "read
  by both runtimes from the keyring"; the exact wrapping, the recovery-key derivation of the salt and
  its keyring entry (readable by the Python outbox S30 and the TS store) are S27 / S29's.
