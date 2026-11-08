# The app, the `cashu` command and the finish

What this is: step 2 (getting cashU.app running, the `cashu` command) and step 10 (finish and the
git-ignore check) of `/budget-setup`. cashU is a native desktop app: there is nothing to install
besides the app itself.

## Step 2 - The app and the `cashu` command

1. **The app.** The user installs cashU.app into `/Applications` (the published app, or a build of the
   cashU source made by whoever maintains their copy) and opens it. Do not copy or move the app
   yourself. An app built and signed only ad hoc opens on the Mac that built it; on another Mac macOS
   blocks it until the user confirms it in System Settings > Privacy & Security > "Open Anyway".
2. **First launch.** The profile wizard opens (step 3). If the user used the older Python cashU app
   on this Mac, the app first shows the old-data screen: it never opens or changes the old data and
   offers a prompt for you plus "Continue without the old data", which leads to the wizard. The old
   data comes over later through `/import-builder`, section "Old cashU (Python) data".
3. **The `cashu` command.** Every start of the app writes a launcher into the data dir. The user adds
   an alias in their own terminal:

   ```bash
   alias cashu="$HOME/Library/Application Support/cashU/bin/cashu"
   cashu --help          # safe for you to run too: no personal data
   ```

   Before the app has run once the launcher does not exist yet; the app's own binary works then:
   `ELECTRON_RUN_AS_NODE=1 /Applications/cashU.app/Contents/MacOS/cashU /Applications/cashU.app/Contents/Resources/shim.mjs --help`.
   In a profile workspace, its `CLAUDE.md` names the exact command for this install.
   **Language.** Ask once whether the owner wants cashU in Polish or English and pin it with
   `cashu language pl` (or `en`; `system` follows macOS again; no argument shows the current one).
   One choice for the app window, the background texts and you: the cashU MCP server names it at the
   start of each session, so talk and write in it from then on. Settings > App > Language is the
   same switch.
4. Optional for categorization: **Ollama** (`brew install ollama`), see step 7.

## Step 10 - Finish

The user walks the app: the overview (net worth per currency), the budget page (spending, cashflow,
subscriptions, month close) and Settings. Do not take screenshots of real data yourself.

If the user keeps statements inside a git repository (for example a copy of the cashU source), check
that they cannot be committed (prints nothing when all is well; run it in that repository):

```bash
for p in data/x.db statements/mbank/x.csv .env key.pem; do git check-ignore -q "$p" || echo "NOT IGNORED: $p"; done
```

Any `NOT IGNORED` line: stop and fix `.gitignore` before the user commits anything. A workspace
outside any git repository needs no check.
