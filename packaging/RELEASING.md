# Releasing cashU.app (owner only, from your Mac)

A release goes to every installed cashU.app: Sparkle installs it when the user clicks "Aktualizuj" in the
dashboard (`desktop/updater.py`). The whole release happens on the owner's Mac (`scripts/release_macos.sh`, or
the personal `cashu-release` Claude Code skill). CI never sees a signing key.

## What protects what

| Secret | Where it lives | If it leaks | If it is lost |
|---|---|---|---|
| Sparkle update key (EdDSA private key) | login keychain + an offline backup | together with a Developer ID signature, an attacker could ship an update | installed apps can never update again; everyone reinstalls by hand |
| Developer ID Application certificate | login keychain | anyone can sign any app in your name; Apple revokes it | request a new one (installed apps keep working) |
| Notarization credentials (App Store Connect API key) | a notarytool keychain profile | someone could notarize their builds | create a new key |

Sparkle installs an update only with **both** signatures: the EdDSA signature of the release key, and a
Developer ID signature of the same team as the installed app. Neither is ever written to a file in the repo.
`packaging/release.local.env` holds names and the *public* key only, and it is git-ignored. The release script
refuses to run otherwise.

GitHub settings of `Utopia-USS/cashu`, set on 2026-10-30:

- Release tags `v*` can be created, moved or deleted only by repository admins (ruleset).
- Releases are immutable: once published, their files and tag cannot change.
- `main` cannot be force-pushed or deleted (ruleset).
- Secret scanning with push protection: a push that contains a recognised key or token is refused.
- Actions: the default token is read-only, workflows cannot approve PRs, only GitHub's own actions run, and
  every outside contributor's PR needs approval before its workflows run.

Repository admins today are j8000, SynSzakala and pawuload, so all three can create a release tag. None of
them can ship an update without the Sparkle key, but consider making the other two "maintain" instead of
"admin" if they do not need it.

## One-time setup

Releases start **ad-hoc** (no Developer ID yet, see "Ad-hoc until the Developer ID" below). For those you
need steps 3-6 only. Steps 1 and 2 come when Utopia's Account Holder has issued the certificate.

**1. Developer ID certificate (later)**

cashU is signed by **Utopia's Apple team** (the bundle id is `io.utopiasoft.cashu`), with a Developer ID
Application certificate **only for cashU**. Do not reuse one that other Utopia apps are signed with: if it
ever has to be revoked, only cashU is affected.

Only the Account Holder can create Developer ID certificates. Xcode's Manage Certificates does not offer
them to an Admin. The private key is still made on your Mac, so it never travels:

1. On your Mac, open Keychain Access:

   ```bash
   open "/System/Library/CoreServices/Applications/Keychain Access.app"
   ```

   Select the **login** keychain, not iCloud, so that the key is not synced anywhere. Then go to Keychain
   Access > Certificate Assistant > Request a Certificate From a Certificate Authority. Enter your e-mail,
   Common Name `cashU Developer ID`, an empty CA e-mail, choose "Saved to disk", and save the
   `.certSigningRequest`.
2. Send that file to the Account Holder. It is not secret.
3. The Account Holder goes to developer.apple.com > Certificates > + > Developer ID Application (G2 Sub-CA),
   uploads your file and sends back the `.cer`.
4. Double-click the `.cer`. It joins your private key in the login keychain. Check:

   ```bash
   security find-identity -v -p codesigning
   ```

   You should see `"Developer ID Application: Utopia Ultimate Software Solutions Sp. z o.o. (<TEAMID>)"`.

Never accept a `.p12` (certificate with a private key made elsewhere), and never export yours. A second Mac
gets a certificate of its own.

**2. Notarization profile (later, with step 1)**

In Utopia's App Store Connect > Users and Access > Integrations > Team Keys, create a key named
"cashU notarization" with the "Developer" role (the lowest role that can notarize). Creating it needs the
Admin or Account Holder role. Download `AuthKey_<id>.p8`; you can download it only once. Then:

```bash
xcrun notarytool store-credentials cashu-notary --key ~/Downloads/AuthKey_<id>.p8 --key-id <id> --issuer <issuer id>
```

Move the `.p8` file into your password manager and delete it from Downloads. The keychain profile is all the
script needs.

**3. Sparkle update key**

Generate the key into your login keychain. `generate_keys` prints the public key:

```bash
scripts/fetch_sparkle.sh build/release/sparkle
```

```bash
build/release/sparkle/bin/generate_keys
```

Back it up offline, then delete the export:

```bash
build/release/sparkle/bin/generate_keys -x ~/Desktop/cashu-sparkle-key
```

Put that file into your password manager (as a document), then remove it:

```bash
rm ~/Desktop/cashu-sparkle-key
```

Do this yourself, not through an agent: the backup is the only time the private key leaves the keychain.

**4. Local config**

```bash
cp packaging/release.env.example packaging/release.local.env
```

Fill in the public key from step 3. Print it again at any time with
`build/release/sparkle/bin/generate_keys -p`. Leave `DEVELOPER_ID_APPLICATION` and `NOTARY_KEYCHAIN_PROFILE`
empty until steps 1 and 2 are done, then set both.

**5. GitHub CLI**

Log in as your admin account:

```bash
gh auth status
```

**6. Check everything**

```bash
scripts/release_macos.sh --check
```

Every line should say `ok`, followed by the list of commits the next release would ship. Nothing is built.

## The first release (bootstrapping)

The apps installed today have no updater, so the first Sparkle-enabled version is installed by hand, once,
on every Mac.

1. Merge the auto-update work into `main`.
2. Build it without publishing:

   ```bash
   scripts/release_macos.sh --no-publish
   ```

   The script builds `origin/main` in a temporary worktree and signs it (Developer ID and notarization, or
   ad-hoc). Then it signs the update. macOS may ask for keychain access; click "Allow".
3. Try `build/release/macos/cashU-<version>-macos-arm64.dmg` yourself: quit cashU, drag the app over
   `/Applications/cashU.app`, open it. Settings > Aplikacja shows "Aktualizacje".
4. Publish:

   ```bash
   scripts/release_macos.sh --yes
   ```

   Everyone else, Martyna included, downloads the DMG from that GitHub release and installs it by hand, once.

## Ad-hoc until the Developer ID

Until steps 1 and 2 are done, releases are ad-hoc signed and not notarized. Updates are just as protected,
because Sparkle installs nothing without the update key's signature. Two things differ for the people
installing it:

- **The first install on a Mac** is blocked by Gatekeeper ("cannot verify the developer"). Open the app once,
  then go to System Settings > Privacy & Security, click "Open Anyway" next to cashU, and confirm. Updates
  that Sparkle installs later open normally.
- **Keychain prompts after an update**: an ad-hoc signature changes with every build, so macOS asks once
  more whether cashU may use its saved keys (Anthropic, Enable Banking). Click "Always Allow". A Developer ID
  build keeps the same identity between versions and stops asking.

**Switching to the Developer ID** is one ordinary release. Do steps 1 and 2, set both values in
`packaging/release.local.env`, run `--check`, and release. Installed ad-hoc apps accept it because the update
key stays the same. Sparkle allows changing the code signature *or* the update key in one update, never both.

## Every later release

In Claude Code in your cashU checkout, say "wydaj cashU" (the `cashu-release` skill). It runs `--check`,
shows what ships and asks you before it publishes. By hand it is the same thing:

```bash
scripts/release_macos.sh --check
```

```bash
scripts/release_macos.sh --yes
```

- Your branch and uncommitted work do not matter: the release is always exactly `origin/main` at that moment.
- The version is the one in `pyproject.toml` on `main` (`bump-version.yml` raises it on every push).
- A version that already has a release is refused.
- Installed apps see it at their next daily check, or at once with "Sprawdź aktualizacje…" in the app menu.

## When something goes wrong

| Situation | What to do |
|---|---|
| `--check` fails | It names the step above to fix; nothing was built or published. |
| A build or notarization fails | Nothing was published. Fix it and run again (the temporary worktree is removed). |
| The script stops at the draft check | A draft release is left on GitHub. Delete it in the GitHub UI and run again. |
| A bad release is out | Sparkle never downgrades: fix on `main` and release the next version. Database migrations must survive a version that was out only briefly. |
| The Sparkle key may have leaked | Release one version signed with the old key that carries a new public key (rotation), then revoke the old one. Sparkle accepts one key change per update. |
| The Developer ID may have leaked | Revoke the cashU certificate at developer.apple.com (other Utopia apps keep theirs), create a new one, and release. The team stays the same, so installed apps accept it. |
| The certificate expires (every 5 years) | Create a new cashU certificate before that, as in step 1. Same team, so updates keep working. |
| The Sparkle key is lost | Restore it from the backup (`generate_keys -f <file>`). Without a backup, every Mac needs a new manual install. |
