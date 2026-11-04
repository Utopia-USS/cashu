# Banks, CSV import and Open Banking

What this is: steps 4-6 of `/budget-setup` - choosing banks, importing CSV statements and the
optional Open Banking (Enable Banking) connection. The privacy rules in SKILL.md apply throughout:
commands that print account names, balances or transactions are run by the user in their own
terminal.

## Step 4 - Which banks (Decision)

Ask which banks the user has. Supported CSV formats (verified): **mBank** (cp1250, `;`,
multi-currency), **Erste / former Santander** (UTF-8, no header, positional), **Pekao** (UTF-8, `;`).
Bank Millennium and Revolut: Open Banking only for now (no CSV parser yet).

A different bank:
- Open Banking, if Enable Banking lists it (step 6, "Load banks" in the app);
- or a **connector** (no change to cashU): the `import-builder` skill writes it in the workspace's
  `connectors/`, the owner approves it once in Ustawienia > Konektory and the app then imports this
  bank's statements itself (also a `fetch` connector when the bank has an API with a key the owner
  enters in the app). It starts with the question of step 5. cashU takes no new built-in bank
  parsers.

## Step 5 - CSV import (recommended first)

A supported bank: the user puts the files in one folder per bank, in the agent workspace
`inbox/statements/<bank>/` (bank folders `mbank`, `erste`, `pekao`), and runs in their own terminal,
from the workspace:

```bash
cashu --profile <slug> import-dir inbox/statements   # bank from the subdir name; idempotent
```

Then you may run `cashu --profile <slug> match-transfers` (pairs internal transfers by IBAN; prints a
count). Internal transfers are matched by counterparty IBAN only; you never need to know an IBAN.

A bank cashU does not read yet: ask once, before anything else: (a) "Daj mi plik z wartościami" (the
user saves the statement in `inbox/` or names a path; you read it and build the connector against the
real columns) or (b) **recommended**: a connector written without seeing values (`inspect_export`
shows the masked structure), approved once in the app. The answer decides; then follow
`import-builder`. If the user already handed you the file, skip the question.

## Step 6 - Open Banking (optional, Decision)

Skip if CSV is enough. Needs a free Enable Banking account ("Restricted Production"). Everything runs
in the app, and the user does these themselves (you have no access to their bank panel or keys):

1. Create an application at <https://enablebanking.com/cp/>, generate an RSA key pair, upload the
   public key and keep the private key file on the Mac (never in the workspace, never in a chat).
2. In the EB panel: whitelist the redirect `https://127.0.0.1:18888/eb/callback` and click "Activate by
   linking accounts".
3. In the app: Ustawienia > Konektory > Bankowość otwarta > "Skonfiguruj Enable Banking": the application
   ID and the private key file (read locally), then "Sprawdź aplikację".
4. "Pobierz banki", choose the bank, "Połącz bank": the bank's page opens in the browser; they log in
   at the bank and confirm SCA there, then paste the full callback URL from the browser into the app
   and press "Dokończ połączenie".
5. Later: the daily background job syncs (Ustawienia > Praca w tle keeps it running after the window
   closes), or "Synchronizuj teraz" in the same panel, or `cashu --profile <slug> eb resync` in their
   terminal, about once a day (sessions last ~90 days, per profile; `cashu --profile <slug> eb sessions`
   lists them).
