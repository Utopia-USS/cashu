# Banks, CSV import and Open Banking

What this is: steps 4-6 of `/budget-setup` - where the transactions come from (by country), importing
statement files through the app or a connector, and the automatic Open Banking (Enable Banking)
connection. The privacy rules in SKILL.md apply throughout:
commands that print account names, balances or transactions are run by the user in their own
terminal.

## Step 4 - Where the transactions come from (Decision)

This skill names no bank. What cashU can read comes from the app at run time (the connector catalog,
the app's own bank list); the bank names in the conversation come only from the user.

1. **Ask one question:** in which country the accounts are, and at which banks. Do not list banks and do
   not say "Open Banking", "PSD2" or "CSV" before the answer. If `setup_status("budget")` already shows
   accounts, say so and ask only about the rest.
2. **Recommend by country:**

   | Accounts in | Recommend | Also possible |
   |---|---|---|
   | Europe (EU / EEA, UK) | automatic, through Open Banking (step 6) | files, also for older history |
   | anywhere else, the US included | files (step 5) | - |

   Outside Europe cashU has no automatic bank connection yet: never promise one or a date.
3. **Explain the paths in plain words**, in the owner's language, what they get and what it costs:
   - **Automatic:** the bank sends new transactions to cashU once a day, no files to export. Set up once,
     about 15 minutes: a free account at Enable Banking (a licensed intermediary that connects to banks),
     its key added in the app, then logging in at the bank's own page. Read-only access; the bank
     password is typed only at the bank, cashU and you never see it; every 90 days the bank asks to renew
     the consent (one login). Whether a given bank is covered the user sees in the app (step 6, the
     bank list); never claim it yourself.
   - **Files:** the user downloads a statement (usually CSV) from the bank's website and imports it.
     Works today with no setup, but has to be repeated, e.g. once a month.
   - **Both (good default in Europe):** files once for the older history (over Open Banking a bank often
     gives only the last few months), then automatic for everything new.
4. **Per bank on the files path, check what is ready:** call the MCP tool `connectors` and look at
   `catalog`. An entry matches when its `name` names the user's bank and its `countries` contains the
   user's country (ISO code; `null` = not tied to a country, e.g. an international broker). Never offer
   `example-bank-csv` (a made-up bank that only shows the catalog layout). Then tell the user:
   - a matching entry, `valid` and not `stale`: a ready connector from the community catalog (its
     maintainer, verified on `last_verified`); install it for their review with
     `propose_connector(catalog_id=...)` and they approve it once in Ustawienia > Konektory;
   - a matching entry that is `stale`: the same, with the warning that it may need a fix;
   - `installed_status` already set: it is installed; only approval or nothing is left;
   - no match: you write a connector once (step 5, "A bank with no reader yet").

   Without MCP the user can run `cashu connectors catalog list` (no personal data) and paste the result.

## Step 5 - Importing files

The user saves the statements in the agent workspace `inbox/statements/` (a subfolder per bank keeps it
tidy) and imports them in the app: Wydatki > Import, with `rozpoznaj automatycznie`. The app recognises
the formats it reads itself and runs the approved connectors for the rest, shows a preview and the user
commits. The user imports; you never open the statements unless they hand you one for a task.

Many files at once, in a format the app reads itself: the user runs in their own terminal, from the
workspace

```bash
cashu --profile <slug> import-dir inbox/statements   # format auto-detected; idempotent
```

A file it does not recognise is reported and skipped; such a bank goes through its connector in the
app. Then you may run `cashu --profile <slug> match-transfers` (pairs internal transfers by IBAN;
prints a count). Internal transfers are matched by counterparty IBAN only; you never need to know an
IBAN.

**A bank with no reader yet** (no catalog entry, step 4): ask once, before anything else: (a) "Daj mi
plik z wartościami" (the user saves the statement in `inbox/` or names a path; you read it and build the
connector against the real columns) or (b) **recommended**: a connector written without seeing values
(`inspect_export` shows the masked structure), approved once in the app. The answer decides; then
follow `import-builder`. If the user already handed you the file, skip the question. cashU takes no new
built-in bank parsers; a connector that works well can go to the community catalog (`connectors/` in
the cashU repository, with `countries` set).

## Step 6 - Open Banking (the automatic path, Europe)

The recommended path for accounts in Europe (step 4). Needs a free Enable Banking account; for one
person's own accounts a production application in restricted mode is enough. The user does all of this
themselves (you have no access to their bank, the EB panel or keys).

**One step per message.** Do not list all five steps up front: the user is busy in another window and
would have to scroll back. Say once that there are 5 steps, then give only the current one ("Krok 2 z 5:
..."), with where to click, and wait until they say it is done or describe what they see. Only then
give the next step, opening with one line of where they are.

1. **Register the application.** Sign up at <https://enablebanking.com/cp/>, open **API applications**
   in the top menu and register a new one: environment **Production** (not Sandbox), let the browser
   generate the key, then fill in the form exactly like this (every field is required; with a
   restricted application the user is its only user, so these just have to be valid):

   | Field | Value |
   |---|---|
   | Application name | `cashU` |
   | Redirect URLs | `https://127.0.0.1:18888/eb/callback` |
   | Description | `Personal finance management, own accounts only` |
   | Data protection email | the user's own e-mail |
   | Privacy URL | `https://github.com/Utopia-USS/cashu/blob/main/PRIVACY.md` |
   | Terms URL | `https://github.com/Utopia-USS/cashu/blob/main/LICENSE` |

   Then **Register**. The browser saves the private key as a `.pem` named after the application ID in
   Downloads: it stays on the Mac, never in the workspace or a chat.
2. **Activate it.** The new application shows as **Inactive**: next to it, click **Activate by linking
   accounts** and link their own bank account. It then shows **Active** in restricted mode (only their
   own linked accounts), which is what cashU needs. Say up front that step 4 asks for a second bank
   login on purpose: linking here only tells Enable Banking which accounts the application may read
   (once, while setting up); it gives cashU no access. The access itself is the consent in step 4,
   renewed every 90 days in cashU only. An account not linked here cannot be read in cashU.
3. **In the app:** Ustawienia > Konektory, section Open Banking: drag the `.pem` from Downloads onto the
   dashed box (or "Wybierz prywatny plik klucza"). The application ID (Identyfikator aplikacji) is the
   string in brackets next to the application's name in the EB panel; the key file carries the same
   name, so the field can stay empty. Then "Sprawdź aplikację". A refusal names the cause (not a key
   file, not an RSA key, no application ID); say what it means, never guess further.
4. Below "Sprawdź aplikację" (which confirms with the application's name), the app loads Enable
   Banking's bank list by itself into the "Bank" picker (typing while it has focus jumps to the bank).
   They pick the bank and press "Połącz bank" (it works only with a bank from the list), then "Otwórz
   stronę banku": the bank's page opens in their browser and they log in at the bank again (the second
   login announced in step 2, this time for cashU's own consent). After the consent the browser says
   "Otrzymano autoryzację banku" and cashU finishes by itself and loads the transactions: no button,
   nothing to paste. Only if the browser could not come back (it shows an error for
   `https://127.0.0.1:18888/eb/callback...`), the folded "Przeglądarka nie wróciła do cashU?" takes
   that whole address from the address bar. A bank with a separate business banking login is a
   separate entry and a separate connection. A refusal names its fix: consent not granted (is the
   account linked in the EB panel?), no answer within 5 minutes, cashU's return address missing from
   the application's Redirect URLs (add `https://127.0.0.1:18888/eb/callback` in the EB panel), no
   linked accounts ("Link accounts"), port 18888 in use, no internet. Retrying right away is fine.
5. Later: the daily background job syncs (Ustawienia > Praca w tle keeps it running after the window
   closes), or "Synchronizuj teraz" in the same panel, or `cashu --profile <slug> eb resync` in their
   terminal, about once a day. The bank consent cashU asks for lasts 90 days (the EU rules allow banks up
   to 180, but cashU requests 90 today); then the user reconnects the bank in the same panel.
   Connections are per profile; `cashu --profile <slug> eb sessions` lists them.

The top of the Open Banking section shows the state: "Enable Banking jest skonfigurowany" with the
application ID, the connected banks, "Zmień aplikację albo klucz" (the key form again) and "Usuń
konfigurację" (after a confirmation: the key and every bank connection leave the profile; imported
transactions stay).

If the EB panel looks different from these steps, say so plainly and let the user describe what they
see; never guess labels.
