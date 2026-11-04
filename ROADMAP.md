# cashU roadmap

Where cashU is heading as an open-source project. Sizes are rough: S = under a day, M = 1-3 days,
L = a week or more. "Owner" marks a decision or an account only the maintainers can make.

## Direction

- **The core is a platform, not a list of banks.** cashU owns the formats (`cashu-import`,
  `cashu-budget-import`), deduplication, transfers, categorization, the API and the MCP server, and
  the connector runtime. Banks, brokers and exchanges are connectors: written by the user's own agent
  in their workspace (the `import-builder` skill), or taken from the community catalog in
  [`connectors/`](connectors/). No new bank parsers go into the core.
- **One download per system.** The final release has a download page with one button per system
  (macOS, Windows, Linux), and every installed app updates itself.
- **Connectors run sandboxed everywhere,** with the same rules on every system: read only the
  connector and its run folder, write only the run folder, network only to the manifest's hosts
  through the app's proxy.

## Done (November 2026)

- The native desktop app (Electron shell + a TypeScript local host with encrypted per-profile vaults,
  the `cashu` CLI and the MCP server) replaced the Python app; an existing install moves over once
  with `cashu migrate` ([docs/migration-runbook.md](docs/migration-runbook.md)). Python survives only
  as the frozen parity oracle under `parity/python/` (never shipped).

## Done (October 2026, Python app)

- CI on every pull request (Linux and macOS required, Windows informational), contributor docs,
  security policy, issue and PR templates.
- Data fixes in the budget: reclassification never overwrites the owner's decisions, Open Banking
  accepts any bank Enable Banking supports, whole-word seed rules.
- Connectors on macOS end to end from the downloaded app: Deno/TypeScript as the default language,
  Deno 2.9.1 bundled and pinned, the module-graph import rule, the MCP `test_connector` tool.
- The community catalog `connectors/` shipped with the app; installing an entry always waits for the
  owner's approval.
- File connectors on Linux: Landlock + seccomp, verified on a real kernel in CI (Python app; not yet
  ported to the native runtime, see Next).
- Catalog twins of the mBank, Erste and Pekao CSV parsers with equivalence tests.
- Dev safety: a checkout's `.env.dev` (also read by its git worktrees) keeps development off the
  real data dir.

## Next

1. **Download page (S).** GitHub Pages with one button per system that links to
   `releases/latest/download/<file>`; the release publishes stable file names without the version
   (`cashU-macos-arm64.dmg`, `cashU-windows-x64-setup.exe`, `cashU-linux-x86_64.AppImage`). The page
   detects the visitor's system and shows "coming soon" for systems without a build yet.
2. **Linux app (about 1 week).**
   - AppImage from electron-builder, built in GitHub Actions on Ubuntu 22.04 (older glibc, wider
     reach); the host and the CLI already run on Linux.
   - Updates: electron-updater's AppImage support from GitHub releases.
   - Connectors: port the Landlock + seccomp layer to the native runtime
     (`docs/agents/connector-sandbox-platforms.md`); until then connectors are refused on Linux.
   - Flatpak only after checking that its own sandbox lets our Landlock and namespaces through.
3. **Windows app (about 2-3 weeks with the connector sandbox, 1.5 without).**
   - Port: the host's data dir, keychain and service paths on Windows (`apps/cli/src/dataDir.ts`
     refuses Windows today), the worker through Task Scheduler, the `cashu` shim for MCP stdio.
   - Build in GitHub Actions with electron-builder, a per-user installer (no admin rights).
   - Code signing (Owner), so SmartScreen does not block the download. Preferred: SignPath Foundation
     (free for open source); fallback: Azure Trusted Signing on the company (about 10 USD a month);
     a classic OV certificate needs a hardware token and is hard to use from CI. Until then the page
     explains "More info" > "Run anyway".
   - Updates: electron-updater (NSIS) from the same release feed.
   - Connectors: AppContainer + Job Object for file connectors without admin rights
     (`docs/agents/connector-sandbox-platforms.md`); until then connectors are off on Windows.
4. **Switch the budget import to the catalog bank connectors (M).** After the owner checks real
   exports with `test_connector` (re-importing an already imported file must show 0 new rows), make
   the catalog connectors the default and remove the built-in parsers from the core. Known
   differences: the newest-day rule (a gap inside the stored history can no longer be filled from a
   bank CSV), references cut to 200 characters, files with amounts of more than 2 decimals refused.

## Later

- **Fetch connectors on Linux (M):** a network namespace with a relay that forces every connection
  through the egress proxy; today Linux runs file connectors only.
- **Fetch connectors on Windows (M):** an AppContainer loopback exemption (needs an elevated
  installer) or a proxy helper inside the container.
- **Narrower sandbox for approved runs on macOS (S):** reuse the read rules of `test_connector`
  (Intel Homebrew under `/usr/local` needs its own rule first).
- **Approval view shows where a connector came from (S):** catalog, the agent or the CLI, so an
  agent's connector with a catalog id cannot pass as catalog code.
- **User categories and rules (L):** own categories and phrase / pattern rules instead of the closed
  list in `packages/domain/src/budget/categorize/taxonomy.ts`.
- **Recurring payments beyond monthly (M):** weekly and yearly cadences, configurable thresholds.
- **Loans (L):** variable rates (WIBOR periods), equal-principal installments, overpayments.
- **Module boundaries (M):** route the remaining cross-module calls (core connectors to budget and
  investments, loans reading budget views) through `ModuleSpec` hooks.
