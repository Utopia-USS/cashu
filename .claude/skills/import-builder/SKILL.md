---
name: import-builder
description: Builds an importer for an export finanse cannot read yet - broker / exchange / crypto history (investments) or a bank statement (budget). Preferred result is a reusable connector in the workspace's connectors/ folder that the app runs itself once the owner approves it in Ustawienia > Konektory; also fetch connectors for an API (the owner enters the key in the app). Asks first whether the user hands over the export with values or prefers the blind route (inspect_export); tests with `finanse connectors test`, installs with propose_connector. Alternatives - a one-off converter (validate_import / propose_import) or a generic CSV mapping. Use for an unsupported export (xlsx, csv, json) from a broker (XTB, DIF, Revolut, Binance, Zonda) or a bank, or to pull data from an API. Triggers on /import-builder and Polish requests such as "zaimportuj historię z brokera", "napisz konwerter eksportu", "parser do pliku z XTB", "konektor do banku", "wyciąg z innego banku", "pobieraj z API giełdy".
---

# import-builder: a connector (or converter) for an unsupported export

finanse ships few importers of its own. Any other export is turned into one of the documented import
formats: `references/import-format.md` (investments) or `references/budget-import-format.md` (budget,
bank statements). The preferred way is a **connector**: a small program with a manifest that the app runs
itself, in a sandbox, after the owner approved it once in the app, so every later export (or API sync)
goes through the app without you. The full contract is `references/connectors.md`. Conversation in
Polish, files in English, regular hyphens only.

## Privacy and boundaries (say the first lines at the start, in one or two sentences)

- The privacy level (`profile_overview`: `strict` = Ścisły, `amounts` = Z kwotami) covers what the app's
  MCP tools give you. Files or rows the user hands you themselves are their choice: use them for the task
  they asked for; never refuse them and never lecture. At most one sentence on what you keep: values
  stay in this conversation, never in `notes/`, memory, scripts, git or any file other than the
  converted output.
- Never print the user's rows back in full; refer to rows by number and fields by name. Account numbers,
  IBANs and names you see are never repeated or written anywhere. File names often contain account
  numbers: ask the user to rename the file to something neutral (e.g. `broker-2026.xlsx`).
- The app runs only a connector the owner approved in Ustawienia > Konektory, pinned by its content hash,
  in a sandbox. You cannot approve one and MCP tools never run code: `propose_connector` only installs
  it as pending, and `validate_import` / `propose_import` refuse a script path or a `converter` argument.
- Every import is a preview the owner commits in the app (or a pending proposal); nothing is written
  before that.
- Never ask for broker or bank logins, passwords, 2FA / SCA codes, API keys, IBANs or account numbers.
  A fetch connector's key is entered by the owner in the app (binding form in Ustawienia > Konektory).
  If the user pastes a secret, do not repeat or store it, and tell them to enter it in the app instead.
- Never run `finanse invest import`, `finanse invest positions`, `finanse import-dir`, `finanse
  import-csv` (they print the user's data), never open `finanse.db`, backups or the import archive.
- Never download exports or fetch data from a broker's or bank's site for the user, and never bypass
  bot protection. Public documentation of an export format or an API may be looked up (with the source).

## MCP tools used

| tool | step |
|---|---|
| `profile_overview`, `setup_status("investments" / "budget")` | start: privacy level, modules, accounts |
| `inspect_export(path)` | blind route: the export's structure (masked token shapes, no values) |
| `propose_connector(path)` | install the connector directory as pending (runs nothing) |
| `connectors()` | status of installed connectors (pending / approved / changed), last run |
| `validate_import(path, mapping?)` | converter route: validation report of the converted file |
| `validate_budget_import(path)` | budget: validation report of a `finanse-budget-import` file (your connector's fixture output or a converter's), by kind / row / field, no values |
| `propose_import(path, account, mapping?)` | converter / mapping route: pending import for the owner |
| `positions`, `portfolio_overview` | after the commit: new instruments, weights, freshness |

## Flow

1. **Profile, module, account.** Use the connected `finanse-<slug>` server (ask which one if several;
   never mix profiles). Work in the profile's agent workspace (its `CLAUDE.md` names the profile; folders
   `inbox/`, `connectors/`, `scripts/`). Without one, suggest creating it (Ustawienia > Agent AI, or
   `finanse workspace init --profile <slug>`) and starting Claude Code there. `finanse` below is the CLI
   named in the workspace's `CLAUDE.md`. Module: broker history -> `investments`, bank statement ->
   `budget`. One file = one account; a missing brokerage account is added in the app or with `finanse
   --profile <slug> invest accounts add "<name>" --broker <id> --wrapper <regular|ike|ikze|oipe|other>`.
2. **The file.** If the user already handed you the file or rows, skip the question and use them.
   Otherwise ask once, before anything else:
   "Jak wolisz? (a) **Daj mi plik z wartościami**: zapisz eksport w `inbox/` (albo podaj ścieżkę),
   przeczytam go i przygotuję import. (b) **Zalecane**: napiszę konektor bez oglądania wartości (widzę
   tylko strukturę pliku), zatwierdzisz go raz w aplikacji i ten oraz kolejne eksporty zaimportujesz w
   aplikacji."
   - (a) Read the file the user named (any local path; `inbox/` is the usual place) to learn its columns,
     labels and quirks from the real rows.
   - (b) Call `inspect_export(<absolute path>)`: sheets, columns, inferred types, row counts and masked
     samples (amounts, identifiers and names masked; free text as token shapes like `OPEN BUY AAA9.AA
     9.9999 @ 999.99`). Ask the user to describe what you cannot see.
   Both routes end in the same reusable result (step 3), so the next export goes through the app.
3. **Choose the path.**
   - **Connector (preferred):** a `file` connector for exports; a `fetch` connector when the broker,
     exchange or bank has an API with a read-only key (steps 5-9).
   - Generic CSV mapping (investments only, a simple CSV: one row per transaction, a type column,
     consistent dates and numbers): no code. Model it on `references/generic_csv_example.yaml`, save it
     as `scripts/import_<source>.yaml`, pass its YAML text as `mapping` to `validate_import` /
     `propose_import` with the export as `path`. Steps 4, 10.
   - One-off converter script: when the user does not want a connector (section "Converter route").
4. **Clarify the semantics** with the user, 1-3 questions per message: what each sheet holds; every
   type label and its finanse type (unknown labels are an error); sign conventions; currencies and FX;
   fees and withholding tax; a stable transaction / order id (only then `external_ref` /
   `transaction_id`); a positions sheet (investments: `position` records for the reconciliation); how
   splits, renames and delistings appear; for statements: which column is the counterparty, the title,
   the counterparty's account (internal transfers need it).
5. **Write the connector** in the workspace's `connectors/<id>/` (`id` like `xtb-xlsx`, `mbank-api`):
   `connector.yaml` and one script, Python standard library only. Start from the closest example in
   `references/connector-examples/` (`budget-csv-example`, `investments-json-example`, `fetch-example`)
   and follow `references/connectors.md` (manifest, protocol, sandbox, value-free messages). Labels and
   the name in the manifest in Polish (the owner sees them). Never put real values in the directory:
   the owner sees every file, and test samples stay synthetic.
6. **Test on synthetic data:** build a small sample with the same columns, labels and quirks and
   invented values (in the connector's folder, e.g. `sample.csv`, or the scratchpad), then
   `finanse connectors test connectors/<id> --file <sample>`. Fetch: record a synthetic API answer as
   `fixture.json` and run `finanse connectors test connectors/<id> --fixture connectors/<id>/fixture.json`
   (the fixture arrives as `params.fixture`; never declare `fixture` in the manifest). Cover every
   label, both signs, an FX row and an error case. Claude Code asks the user to allow each command.
7. **Test on the real export:** `finanse connectors test connectors/<id> --file inbox/<export>`. The
   report is value-free (counts, problem kinds with row numbers and field names), so it is fine on both
   routes. Fix by kind and row and rerun until it says OK; read every warning with the user.
8. **Install:** `propose_connector(<absolute path of connectors/<id>>)`. Tell the owner, in one or two
   sentences: open Ustawienia > Konektory, check the command, the network (none, or the hosts), the files
   and the code, and approve. After a later edit run `propose_connector` again: the connector shows as
   changed and needs a new approval.
9. **Import through the app** once `connectors()` shows it approved:
   - file connector: Inwestycje > Import or Wydatki > Import, choose the connector (or `rozpoznaj
     automatycznie`), check the preview and commit; next exports the same way, without you;
   - fetch connector: in the connector's view in Ustawienia > Konektory the owner adds a binding
     (account, params, the key typed into the password field), `Sprawdź połączenie`, then
     `Synchronizuj`. The first sync is always a pending import to review; `Automatyczny zapis` applies
     only after that.
10. **After the commit:** `positions` (investments) shows new instruments; unclassified ones need an
    asset class, tags or a bucket in the app. Delete any converted file from `inbox/converted/`; keep the
    connector (or script, mapping) for the next export.

## Converter route (one-off)

For the investments module, when the user prefers a script to a connector:

- Write `scripts/import_<source>.py` from `references/converter_template.py` (contract below), test it on
  synthetic data with `finanse invest validate <synthetic output>`.
- Run it yourself with the system Python in isolated mode (not the finanse app binary, not a venv):
  `python3 -I scripts/import_<source>.py inbox/<export> inbox/converted/<source>-<YYYY-MM-DD>.csv`
  (create `inbox/converted` first); tell the user in one line what the command does. Exit 1 = a data
  problem with a value-free message: fix, test on synthetic data, rerun.
- `validate_import(<output.csv>)`, fix by kind and row; then `propose_import(<output.csv>, account)`. The
  owner checks the preview and the reconciliation in Inwestycje > Import and commits. Re-importing an
  overlapping export does not duplicate rows (`references/import-format.md` section 5). Delete the
  converted file after the commit.
- Budget statements: a script may write a `finanse-budget-import` file (CSV or JSON) to `inbox/converted/`;
  check it with `validate_budget_import(<output>)` and fix by kind and row; the owner imports it in
  Wydatki > Import (`Format finanse`). Import older periods first: rows older than the account's newest
  stored day are skipped as overlap (`references/budget-import-format.md` section 4). A connector is the
  better choice here.

## Converter contract (scripts) - connectors follow references/connectors.md

- Python standard library only (`csv`, `zipfile` + `xml.etree` for xlsx, `json`, `decimal`,
  `datetime`). No network, no subprocesses, no environment variables, never imports `finanse`, reads
  only the export and writes only the output file.
- Invocation: `python3 -I import_<source>.py <export file> <output .csv>`; exit 0 on success, 1 with a
  message on stderr on a data problem, 2 on wrong usage. Nothing on stdout.
- Error messages name the row and the field, never the cell value.
- Deterministic: the same export always gives the same rows, oldest first, `time` filled when known.
- `external_ref` only from a stable broker id, never from row numbers or counters. Leave
  `account_hint` empty (the account is chosen in `propose_import`).
- Numbers as exact decimal text (`decimal.Decimal`, never float). `cash_amount` exactly as the broker
  booked it, with its sign; `quantity`, `price`, `fee`, `tax` never negative.
- A trade settled in another currency: `cash_currency` plus `cash_amount` or `fx_rate`.
- Unknown type labels, unparsable dates or numbers: an error, never a silent skip or a guess.
- A header docstring: broker, export kind, profile, date, input description, run command.
- The full field reference and checklist: `references/import-format.md` (sections 3-9 and 11).
