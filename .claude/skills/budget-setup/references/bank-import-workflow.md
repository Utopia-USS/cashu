# Banks, CSV import and Open Banking

What this is: steps 4-6 of `/budget-setup` - choosing banks, importing CSV statements and the
optional Open Banking (Enable Banking) connection. The privacy rules in SKILL.md apply throughout:
commands that print account names, balances or transactions are run by the user in their own
terminal.

## Step 4 - Which banks (Decision)

Ask which banks the user has. Supported CSV formats (verified): **mBank** (cp1250, `;`,
multi-currency), **Erste / former Santander** (UTF-8, no header, positional), **Pekao** (UTF-8, `;`).
Bank Millennium: Open Banking only for now (no CSV parser yet).

A different bank:
- Open Banking, if Enable Banking lists it (`cashu eb banks --country PL` after step 6 is configured);
- or a **connector** (preferred, no change to cashU): the `import-builder` skill writes it in the
  workspace's `connectors/`, the owner approves it once in Ustawienia > Konektory and the app then
  imports this bank's statements itself (also a `fetch` connector when the bank has an API with a key
  the owner enters in the app). It starts with the question of step 5;
- or a new CSV parser: a code change in a cashU source checkout (its developer guide, section
  "Adding a new bank"); its test fixtures are synthetic (the real header line plus 2-3 rows with
  invented values, same encoding and separator).

## Step 5 - CSV import (recommended first)

A supported bank: the user imports the CSV in the app (Wydatki > Import, the bank is recognised) and
checks the preview there; nothing for you to see. A bank cashU does not read yet: ask once, before
anything else: (a) "Daj mi plik z wartościami" (the user saves the statement in `inbox/` or names a
path; you read it and build the connector against the real columns) or (b) **recommended**: a
connector written without seeing values (`inspect_export` shows the masked structure), approved once in
the app. The answer decides; then follow `import-builder`. If the user already handed you the file,
skip the question.

Many files at once (CLI): the user puts them in one folder per bank: in the agent workspace
`inbox/statements/<bank>/`, in a source checkout `statements/<bank>/` (git-ignored); bank folders
`mbank`, `erste`, `pekao`. The user runs in their own terminal, from the workspace (or the checkout):

```bash
cashu --profile <slug> import-dir inbox/statements   # checkout: import-dir statements; idempotent
```

Then you may run `cashu --profile <slug> match-transfers` (pairs internal transfers by IBAN; prints a
count). Internal transfers are matched by counterparty IBAN only; you never need to know an IBAN.

## Step 6 - Open Banking (optional, Decision)

Skip if CSV is enough. Needs a free Enable Banking account ("Restricted Production"). The user does
these themselves (you have no access to their bank panel or keys):

1. Create an app at <https://enablebanking.com/cp/>, generate an RSA key pair, upload the public key,
   save the private key as `enablebanking_private.pem` in the data dir (next to `cashu.db`, outside
   the repo).
2. In `.env`: `CASHU_EB_APP_ID` (and `CASHU_EB_KEY_PATH` if the key is elsewhere). The user edits it.
3. In the EB panel: whitelist the redirect `https://localhost:8000/eb/callback` and click "Activate by
   linking accounts".
4. In their terminal: `cashu eb check`, `cashu eb banks --country PL`, then
   `cashu --profile <slug> eb login "mBank" --bank mbank` (the browser opens; they log in at the bank
   and confirm SCA there).
5. Later: `cashu eb resync` about once a day (sessions last ~90 days, per profile; `--add-session`
   keeps two sessions of one bank in a household profile).
