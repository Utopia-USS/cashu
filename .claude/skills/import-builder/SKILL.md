---
name: import-builder
description: >
  Use when the user has an export cashU cannot read yet (xlsx, csv, json from a broker such as XTB, DIF, Revolut, Binance, Zonda, or from a bank) or wants to pull broker, exchange or bank data from an API.
  Applicability - POSITIVE: broker / exchange / crypto history or bank statements turned into a reusable file or fetch connector (preferred), a one-off converter or a generic CSV mapping.
  Applicability - NEGATIVE: NOT bank CSV or Open Banking imports the app supports and categories (budget-setup), the strategy and check-ins (investments-setup) or custom rules (extension-builder).
  Triggers: /import-builder, "zaimportuj historię z brokera", "napisz konwerter eksportu", "parser do pliku z XTB", "konektor do banku", "wyciąg z innego banku", "pobieraj z API giełdy".
---

# import-builder: a connector (or converter) for an unsupported export

cashU ships few importers of its own. Any other export is turned into one of the documented import
formats: `references/import-format.md` (investments) or `references/budget-import-format.md` (budget,
bank statements). The preferred way is a **connector**: a small program with a manifest that the app runs
itself, in a sandbox, after the owner approved it once in the app (Ustawienia > Konektory), so every
later export (or API sync) goes through the app without you; a fetch connector reads an API with a key
the owner enters in the app. The full contract is `references/connectors.md`. You ask first whether the
user hands over the export with values or prefers the blind route (`inspect_export`), test with `cashu
connectors test` and install with `propose_connector`. Alternatives: a one-off converter
(`validate_import` / `propose_import`) or a generic CSV mapping. Conversation in Polish, files in
English, regular hyphens only.

## Relationship to the workspace

| The workspace CLAUDE.md and MCP server own | This skill adds |
|---|---|
| privacy level, boundaries, the MCP tool list, where files go | the opening question: the file with values or the blind route |
| the folders `inbox/`, `connectors/`, `scripts/` and the `cashu` CLI name | writing, testing and installing a connector in `connectors/<id>/` |
| the profile's `cashu-<slug>` server | which import tool each step calls and how to read its value-free reports |
| approval in Ustawienia > Konektory, commits in the app | the converter contract and the generic CSV mapping as alternatives |

## Problem -> reference mapping

| Task / question | Start with |
|---|---|
| What I may see, what to say at the start | this file, Non-negotiable |
| The order of the work | this file, Flow |
| Fields and records of an investments import | [`references/import-format.md`](references/import-format.md) |
| Fields and records of a bank statement import | [`references/budget-import-format.md`](references/budget-import-format.md) |
| Connector manifest, protocol, sandbox, value-free messages | [`references/connectors.md`](references/connectors.md) |
| Machine-readable contracts | [`references/schemas/connector-manifest.v1.json`](references/schemas/connector-manifest.v1.json), [`references/schemas/connector-protocol.v1.json`](references/schemas/connector-protocol.v1.json), [`references/schemas/cashu-import.v1.json`](references/schemas/cashu-import.v1.json), [`references/schemas/cashu-budget-import.v1.json`](references/schemas/cashu-budget-import.v1.json) |
| Starting code for a connector | [`references/connector-examples/`](references/connector-examples/) (`budget-csv-example`, `investments-json-example`, `fetch-example`) |
| A simple CSV without code | [`references/generic_csv_example.yaml`](references/generic_csv_example.yaml) |
| A one-off converter script | [`references/converter-workflow.md`](references/converter-workflow.md), [`references/converter_template.py`](references/converter_template.py) |

## Non-negotiable

Privacy and boundaries (say the first lines at the start, in one or two sentences):

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
- Never run `cashu invest import`, `cashu invest positions`, `cashu import-dir`, `cashu
  import-csv` (they print the user's data), never open `cashu.db`, backups or the import archive.
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
| `validate_budget_import(path)` | budget: validation report of a `cashu-budget-import` file (your connector's fixture output or a converter's), by kind / row / field, no values |
| `propose_import(path, account, mapping?)` | converter / mapping route: pending import for the owner |
| `positions`, `portfolio_overview` | after the commit: new instruments, weights, freshness |

## Flow

1. **Profile, module, account.** Use the connected `cashu-<slug>` server (ask which one if several;
   never mix profiles). Work in the profile's agent workspace (its `CLAUDE.md` names the profile; folders
   `inbox/`, `connectors/`, `scripts/`). Without one, suggest creating it (Ustawienia > Agent AI, or
   `cashu workspace init --profile <slug>`) and starting Claude Code there. `cashu` below is the CLI
   named in the workspace's `CLAUDE.md`. Module: broker history -> `investments`, bank statement ->
   `budget`. One file = one account; a missing brokerage account is added in the app or with `cashu
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
   - One-off converter script: when the user does not want a connector
     (`references/converter-workflow.md`, section "Converter route").
4. **Clarify the semantics** with the user, 1-3 questions per message: what each sheet holds; every
   type label and its cashU type (unknown labels are an error); sign conventions; currencies and FX;
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
   `cashu connectors test connectors/<id> --file <sample>`. Fetch: record a synthetic API answer as
   `fixture.json` and run `cashu connectors test connectors/<id> --fixture connectors/<id>/fixture.json`
   (the fixture arrives as `params.fixture`; never declare `fixture` in the manifest). Cover every
   label, both signs, an FX row and an error case. Claude Code asks the user to allow each command.
7. **Test on the real export:** `cashu connectors test connectors/<id> --file inbox/<export>`. The
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

Converter route (one-off script for investments, or a `cashu-budget-import` file for statements) and
the converter contract (standard library only, value-free errors, exact decimals, deterministic rows):
`references/converter-workflow.md`.

## References

| File | Style | Impact | Description |
|---|---|---|---|
| [`references/converter-workflow.md`](references/converter-workflow.md) | workflow | HIGH | the one-off converter route and the converter contract |
| [`references/converter_template.py`](references/converter_template.py) | pattern | HIGH | starting point for a converter script (helpers and `main()` to keep) |
| [`references/connectors.md`](references/connectors.md) | copy | CRITICAL | connector manifest, protocol, sandbox, value-free messages; copy of the app's reference, refreshed with every cashU version |
| [`references/import-format.md`](references/import-format.md) | copy | CRITICAL | the cashU investments import format; copy of the app's reference, refreshed with every cashU version |
| [`references/budget-import-format.md`](references/budget-import-format.md) | copy | HIGH | the `cashu-budget-import` format for bank statements; copy of the app's reference, refreshed with every cashU version |
| [`references/generic_csv_example.yaml`](references/generic_csv_example.yaml) | copy | MEDIUM | generic CSV mapping example; copy of the app's reference, refreshed with every cashU version |
| `references/schemas/*` ([`connector-manifest.v1.json`](references/schemas/connector-manifest.v1.json), [`connector-protocol.v1.json`](references/schemas/connector-protocol.v1.json), [`cashu-import.v1.json`](references/schemas/cashu-import.v1.json), [`cashu-budget-import.v1.json`](references/schemas/cashu-budget-import.v1.json)) | copy | MEDIUM | JSON schemas of the manifest, the protocol and both import formats; copy of the app's reference, refreshed with every cashU version |
| `references/connector-examples/**` ([`budget-csv-example`](references/connector-examples/budget-csv-example/), [`investments-json-example`](references/connector-examples/investments-json-example/), [`fetch-example`](references/connector-examples/fetch-example/)) | copy | HIGH | working example connectors (`connector.yaml` + `connector.py`); copy of the app's reference, refreshed with every cashU version |

## See also

- `/budget-setup` - bank exports the app already reads, Open Banking, categories.
- `/investments-setup` - the strategy interview and check-ins once the history is imported.
- `/extension-builder` - a custom rule on the imported data.

## Self-audit checklist

Before telling the user it is done:
1. The privacy lines were said at the start; the (a) / (b) question was asked once, or skipped because
   the user had already handed over the file.
2. No real value, account number or name is in `connectors/<id>/`, `scripts/`, `notes/` or memory;
   test samples are synthetic; a file name with an account number was renamed.
3. `cashu connectors test` passed on synthetic data (every label, both signs, an FX row, an error case)
   and on the real export; every warning was read with the user.
4. `propose_connector` ran after the last edit, the owner was told what to check in Ustawienia >
   Konektory, and `connectors()` showed it approved before the import.
5. Converter or mapping route: `validate_import` / `validate_budget_import` clean before
   `propose_import`; the converted file was deleted after the commit.
6. After the commit: `positions` checked and unclassified instruments named for the owner.
