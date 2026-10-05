---
name: import-builder
description: Builds an importer for a broker or exchange export that finanse cannot read yet, without the agent ever seeing the raw data - inspects the file's structure through the profile's finanse MCP server (inspect_export), writes a small conversion script (or a generic CSV mapping for simple CSVs), runs the script locally itself under Claude Code's permission prompts to produce a finanse-format file (the app never runs scripts), validates that file (validate_import) and submits it as a pending import (propose_import) that the owner commits in the app. Use when the user has a broker / exchange / crypto export (xlsx, csv, json) in an unsupported format, asks to import transaction history from a broker such as XTB, DIF, Revolut, Binance or Zonda, or wants a converter for an export. Triggers on /import-builder and on Polish requests such as "zaimportuj historię z brokera", "napisz konwerter eksportu", "parser do pliku z XTB", "mam eksport w xlsx", "import transakcji". Not for bank statements (budget-setup).
---

# import-builder: a converter for an unsupported export

finanse ships no broker-specific importers. Any export is converted into the documented finanse import
format (`docs/import-format.md`) or read with a generic CSV mapping. You write that converter from the
file's **structure**, never from its contents, and you run it yourself. Conversation in Polish, files
in English, regular hyphens only.

## Privacy and boundaries (say the first three lines at the start)

- You see the export only through `inspect_export`: sheets, columns, inferred types, row counts and
  sample rows with amounts, identifiers and names masked. Validation results come back as counts and
  error kinds with row numbers and field names, never values. Every MCP call is logged in Ustawienia >
  Agent AI; the privacy level (`profile_overview`: `strict` = Ścisły or `amounts` = Z kwotami) applies to everything
  else. Accounts appear as generated labels ("<institution> <type> <n>") in both levels.
- The app never runs code you write. You run the converter on the user's computer with a Bash
  command; Claude Code asks the user before every run, so they see the exact command and can read the
  script first. `validate_import` / `propose_import` take only a finanse-format file or a CSV with a
  mapping: a script path or a `converter` argument is refused.
- The import itself is a proposal: nothing is written to the portfolio until the owner reviews the
  preview and the reconciliation in the app and commits it.
- Never open, `cat`, `head`, list or parse the real export or the converted file yourself, and never
  print their rows (the converter prints nothing but value-free errors). Never run `finanse invest
  import` or `finanse invest positions` (they print the user's data).
- Never ask for broker logins, passwords, 2FA codes, API keys, IBANs or account numbers. File names
  often contain account numbers: ask the user to rename the file to something neutral (e.g.
  `broker-2026.xlsx`) before telling you its path.
- Never download exports or fetch data from the broker's site for the user, and never bypass bot
  protection. Broker documentation of the export format may be looked up online (with the source).

## MCP tools used

| tool | step |
|---|---|
| `profile_overview`, `setup_status("investments")` | start: privacy level, brokerage accounts present |
| `inspect_export(path)` | structure of the export (masked) |
| `validate_import(path, mapping?)` | validation report of the converted file, or of a CSV + mapping |
| `propose_import(path, account, mapping?)` | runs the preview and stores a pending import for the owner |
| `positions`, `portfolio_overview` | after the commit: new instruments, weights, freshness |

## Flow

1. **Profile and account.** Use the connected `finanse-<slug>` server (ask which one if several; never
   mix profiles; none connected: `claude mcp add finanse-<slug> -- finanse mcp --profile <slug>`, restart
   Claude Code). One file = one brokerage account. If the account does not exist yet, the user adds it
   in the app or with `finanse --profile <slug> invest accounts add "<name>" --broker <id> --wrapper
   <regular|ike|ikze|oipe|other>`; account labels come from `setup_status` / `portfolio_overview`.
2. **The file.** The user saves the export locally, renames it if the name holds an account number,
   and gives you the path. Call `inspect_export(path)`.
3. **Choose the path.**
   - A simple CSV (one row per transaction, a type column, dates and numbers in one format): a generic
     CSV mapping, no code. Model it on
     `src/finanse/modules/investments/importing/generic_csv_example.yaml`, save it as
     `<data dir>/profiles/<slug>/extensions/import_<source>.yaml` (data dir: step 5), and pass it as
     `mapping` with the export as `path`. Steps 4 and 8-10 apply; a mapping is data, not code.
   - Anything else (xlsx with several sheets, cash ledger and trades in separate tables, positions
     snapshot, odd sign conventions, corporate actions): a converter script (below).
4. **Clarify the semantics** with the user, 1-3 questions per message: what each sheet holds; the
   broker's type labels and what they mean (map every label to a finanse type, unknown labels are an
   error); sign conventions (is a buy negative?); which currency each amount is in, and FX rates; fees
   and withholding tax columns; whether a stable broker transaction / order id exists (only then
   `external_ref`); whether there is a positions sheet (it becomes `position` records for the
   reconciliation); how splits, renames and delistings appear. Masked samples show the types; ask the
   user to describe values when needed, never to paste rows.
5. **Write the converter** to `<data dir>/profiles/<slug>/extensions/import_<source>.py` (find the data
   dir with `python3 -c "from finanse.core import paths; print(paths.data_dir())"` in the project's
   venv, or ask the user: Ustawienia > Dane). Start from `references/converter_template.py` and follow
   the contract below. Show the user a short summary of what it reads and how it maps, and where the
   file is, so they can read it.
6. **Test it on synthetic data** in the scratchpad: build rows (or a small file) with the same columns,
   types and quirks as the inspect output and invented values, run the converter on them and check the
   output with `finanse invest validate <synthetic output>` (safe: synthetic). Cover every type label,
   both signs, an FX row and an error case.
7. **Run it on the real export yourself**, with the system Python in isolated mode (not the finanse
   app binary, not the project's venv: the converter needs only the standard library):
   `python3 -I <data dir>/profiles/<slug>/extensions/import_<source>.py <export> <data dir>/profiles/<slug>/extensions/converted/<source>-<YYYY-MM-DD>.csv`
   (create the `converted` folder first). Claude Code asks the user to allow the command; tell them
   what it does in one line before. Exit 0 = the file is written; exit 1 = a data problem: you see only
   the converter's value-free message (row and field), fix the script, test on synthetic data again
   and rerun. Never open, print or list the output file.
8. **Validate the converted file:** `validate_import(<output.csv>)` (or the export with `mapping`). Fix
   errors by kind and row number in the converter and rerun step 7. Read every warning with the user
   (cash sign, amount mismatch, unknown exchange).
9. **Submit:** `propose_import(<output.csv>, account)` (or the export with `mapping`). The app stores
   its own copy with the preview as a pending import. The owner opens it in Inwestycje > Import, checks
   the new instruments and the reconciliation against the broker's position snapshot (quantities must
   match exactly), applies or rejects the proposed corrections and commits. Re-importing an
   overlapping export later does not duplicate rows (see the dedup rules in `docs/import-format.md`
   section 5).
10. **Clean up and after the commit:** delete the converted file (`rm <output.csv>`; it holds the
    user's transactions and the app keeps its own copy); keep the converter script for the next export
    from the same broker. `positions` shows new instruments; unclassified ones need an asset class,
    tags or a bucket in the app before allocation rules run.

## Converter contract

- Python standard library only (`csv`, `zipfile` + `xml.etree` for xlsx, `json`, `decimal`,
  `datetime`). No network, no subprocesses, no environment variables, never imports `finanse`, reads
  only the export and writes only the output file.
- Invocation: `python3 -I import_<source>.py <export file> <output .csv>`; exit 0 on success, 1 with a
  message on stderr on a data problem, 2 on wrong usage. Nothing on stdout.
- Error messages name the row and the field, never the cell value (they are shown to you).
- Deterministic: the same export always gives the same rows. Rows oldest first, `time` filled when the
  export has it.
- `external_ref` only from a stable broker id; never from row numbers or counters. Leave
  `account_hint` empty (the account is chosen in `propose_import`).
- Numbers as exact decimal text (`decimal.Decimal`, never float). `cash_amount` exactly as the broker
  booked it, with its sign; `quantity`, `price`, `fee`, `tax` never negative.
- A trade settled in another currency: `cash_currency` plus `cash_amount` or `fx_rate`.
- Unknown type labels, unparsable dates or numbers: an error, never a silent skip or a guess.
- A header docstring: broker, export kind, profile, date, input description, run command.
- The full field reference and checklist: `docs/import-format.md` (sections 3-9 and 11).
