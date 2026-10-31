# Global ids (gid) v1 (normative)

Status: v1 draft for lead review (scope S04, 2026-10-31). Companion of [`events.md`](events.md).
Constants: `packages/store/src/events/v1/namespaces.ts`. The UUIDv5 function itself lives in S23
(`packages/store/src/gid.ts`); the vectors in section 8 are its acceptance test and were produced
with Python's `uuid.uuid5`, so Python (S26 genesis checks, S30 outbox) and TS agree by construction.

## 1. Why

Today 43 tables use autoincrement integer keys. They are local to one SQLite file and collide across
devices. In the event log every entity has a **gid**; integer ids survive only inside a device's
materialized view. Two strategies:

- **DET**: a deterministic UUIDv5 over a canonical input, for facts that two devices can observe
  independently (an imported row, an account seen in two statements, a 1:1 settings row, a merchant
  rule, a signal). Both devices compute the same gid without coordination and the log dedups the fact
  (CREATE rule, `events.md` 6.2).
- **ULID**: minted at creation, for things that exist because someone created them (a decision, a
  thesis, an alert, a note). Two devices creating "the same" thing twice really created two things.

## 2. Formats

| Kind | Format | Regex |
|---|---|---|
| ULID | 26 chars Crockford base32, **upper case**, first char `0`-`7` | `^[0-7][0-9A-HJKMNP-TV-Z]{25}$` |
| UUIDv5 | RFC 9562, lower case, hyphenated, version nibble `5`, variant `8`-`b` | `^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |

A gid is either; length tells them apart (26 vs 36). The vault gid (= profile gid) is always a ULID.
View tables keep their integer `id` (so ported queries map 1:1) plus a `gid TEXT NOT NULL UNIQUE`.

## 3. DET construction

```
gid = uuidv5(NS[table], vaultGid + US + part1 + US + part2 + ...)        (UTF-8 bytes)
US  = U+001F (unit separator)
NS[table] = uuidv5(ROOT, "cashu.gid.v1/" + table)
ROOT = 6f1c2a4e-9b3d-4c57-8e21-5a0d7f3b9c64
```

- The vault gid is always the first part: the same fact in two profiles gets two gids (instruments
  are duplicated per vault, D3), and gids never leak across vaults.
- A part MUST NOT contain U+001F; a writer that meets one fails loudly (it never happens with real
  bank data; the Python dedup code uses the same separator).
- Parts are canonical text:

| Value | Canonical text |
|---|---|
| string | exact UTF-8 as stored (no Unicode normalization, no trim, no case change unless the row says so) |
| gid reference | the gid string as in section 2 (ULID upper case, UUID lower case) |
| integer | base 10, no sign for >= 0, no leading zeros (`0`, `1`, `12`) |
| calendar date | `YYYY-MM-DD` |
| decimal (value key) | `decimal_key` of `importing/dedup.py`: plain notation, exact (no context rounding), trailing fractional zeros and a trailing `.` removed, `-0` -> `0`, `1E+1` -> `10`; null -> empty string |
| decimal (2-place key) | Python `format(d, ".2f")`: quantized to 2 places with ROUND_HALF_EVEN, sign kept even for a zero result (`-0.001` -> `-0.00`); only inside the budget content key (4.4) |
| null | empty string, only for the parts listed as nullable below |

These rules are parity hazard R1: S05's vectors MUST cover `decimal_key` and `.2f` (half-even ties,
negative zero, 21 fractional digits, exponent inputs) before any DET gid is computed in TS.

### 3.1 Namespaces

| Table (namespace name) | NS UUID |
|---|---|
| profile_modules | `ae8339c1-283e-5550-84fa-274e723dd162` |
| accounts | `5e032984-5b89-5761-bbbc-f53689111b44` |
| balances | `1c4a87c8-065d-550a-95ae-3970b6c12576` |
| transactions | `2ac77d85-bd6b-5882-a51b-1da9990aa103` |
| category_rules | `c3f19568-8eaf-53dc-a19b-8688fa73633a` |
| loans | `c8f3125f-7d82-5112-9c82-9235f2176ee4` |
| depreciations | `bf2fa9d6-93a6-5b45-a307-5b0f1f6564c5` |
| asset_details | `5f94e262-12b0-591e-a93a-8979cbb1c782` |
| budget_settings | `e73dca20-09fc-5f75-ae5f-d6747e0500f9` |
| inv_account_settings | `2a3c7835-76ab-522f-b08f-9841695358e9` |
| inv_transactions | `712ba648-fe9e-5e86-817c-483ed84b1ad6` |
| inv_position_snapshots | `6ae75ae0-0a5a-56ed-b125-bda1aa32e768` |
| inv_instrument_renames | `e9c83675-d928-5a25-b47c-bab14bce9c31` |
| inv_manual_valuations | `a831c985-29d4-525e-83da-0c52879590cd` |
| inv_instruments | `5f9b3de7-fec7-51e5-bbb3-ab9433f84320` |
| inv_instrument_aliases | `5282adad-b002-593a-ba08-1d3a514b1d0b` |
| inv_profile_instruments | `5b2e0283-11b1-5551-a874-ad4806a1b5e1` |
| inv_topic_theses | `c7403439-dbbf-5dfe-9f55-b7d2f323bc0a` |
| watchlist_items | `d4505731-2d11-5325-a79a-a315935900bb` |
| inv_signals | `f24f120c-f299-59b7-959e-4a262e046665` |
| connector_bindings | `8b227d76-c7a5-5b99-bad8-d30c4d4337f8` |
| genesis | `91808c46-334e-558b-9528-dfb40bce3a13` (section 7 only) |

Adding a namespace = adding a row here and in `namespaces.ts` (the unit test recomputes every row
from ROOT). A namespace is never renamed or reused.

## 4. Strategy per table

`@x` = the gid of the referenced entity. Parts are listed after the implicit vault gid.

### 4.1 Vault / profiles

ULID minted when the profile is created (it is also the key id of the vault, S27). Genesis mints it
once per profile and stores it next to the vault key; a re-run of genesis reuses it.

### 4.2 profile_modules

DET `[moduleId]` (`budget`, `assets`, `loans`, `investments`).

### 4.3 accounts

- DET `[bank, externalId]` when `externalId` is an **external or implicit natural key**: an Enable
  Banking account uid, `csv:<IBAN>` (`core/accounts.py:78`), a statement's account key
  (`budget/imports.py`), or the cash pool `cash:<CUR>` (`budget/cash.py`). Two devices importing the
  same account or auto-creating the same cash pool converge to one account.
- ULID otherwise: `externalId` null (a CSV account without an IBAN), name-derived keys
  `manual:<name>`, `vehicle:<name>` (assets, loans) and `brokerage:<uuid4>`. Name-derived keys are
  not identity: a new position with a removed one's name must not revive its history
  (`core/accounts.py:park_removed_key`), which a DET gid would do.
- Parked keys (`<key>~<local id>`) are an artifact of Python's UNIQUE constraint. In the event model
  `account.opened.externalId` keeps the key as opened; the view derives parking (a removed account
  whose key a live account holds shows `<key>~<gid>`), and restore un-parks in the view. Genesis
  emits the un-parked key (strip `~<id>`), never the local id.

### 4.4 transactions (budget)

The stored `dedup_hash` is id-coupled: `base_hash` = `sha1(str(account_id) + "|" + contentKey)`
(`ingestion/normalize.py:82`). v2 removes the account from the hash (the account is a gid part):

```
contentKeyV2 = bookingDate "|" format(amount, ".2f") "|" upper(currency) "|" counterparty "|" normalize_text(memo)
  counterparty = iban_key(counterpartyIban) or normalize_text(counterpartyName)
  memo         = " ".join(non-empty of [description, reference])
dedupHashV2  = lower-hex sha1(UTF-8(contentKeyV2))
gid          = DET(transactions) [@account, dedupHashV2, occurrence]
```

`normalize_text` and `iban_key` are `core/text.py` (ported by S05 with vectors). `occurrence` keeps
Python's meaning (stored rows with the same hash on the account + surplus in this batch,
`ingestion/dedup.py`). `txn.imported.dedupHash` carries `dedupHashV2`; the view stores it in
`dedup_hash`.

- Manual cash expenses: ULID; view `dedup_hash = "cashexp:" + gid` (was `cashexp:<uuid4 hex>`).
- Cash pool mirror legs are DERIVED view rows, gid = DET(transactions) `["cashleg", @sourceTxn]`,
  view `dedup_hash = "cashleg:" + @sourceTxn` and `raw = {"cash_leg_of": @sourceTxn}` (was the local
  id). They never appear in the log.

### 4.5 balances, 1:1 settings, rules

| Table | DET parts |
|---|---|
| balances | `[@account, date, source]` (`source` = the enum value: `open_banking`, `csv`, `manual`, `connector`) |
| category_rules | `[merchantKey]` |
| loans | `[@account]` |
| depreciations | `[@account]` |
| asset_details | `[@account]` |
| inv_account_settings | `[@account]` |
| budget_settings | `["cushion"]` (singleton per vault) |
| connector_bindings | `[@account, connectorId]` |

### 4.6 Investments

| Table | Strategy |
|---|---|
| inv_instruments | DET `[creationAlias]` where `creationAlias` = `"isin:" + ISIN` when the instrument is created with an ISIN, else `namespace + ":" + value` of the alias it was created under (the importer's broker symbol alias, or the `yahoo` alias of a watchlist pick). ULID when created without any alias (a manual instrument; 7 of 64 on the lab profile). Concurrent creation of the same instrument on two devices (two imports, or the app and an agent picking the same listing: today's `_insert_once` race undo in `service/watchlist.py:249-251`) yields the same gid. |
| inv_instrument_aliases | DET `[namespace, value]` (unique per namespace per vault, as today's UNIQUE). |
| inv_profile_instruments | DET `[@instrument]` |
| watchlist_items | DET `[@instrument]` |
| inv_manual_valuations | DET `[@instrument, asOf]` |
| inv_position_snapshots | DET `[@account, @instrument, asOf]` |
| inv_instrument_renames | DET `[date, @oldInstrument, @newInstrument]` |
| inv_topic_theses | DET `[segment]` |
| inv_transactions | DET `[@account, dedupHashV2]`, below |
| inv_signals | DET `[dedupKeyV2, firstSeenOn, seq]`, section 5 |

**inv_transactions dedupHashV2.** The stored hash includes the local account id and the local
instrument id (`importing/dedup.py:dedup_hash`, `reconciliation_hash`). v2 is the same algorithm
with gids and the version tag `v2`, joined by U+001F, lower-hex sha256:

```
ref path:            ["v2", "ref", @account, brokerId, ref, fillKey, occurrence]
content path:        ["v2", "content", @account, contentKey, occurrence]
reconciliation:      ["v2", "reconciliation", @account, @instrument, asOf, type, decimal_key(quantity)]
fillKey    = type US instrumentKey US decimal_key(quantity) US decimal_key(price) US (currency or "")
contentKey = tradeDate US type US instrumentKey US decimal_key(quantity) US decimal_key(price)
             US decimal_key(grossAmount) US decimal_key(cashAmount)
instrumentKey = @instrument (merge-resolved at import time) or "" for cash rows
brokerId   = the importer's broker id, with the legacy rename applied (CASHU_NAMESPACE -> LEGACY_NAMESPACE)
```

Everything else (abs of parsed gross / quantity, occurrence counted per occurrence key within one
file, manual entries with broker `manual` and the smallest free occurrence) is unchanged from
`importing/dedup.py` and `service/transactions.py:_free_dedup_hash`.

### 4.7 ULID tables

`import_batches`, `inv_import_batches`, `inv_strategy_versions` (not DET(sha256): a revert A -> B -> A
would collide with the first A), `inv_theses` (several per instrument are allowed; 1 instrument on lab
has 2), `alerts`, `inv_planned_deposits`, `inv_rule_runs`, `inv_decisions`, `reviews`, `proposals`,
`research_runs`, `research_notes`, cash expenses, accounts per 4.3, instruments per 4.6.

## 5. Signals

```
dedupKeyV2 = Python's dedup key with every embedded local id replaced by a gid (section 6)
firstSeenOn = as_of (YYYY-MM-DD) of the run that opened the signal
seq        = number of signals of this vault with the same (dedupKeyV2, firstSeenOn) that sort before it
             (in the opening device's view; 0 in practice)
gid        = DET(inv_signals) [dedupKeyV2, firstSeenOn, seq]
```

Two lease holders in a split brain that open the same finding for the same day produce one signal.
A signal resolved and reopened on the same day gets `seq` 1.

## 6. Id-coupled strings (refactor 1, risk R5)

Every place where a local integer id is embedded in a string or JSON value, and its v1 form.
JSON key names stay as they are (readers keep working); only the values become gids.

| Where | Today | v1 (events and TS view) |
|---|---|---|
| signal dedup key, instrument scope | `<rule>\|i:<instrument id>` (`rules/outcomes.py:80`) | `<rule>\|i:<@instrument>` |
| signal dedup key, account scope | `<rule>\|a:<account id>` | `<rule>\|a:<@account>` |
| plan-check key | `plan:<check>\|i:<id>` (`plan/keys.py`) | `plan:<check>\|i:<@instrument>` |
| research key | `research:<week>\|i:<id>` (`research/keys.py`) | `research:<week>\|i:<@instrument>`; `\|s:<segment>`, `\|t:<theme>` unchanged |
| alert signal rule id and dedup key | `alert:<alert id>` (`service/alerts.py:536,587`) | `alert:<@alert>` |
| bucket scope | `<rule>\|s:<bucket id>` | unchanged (strategy-defined string) |
| budget `dedup_hash` | sha1 with the account id | `dedupHashV2` (4.4) |
| inv `dedup_hash`, reconciliation hash | sha256 with account and instrument ids | `dedupHashV2` (4.6) |
| cash leg `dedup_hash`, `raw.cash_leg_of` | `cashleg:<txn id>`, int | derived, `cashleg:<@txn>` (4.4) |
| cash expense `dedup_hash` | `cashexp:<uuid4>` | `cashexp:<gid>` |
| parked account key | `<key>~<account id>` | derived, `<key>~<@account>` (4.3) |
| `inv_signals.payload` | `instrument_id` (str), `alert_id`, `note_id`, `note_ids[]`, `accounts[]` | gids |
| `inv_rule_runs.report` | `{new: [signal id], escalated: [signal id]}` | `@signal[]` |
| `research_notes.details` | `watchlist_item_id`, `thesis_id`, `previous_instrument_id` | gids |
| `research_runs.scope` | `instrument_ids[]`, `covered_instrument_ids[]` | gids |
| `proposals.payload` | `account_id`, `staged` (device path) | `account@`, `blob: {sha256, ext}` |
| `budget.json` cushion | `account_ids[]` | `accounts: @account[]` |
| `inv_import_batches.archive_path` | data-dir path | `archive: {sha256, ext}` (D9 blob) |

Not affected (device-local, never synced): `connector_runs.batch_ref` (`investments:<batch id>`),
keychain secret names keyed by the binding's local id, `instrument_search` result keys (UI only),
`inv_notification_log.signal_id`.

Guard (S26 / S30 acceptance, R5): a test that greps the Python key builders for f-strings embedding
`*id` (`f"...{...id}"`, `"|i:"`, `"alert:"`) and fails on any site not listed here; and the TS
materializer rejects a dedup key or payload id that parses as a bare integer.

## 7. Genesis gids (S26)

Genesis turns one Python database into the first events of each vault. It MUST be deterministic:
running it twice on the same database yields the same gids.

- DET tables: the normal DET inputs, with local references mapped to the referenced row's gid.
- ULID tables: `uuidv5(NS[genesis], [vault, table, str(local id)])` (a UUID, not a ULID; both are valid
  gids). New rows after genesis get ULIDs.
- Instruments: `creationAlias` = the `isin` alias if the instrument has one, else its alias with the
  smallest local id; without any alias, the genesis rule above. `instrument.created.creationAlias`
  records the choice.
- Budget transactions: rebuild `contentKeyV2` from the stored columns and verify
  `sha1(str(account_id) + "|" + contentKeyV2) == dedup_hash`. On a match use 4.4. On a mismatch
  (normalization drift) use DET(transactions) `[@account, "legacy:" + stored dedup_hash, occurrence]`
  and count it in the genesis report.
- Investment transactions: recover the occurrence by recomputing the v1 hash with the local ids for
  `occurrence = 0, 1, ...` (bounded by the rows sharing the occurrence key) until it equals the stored
  hash, then compute v2. No match (e.g. the instrument was merged, `instrument_merge.py` does not
  rewrite these hashes) -> DET(inv_transactions) `[@account, "legacy:" + stored dedup_hash]`, counted.
  Reconciliation rows (`source = reconciliation`) use the reconciliation formula. Lab: 262 rows, 2
  reconciliation, 0 null hashes.
- Signals: `firstSeenOn` = as_of of `created_run_id`'s run, else the UTC date of `first_seen_at`;
  `seq` = rank by local id among the same (dedupKeyV2, firstSeenOn).
- Cash legs and other derived rows are not emitted.

## 8. Test vectors

Vault `01JC0Z8Y3K7M4N5P6Q8R9S0T1V` (synthetic). Produced with Python `uuid.uuid5`; also in
`namespaces.test.ts`.

| Case | Input parts after the vault | gid |
|---|---|---|
| account | `mbank`, `csv:XX00TEST0000` | `98ff7ab1-8526-5a5c-815d-422cd15b31c2` |
| module | `budget` | `1239cec0-c343-59e3-bdfe-159fcca7620a` |
| balance | `<account>`, `2026-01-31`, `csv` | `2895fd82-83e5-516f-b529-dd8b14b9d593` |
| budget txn | contentKeyV2 `2026-01-15\|-12.50\|PLN\|sklep testowy\|zakup testowy` -> dedupHashV2 `2568e841250298bd2055a257b85edbbc85c62f4d`; `<account>`, hash, `0` | `e54226c2-20a0-5446-87ad-434dcaba844f` |
| same, occurrence 1 | `<account>`, hash, `1` | `fb31828f-c74f-5e66-9fbc-1697ae297b62` |
| category rule | `sklep testowy` | `de31fa28-417c-5ae4-bc5a-0c5fb76447cd` |
| loan | `<account>` | `c204aed4-bddb-5da2-ad36-d809765bff6d` |
| instrument | `isin:XX0000000001` | `ebc1e39a-6334-5bf0-b460-b9c91d334f08` |
| alias | `yahoo`, `TEST.WA` | `4df2d5a6-39dd-535f-b365-779154d394db` |
| inv txn | content path, tradeDate `2026-02-03`, type `buy`, `<instrument>`, qty `10`, price `12.5`, gross `125`, cash `-125.5`, occurrence `0` -> dedupHashV2 `7c0d704bad6cb7238245d48c90add9638e576044f2c77f6cfb037562957f6b44`; `<account>`, hash | `316c3ae3-40c0-5245-8e9b-867aafe9bfe4` |
| signal | `drawdown_check\|i:<instrument>`, `2026-03-02`, `0` | `df88f798-b625-59cb-a6c9-376b4d9d27fa` |
| watchlist item | `<instrument>` | `d5e6bdd6-3558-56be-b446-ec83cddc4c8c` |
| topic thesis | `gold` | `d09c21ce-7d2e-57fa-8a1a-4cb8590c8df4` |
| cushion | `cushion` | `6134d30b-4490-5b3b-97d7-6aaf8e817e96` |
| genesis ULID-table row | `inv_theses`, `7` (namespace `genesis`) | `84370644-081f-547f-91bc-baab644fc5c8` |

`<account>` = the account vector's gid, `<instrument>` = the instrument vector's gid.

## 9. Open items (gid-specific; see also events.md O1, O2)

- **G1 CSV accounts without an IBAN** get a ULID: two devices importing the first statement of such
  an account concurrently create two accounts (Python's UNIQUE does not catch a NULL `external_id`
  either). Proposal: derive `csv-noiban:<bank>:<statement account key>` when the parser has any stable
  key; needs a look at the three bank parsers (S07).
- **G2 Instruments created without an ISIN under different aliases on two devices** (one by a broker
  symbol, one by a Yahoo pick) get different DET gids and rely on the alias-collision merge, which
  happens only when an alias actually collides. Two duplicate instruments with disjoint aliases stay
  duplicates until the owner merges them (same as today).
- **G3 `seq` of signals** counts in the opening device's view; two split-brain leaders that both
  already hold a closed same-day signal agree, but one that does not yet hold it would pick seq 0 and
  collide with the closed one (the fold then treats `opened` on a closed gid as a no-op and the
  finding is lost until the next run). Rare (same key resolved and reopened on one day during a
  lease split); acceptable?
- **G4 Genesis `legacy:` gids** (section 7, events.md O2) are stable but never equal a TS re-import's
  gid; only the view-level dedup check catches such a re-import.
