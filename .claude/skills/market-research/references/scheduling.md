# Scheduling the Saturday routine (local, approved by the user)

The routine runs on the user's Mac, inside the profile's agent workspace (default
`~/Documents/finanse/<slug>/`; the app shows the path in Ustawienia > Agent AI, the CLI prints it with
`finanse workspace path`). It has to be local: the finanse MCP server reads the profile's database on
this Mac, and the workspace's `.mcp.json` and `.claude/settings.json` (data only through MCP, reads of
the data dir denied) apply only to runs in that folder. The finanse app only explains the schedule;
Claude Code owns it; the app never starts Claude itself.

**Never create a schedule silently.** Show the user the exact plan (where, when, what runs, with which
permissions), wait for an explicit yes in the chat, and only then create it (option A) or hand the
user the steps to create it themselves (option B). A research run never creates or changes a
schedule as a side effect.

Not suitable, even if a screen or an older note suggests them:

- `/schedule` in the CLI creates **cloud** routines: they run on Anthropic's infrastructure on a fresh
  clone, cannot reach the local finanse MCP server or the database, and so cannot write notes.
- `/loop` runs only while a session stays open.

## Option A (recommended): a local routine in the Claude desktop app

Requirements: the Claude desktop app (Claude Code, a version with local routines), the app running and
the Mac awake on Saturday morning.

Steps for the user (Polish UI copy may differ slightly):

1. In the Claude app open the **Code** tab, click **Routines** (sidebar, or the sidebar's **More** menu),
   then **New routine** and choose **Local**.
2. Fill in:
   - **Name:** `finanse-research-<slug>`
   - **Description:** `Research tygodniowy finanse (profil <slug>)`
   - **Instructions:** `/market-research rutyna` (`rutyna` marks the run as scheduled in the app)
   - **Folder:** the profile's workspace path (the app asks to trust the folder once); no isolated
     worktree (it is not a code repository).
   - **Permission mode:** the default mode that asks; not a mode that skips permission checks.
   - **Schedule:** **Weekly**, **Saturday**, **07:00**.
3. Save, then click **Run now** once and watch it: for each permission prompt choose "always allow"
   for the finanse server's tools, `WebSearch`, `WebFetch` and writing files under `research/`. Never
   allow reads of the finanse data dir, the database or exports (the workspace denies them anyway).
   Later Saturday runs then go through without stopping; a prompt nobody answers stalls the run until
   the user opens it under **Scheduled** in the sidebar.
4. Optional: **Settings > This computer > System > Keep computer awake**. If the Mac sleeps through 07:00
   the run is skipped and one catch-up run starts when the app opens or the Mac wakes (within seven
   days), so a Saturday miss usually still lands before the Sunday review.

If you (Claude) are in a desktop session that offers a scheduled-task tool and the user asks you to
set it up: show the plan above with the real slug and path, ask `Czy mam utworzyć to zadanie?`, and
create it only after an explicit yes. Then tell the user to do step 3 (the first manual run).

## Option B: launchd and headless `claude -p` (terminal users)

For users who run Claude Code in the terminal without the desktop app. The user creates and loads the
LaunchAgent in their own terminal; you show the file and the commands and do not write into
`~/Library/LaunchAgents` or call `launchctl` yourself.

`~/Library/LaunchAgents/local.finanse-research.<slug>.plist` (replace `<slug>` and the path):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>local.finanse-research.<slug></string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>cd "$HOME/Documents/finanse/<slug>" &amp;&amp; claude -p "/market-research rutyna" &gt;&gt; research/routine.log 2&gt;&amp;1</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Weekday</key>
    <integer>6</integer>
    <key>Hour</key>
    <integer>7</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
</dict>
</plist>
```

Commands for the user's terminal:

```bash
plutil -lint ~/Library/LaunchAgents/local.finanse-research.<slug>.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.finanse-research.<slug>.plist
launchctl kickstart gui/$(id -u)/local.finanse-research.<slug>    # one test run now
# remove the schedule later:
launchctl bootout gui/$(id -u)/local.finanse-research.<slug>
```

Notes to give with it:

- `Weekday 6` is Saturday in launchd (0 and 7 are Sunday). A login shell (`-lc`) lets launchd find
  `claude`; otherwise put the absolute path from `which claude`.
- A headless run cannot answer permission prompts: everything the routine needs must be allowed in
  the workspace's `.claude/settings.json`. The workspace already allows the finanse server's tools
  (`Aktualizuj workspace` in the app, or `finanse workspace update`, refreshes them). Web access and
  the working files are the user's decision: with their yes, they add to `permissions.allow` in that
  file (finanse keeps the user's own rules on every update):

  ```json
  "WebSearch", "WebFetch", "Edit(./research/**)"
  ```

  Never add rules that open the data dir, the database or the inbox. The test run (`kickstart`) shows
  whether anything is missing: read `research/routine.log`.
- The run uses the user's own Claude Code login on this Mac; if the test run cannot authenticate,
  option A is the simpler path.
- If the Mac sleeps at 07:00, launchd starts the job once when it wakes.

## After scheduling

- The app shows each run in Inwestycje > Research (`Przebiegi`) and in Ustawienia > Agent AI; it does
  not know the schedule itself, it only sees runs.
- Pausing or removing: option A in the routine's detail page (Status, Delete); option B with the
  `bootout` command above.
- Running once by hand at any time: `cd <workspace> && claude -p "/market-research"`, or
  `/market-research` in an interactive session in the workspace.
