# Releasing cashU.app (owner only)

A release goes to every installed native cashU.app: the app reads its update feed from the latest GitHub
release of `Utopia-USS/cashu` and installs a newer version in place when the user clicks "Aktualizuj" /
"Update". Installed apps check that feed on their own about 90 s after launch and then once a day
(Settings > Aplikacja > "Sprawdzaj codziennie", on by default), show a found version in the update card
and download nothing before "Aktualizuj". The same release also tells the retired Python cashU.app that the native app exists. This page
is the owner's procedure; the contract inside the app (Team ID, feed, install sequence) is
[agents/s47-update-operator.md](agents/s47-update-operator.md).

Two ways to release, both producing the same 7 assets:

| Path | When | Who signs |
|---|---|---|
| **Default: CI** - merge `staging` -> `main`, approve the `release` environment | every release once the one-time CI setup below is done | `.github/workflows/release-macos.yml` on a GitHub macOS runner, from the `release` environment's secrets |
| **Fallback: local** - `node apps/desktop/scripts/release-macos.mjs` | CI not set up yet, or a CI run failed | the owner's Mac, from the login keychain |

## Default path: merge, bump, approve

1. **Merge the `staging -> main` pull request.** Every push to `staging` opens or updates it
   (`staging-to-main-pr.yml`); pushing to `staging` releases nothing.
2. **Bump version** (`bump-version.yml`) runs on the push to `main` and calls
   `apps/desktop/scripts/bump-version.mjs --since <main before the push>`. The version is `version` in
   `apps/desktop/package.json`:
   - patch by default (`0.5.0` -> `0.5.1`);
   - `[minor]` or `[major]` in any pushed commit message (the merge commit or a commit it brings in)
     raises that part instead (`0.5.3` -> `0.6.0`);
   - `[skip bump]` in a pushed commit message, or a push that changed the version by hand, keeps the
     version as it is. The hand-change check runs first, so `[minor]` / `[major]` have no effect then.
   - The bump is its own commit, `Bump version to X.Y.Z [skip ci]`, pushed by `github-actions[bot]`.

   **The first native merge ships 0.5.0 as is.** Before that merge `main` holds the Python app, which has
   no `apps/desktop/package.json`; the script counts a manifest that is new in the push as a hand-set
   version and skips the bump (`skip: the push changed the version by hand (null -> 0.5.0)`). The merge
   commit needs no marker; do not add `[minor]` / `[major]` expecting them to apply. To ship another
   version first, set it by hand in `apps/desktop/package.json` before the merge.
3. **Release macOS** (`release-macos.yml`) starts when Bump version succeeds. Its first job picks the
   release commit: the bump commit right after the merged commit (or the merged commit itself when the
   bump was skipped, as on the first merge), never `main`'s tip, which may already hold a later merge.
   A version whose tag exists ends the run with a notice.
4. **Approve.** The release job waits for the `release` environment: GitHub > Actions > the "Release
   macOS" run > "Review deployments" > tick `release` > "Approve and deploy". Only the environment holds
   the signing secrets, so nothing is signed before the approval.
5. The job builds arm64 and x64 on one runner, signs with the Developer ID from a temporary keychain,
   notarizes with the App Store Connect API key, staples, verifies every artifact (codesign, Gatekeeper,
   stapler, arch, version, no test-build marker), writes `latest-mac.yml` and the two appcasts, creates a
   **draft**, checks that it carries exactly the 7 assets, then publishes it as the latest release (which
   creates the tag `vX.Y.Z`). The temporary keychain and the key file are removed in an `always()` step.

Watching from a terminal (read-only):

```bash
gh run list --repo Utopia-USS/cashu --workflow release-macos.yml --limit 5
gh run watch <run id> --repo Utopia-USS/cashu
gh release view v<X.Y.Z> --repo Utopia-USS/cashu
```

Concurrency: one release runs at a time and GitHub keeps one pending run. A third merge in quick
succession cancels the pending middle run; its changes ship with the next release under a higher
version.

### Release notes

The release text is the commit subjects since the previous `v*` tag (at most 40, version bumps left out,
with a compare link). **Above 50 commits a hand-written text is required**: put it at
`docs/releases/v<X.Y.Z>.md` in the merge, named after the version the release will ship, that is the
version **after** the bump (main at 0.5.3, a plain merge -> `v0.5.4.md`; with `[minor]` -> `v0.6.0.md`).
The workflow passes that file as `--notes` when it exists; without it a release above 50 commits stops
before publishing.

The first native release has about 720 commits since `v0.4.2`, so it needs
[releases/v0.5.0.md](releases/v0.5.0.md). If the first release ships another version (a hand-set one),
rename the file to `docs/releases/v<that version>.md` in the same merge. Short PL + EN text, no commit
dump.

## One-time setup for the CI release (owner)

Nobody but the owner runs these. Never paste a secret value on screen, into the chat or into a file in
the repo: every `gh secret set` below reads stdin (a pipe, or a hidden prompt).

1. **Developer ID as a .p12.** Keychain Access > login keychain > My Certificates > "Developer ID
   Application: Utopia Ultimate Software Solutions Sp. z o.o. (29W838VKU4)". Expand it: the private key
   must be under it. Select the certificate > File > Export Items... > format "Personal Information
   Exchange (.p12)" > save as `~/Desktop/cashu-devid.p12` > set a strong export password (keep it in the
   password manager) > allow with the login keychain password.
2. **App Store Connect API key (notarization).** App Store Connect > Users and Access > Integrations >
   App Store Connect API > Team Keys > "+" (Generate API Key). Name "cashU CI notarization", Access
   "Developer" (the lowest role that can notarize). Download `AuthKey_<KEYID>.p8` (downloadable once;
   keep a copy in the password manager). Note the Key ID (10 characters, in the list) and the Issuer ID
   (the UUID above the list). Only the Account Holder or an Admin can create team keys; the first time the
   Account Holder may have to "Request Access" to the API.
3. **The `release` environment with the owner as required reviewer.** github.com/Utopia-USS/cashu >
   Settings > Environments > New environment `release` > Required reviewers: `j8000` (leave "Prevent
   self-review" off: the owner approves his own release) > Deployment branches and tags: "Selected
   branches and tags" > Add rule `main` > Save. The `gh` equivalent (j8000 = user id 22944806):

   ```bash
   gh api -X PUT repos/Utopia-USS/cashu/environments/release --input - <<'JSON'
   {"reviewers":[{"type":"User","id":22944806}],"prevent_self_review":false,
    "deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}
   JSON
   gh api -X POST repos/Utopia-USS/cashu/environments/release/deployment-branch-policies -f name=main -f type=branch
   ```

4. **The five environment secrets** (from the files of steps 1 and 2):

   ```bash
   base64 -i ~/Desktop/cashu-devid.p12 | gh secret set MACOS_CERT_P12_BASE64 --repo Utopia-USS/cashu --env release
   gh secret set MACOS_CERT_PASSWORD --repo Utopia-USS/cashu --env release      # prompt: the p12 export password
   base64 -i ~/Downloads/AuthKey_<KEYID>.p8 | gh secret set ASC_API_KEY_P8_BASE64 --repo Utopia-USS/cashu --env release
   gh secret set ASC_API_KEY_ID --repo Utopia-USS/cashu --env release           # prompt: the Key ID
   gh secret set ASC_API_ISSUER_ID --repo Utopia-USS/cashu --env release        # prompt: the Issuer ID
   gh secret list --repo Utopia-USS/cashu --env release                         # names only: expect the 5
   ```

   Then delete `~/Desktop/cashu-devid.p12` and the downloaded `.p8` (the copies live in the password
   manager). A run with a missing secret fails in its first step, naming the missing ones, before any
   build.
5. **Blocker: the tag ruleset.** The ruleset "Release tags (v*): admins only" lets only the admin role
   create `v*` tags. The workflow's `GITHUB_TOKEN` (github-actions) is not an admin, so publishing (draft
   -> published creates the tag) is refused; the run then fails with a complete, checked draft left on
   GitHub. Choose one:
   - **a) A GitHub App on the ruleset's bypass list (recommended).** An app owned by Utopia-USS, installed
     on this repository only, permission Contents: read and write; add it to the ruleset's bypass list; the
     workflow mints a short-lived token with `actions/create-github-app-token` (GitHub-owned, so the
     Actions policy allows it) from two more `release` secrets (app ID, private key). Why this one: the
     token is not a person's, lives one hour, is scoped to one repository and one permission, never
     expires as a credential the owner must remember to renew, and the ruleset stays "admins only" for
     every human.
   - b) A fine-grained PAT of an admin (this repository only, Contents: read and write, with an expiry) as a
     sixth `release` secret used as `GH_TOKEN`. Simplest, but it acts as that admin and expires.
   - c) Keep it: CI drafts, the owner publishes the checked draft by hand:
     `gh release edit v<X.Y.Z> --repo Utopia-USS/cashu --draft=false --latest`.

   The workflow uses `GITHUB_TOKEN` today; a) or b) is a few-line change in `release-macos.yml`.
6. **Actions policy.** The repository allows GitHub-owned actions only. Every workflow uses only pinned
   `actions/checkout` and `actions/setup-node` and installs pnpm through Corepack, so nothing else is
   needed.
7. **First proof of the signed CI path.** Once the workflow is on `main`: Actions > Release macOS > Run
   workflow (branch `main`) with "dry_run" ticked > approve in the `release` environment. Expected: both
   arches signed from the temporary keychain, notarized with the API key, verified, 7 assets, nothing
   published. A possible first-run failure: the runner does not trust the Developer ID G2 intermediate for
   the imported p12 (the keychain step fails with a clear message).

## Fallback: the local release script

On the owner's Mac, in the native checkout (today `~/IdeaProjects/cashu-next`; any checkout whose
`git remote get-url origin` is `Utopia-USS/cashu` and that has `apps/desktop/scripts/release-macos.mjs`).
Never create a worktree or a second checkout for it: the script builds a `git archive` export of
`origin/main` in a fresh directory under `$TMPDIR` and leaves the checkout's branch and uncommitted work
alone. Artifacts land in `build/release/v<X.Y.Z>/` of the checkout.

| Mode | What it does |
|---|---|
| `--check` | preflight only: tools, `gh` logged in as an admin of the repository, the Developer ID identity in the keychain and usable by codesign without a dialog, the notarytool profile `cashu-notary`, the version (above the newest release, the newest `v*` tag and 0.4.6, no release or tag of it yet) and the commits since the previous tag |
| `--dry-run` | + export, `pnpm install`, build both arches, sign, notarize, staple, verify every artifact independently, write the feeds and the release text; nothing is uploaded (`--ref <rev>` builds another commit) |
| `--yes` | + draft, check the 7 assets, publish as latest (creates the tag; the owner's admin role passes the ruleset). Always `origin/main`; stops when `origin/main` moved during the build; above 50 commits it needs `--notes docs/releases/v<X.Y.Z>.md` |

```bash
node apps/desktop/scripts/release-macos.mjs --check
node apps/desktop/scripts/release-macos.mjs --dry-run
node apps/desktop/scripts/release-macos.mjs --yes --notes docs/releases/v<X.Y.Z>.md
```

A full dry run takes about 20 minutes (four notarizations). One-time prerequisites: the Developer ID
identity in the login keychain with codesign allowed ("Always Allow" on the first keychain dialog), the
notarytool profile (`xcrun notarytool store-credentials cashu-notary --key <AuthKey.p8> --key-id <id>
--issuer <issuer id>`), `gh auth login` as an admin, Node 22 with pnpm through Corepack, Xcode command
line tools. The script reads no secret itself: codesign and notarytool read the keychain.

If a CI run already left a draft of the same version, `--yes` refuses (the release exists): publish or
delete that draft first.

## What a release contains

Seven assets, all of the same version:

| Asset | Read by |
|---|---|
| `cashU-<v>-mac-arm64.zip`, `cashU-<v>-mac-x64.zip` | the native app's updater (the zip holds the stapled app) |
| `cashU-<v>-mac-arm64.dmg`, `cashU-<v>-mac-x64.dmg` | people downloading the app by hand |
| `latest-mac.yml` | the native app's updater (electron-updater): both zips with size and sha512 |
| `appcast-macos-arm64.xml`, `appcast-macos-x86_64.xml` | the retired Python app's Sparkle (it builds the name from `uname -m`, hence `x86_64`) |

Separate arches, not universal: half the download, and the native modules are built per arch. One
`latest-mac.yml` lists both zips; electron-updater picks the file with `arm64` in its name on Apple
silicon and drops it on Intel, so the Intel zip name must never contain `arm64`.

Continuity rules (break one and installed apps stop updating; everyone reinstalls by hand):

- **The feed is pinned** in `apps/desktop/src/update/releasePolicy.ts`:
  `https://github.com/Utopia-USS/cashu/releases/latest/download/`. Every app resolves the newest release
  through GitHub's "latest", so the newest native release must always be the one marked latest; never mark
  another release latest, never rename or move the repository without a bridge release.
- **One Team ID**: `RELEASE_TEAM_ID` `29W838VKU4`. The updater installs only a build signed by the same
  Developer ID team (Squirrel checks the designated requirement). A new certificate of the same team is
  fine; another team is not.
- **One bundle ID**: `io.utopiasoft.cashu` (the same as the Python app, so its macOS settings carry over).
- **Releases are immutable**: a bad release is fixed by a newer one, never by deleting or re-tagging.

## Python users

The Python app (last published release 0.4.2; a 0.4.6 draft was never published) checks
`releases/latest/download/appcast-macos-<uname -m>.xml` daily and on "Sprawdź aktualizacje…". Each native
release carries an informational item there: Sparkle never downloads it.

1. The Python dashboard shows the card "Nowa wersja 0.5.0 - github.com/Utopia-USS/cashu/releases" /
   "New version 0.5.0 - github.com/Utopia-USS/cashu/releases", with "Masz 0.4.2" / "You have 0.4.2".
   "Aktualizuj" / "Update" only closes the card; "Pomiń" / "Skip" hides that version. The card shows no
   link or notes (the old app ignores them), so the address is in the title.
2. The user downloads the dmg for their Mac from the release page, quits the Python app and drags the
   native cashU.app over the old one in `/Applications`.
3. On the first start the native app finds the Python data and shows the old-data screen: "Kopiuj
   prompt dla agenta" / "Copy prompt for agent" gives the user's agent the steps (import-builder skill,
   "Old cashU (Python) data"), and "Kontynuuj bez starych danych" / "Continue without the old data"
   goes on to first-run setup. The app never opens, moves or changes the Python files.
4. The Python background worker (`io.utopiasoft.cashu.worker`, legacy
   `io.github.synszakala.finanse.worker`) keeps running until the user removes it; the app does not
   touch launchd for it. An old `cashu-<profile>` MCP entry in Claude Code is replaced by the setup
   screen's `claude mcp add` line (after `claude mcp remove cashu-<profile>`).

## Staging build (owner's local test app)

`cashU Staging` is a separate app for trying `staging` on the owner's Mac next to the real cashU.app:
bundle `io.utopiasoft.cashu.staging`, data dir `~/Library/Application Support/cashU Staging`, workspaces
`~/Documents/cashU Staging`. It shares nothing with cashU.app: it starts with an empty data dir and the
profile wizard, never looks at the Python data or the Python agents, and keeps its own keychain items.
Two things stay shared on purpose: the Enable Banking redirect `https://127.0.0.1:18888` (registered with
Enable Banking), so do not run a bank connection in both apps at the same moment; and the MCP name prefix,
so a prod profile slug starting with `staging-` would clash with a staging MCP name. The LAN pairing port
is per app (8517 prod, 8518 staging), so the two can later pair as two devices.


```bash
node apps/desktop/scripts/package-macos.mjs arm64 --flavor staging
```

- Signed ad hoc, no update feed: the updater reports updates unavailable; a newer staging build is built
  and installed again by hand.
- Output: `build/staging/electron-builder/mac-arm64/cashU Staging.app` and
  `build/staging/cashU-Staging-<version>-mac-arm64.zip`. The owner installs it once to
  `/Applications/cashU Staging.app` (an agent never copies it there without the owner's go).
- Known ad hoc side effect: every rebuild has a new code signature, so macOS may ask again for Keychain
  or Documents access after each rebuild. Allow it for `cashU Staging`.
- Never released: the release script and CI build the production flavor only.

## Evidence boundary

Proven before the first release (2026-11-07):

- A full local dry run of the release script (both arches signed, notarized and stapled, all four
  notarizations Accepted, `latest-mac.yml` parsed with electron-updater's own parser, both appcasts
  checked) and the script's CI mode locally (unsigned, 7 assets, clean tree afterwards).
- Update in place: a Developer ID signed test build 0.5.0 updated itself to 0.5.1 from a two-zip
  `latest-mac.yml` (arm64 zip picked), relaunched, vault and profile intact.
- The Python side: an ad hoc Python 0.4.6 proof build received the informational item, showed the card in
  PL and EN, "Update" only dismissed it and nothing was downloaded (0.4.2 has the same updater code).
- The import with agent retirement and the MCP lines, on synthetic data (desktop e2e), and a real
  `launchctl bootout` of a throwaway label.

Not proven until it happens:

- The signed CI path (temporary keychain, API-key notarization, publishing with the workflow's token):
  until the first CI dry run or release (setup step 7).
- Retiring the real Python agent labels on a real install (only a throwaway label was booted out).
- The Intel feed end to end on an Intel Mac (the x64 build is signed, notarized and verified; its update
  was not run).
- Notarization of the final tree: the last full dry run with notarization ran at an earlier commit of the
  same release work (all four Accepted); the final tree was signed and verified with the Developer ID and
  smoke-tested (first run of the release build on a temp data dir: profile wizard, no keychain item, no
  network request; a signed test build imported synthetic Python data end to end, retired both synthetic
  Python agents and showed the MCP lines), but not notarized again. Run `--dry-run` once before the first
  release.
