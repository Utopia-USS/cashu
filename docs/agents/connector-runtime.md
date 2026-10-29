# Connector runtime across macOS, Linux and Windows (design spike)

Status: the spike below, then branch `connectors-deno` (R2 on macOS). Owner decisions: Deno is bundled
in the app (open question 1), signed with its own `allow-jit` entitlement (2), the MCP tool
`test_connector` exists (4), Deno / TypeScript is the default connector language and Python stays
allowed on macOS (5). Implemented: `DenoSandbox` always inside the macOS sandbox, never alone (a
security review showed that Deno alone lets static imports read outside `--allow-read` and raw sockets
to a manifest host bypass the egress proxy, so Linux / Windows stay `sandbox_unavailable` for every
interpreter until a native layer exists, hook: `default_sandbox` -> `sandbox_linux.native_sandbox()`);
the module-graph check (`deno info`, error kind `forbidden_import`, rule in `docs/connectors.md`
section 4); the bundled deno preferred by `resolve_interpreter`; the build step (version + sha256
pinned, the sha256 values still to be filled in, `packaging/README.md`); `test_connector`; the Deno
example `examples/connectors/deno-budget-example`; the import-builder skill. The rest of this document
is the spike as written; where it says Deno alone runs on Linux / Windows, that was changed as above.

Owner requirements this answers:

- **R1** cashU runs on macOS, Linux and Windows, connectors included.
- **R2** a connector written from scratch by the user's agent works with the app downloaded from the
  internet (no source checkout, no fork). The agent works in the profile workspace and talks to the app
  over MCP (`cashu mcp --profile <slug>`).
- **R3** the security model stays: only owner-approved, hash-pinned connectors run, out of process,
  sandboxed (read only the input file and the connector's own dir, write only the run dir, network only to
  the manifest hosts through the app's proxy), with timeouts.

Evidence was gathered on macOS 15 (Darwin 24.6, arm64) with Deno 2.9.1 (Homebrew). Linux and Windows
statements are from the code and from platform knowledge; nothing was run on those systems. `file:line`
references point at commit `e59ab57` (main before this spike); the prototype shifts a few lines in
`sandbox.py`, `runner.py` and `manifest.py`.

## Summary

1. **Today R1 and R2 both fail outside a developer's Mac.** Connectors run only on macOS
   (`sandbox.py:171`), the process layer is POSIX-only (`process.py`), interpreters are looked up on a
   POSIX search path (`manifest.py:52`), a fresh Mac has no usable `python3` (it needs the Command Line
   Tools), Windows has none at all, and the developer test loop is a CLI command the skill names as bare
   `cashu`, which is not on PATH in the packaged app.
2. **Deno meets R3 as an application-level sandbox** on every OS: with the flag set below, every probe
   (files outside the allow list, symlinks, env, subprocess, FFI, sys info, sockets, DNS, remote imports,
   config files, permission prompts) is refused with `NotCapable`, and `fetch` honours `HTTPS_PROXY`, so a
   fetch connector goes through the egress proxy and Deno additionally refuses any host not in the
   manifest. Cold start is 38-71 ms. On macOS it also runs unchanged inside the existing `sandbox-exec`
   profile, so the kernel layer stays.
3. **Recommendation:** ship a pinned Deno binary inside the app on all three OSes and make TypeScript /
   JavaScript on Deno the default connector language of the import-builder skill. Keep native layers
   where they are cheap: macOS `sandbox-exec` around Deno (done in the prototype), Linux Landlock (later),
   a Windows Job Object (needed anyway for timeouts and process-tree kill). Other interpreters stay
   macOS-only until a native Linux / Windows sandbox exists for them.
4. **Secrets are already cross-OS** (`keyring`); the work is build dependencies on Linux / Windows and a
   fail-closed message when no keyring backend exists.

## (a) R2 gap analysis: the agent in a packaged-app workspace today

The end-to-end path is write -> test -> install (`propose_connector`) -> owner approval -> run.

| Step | Today | Evidence |
| --- | --- | --- |
| Write | Works. The agent writes `connectors/<id>/` in the profile workspace. | `mcp/tools/connectors.py:25-37` (`checked_local_dir` under `<workspace>/connectors`) |
| Test | Only through the CLI `cashu connectors test`. The skill and the MCP tool description name bare `cashu`, which is not on PATH for a packaged app. The workspace `CLAUDE.md` does render the absolute binary (`/Applications/cashU.app/Contents/MacOS/cashu ...`) as the CLI "for commands the user runs in their own terminal", so an agent can find it, but nothing tells it to use that path for the test. On Windows the planned GUI exe has no usable stdio (a separate `cashu-cli.exe` is planned). There is no MCP test tool, by design: "MCP calls never run code". | `.claude/skills/import-builder/SKILL.md:128-132`, `mcp/tools/connectors.py:129-130`, `core/workspace/render.py:149`, `core/runtime.py:80-84`, `packaging/windows/cashu-windows.spec:9-15` |
| Install | `propose_connector` validates with `mf.load_dir`, which resolves `run[0]` to a real interpreter. When none is found the proposal is refused. | `mcp/tools/connectors.py:39`, `manifest.py:500-514` |
| Approve | Works on any OS (app UI, `service.approve` pins hash and interpreter path). | `service.py:571-590` |
| Run | macOS: `MacSandbox`. Everything else: `UnsupportedSandbox` -> outcome `refused`, `sandbox_unavailable`. The UI is told via `GET /api/system` `connectors.platform = "unsupported"`. | `sandbox.py:171-174`, `runner.py:232-235`, `core/api.py:122-126` |

Interpreter availability per OS (what a connector can rely on without the user installing anything):

| OS | `python3` | `node` / `deno` | Notes |
| --- | --- | --- | --- |
| macOS, fresh | `/usr/bin/python3` is an `xcrun` shim; without the Command Line Tools it only offers to install them. `resolve_interpreter` refuses it: "needs the Apple developer tools (xcode-select --install)". | absent | `manifest.py:59` (`XCRUN_SHIMS`), `manifest.py:439-445`. This machine: `/usr/bin/python3` is a 118,864-byte shim, the real one is `/Library/Developer/CommandLineTools/.../Python3.framework/Versions/3.9` (Python 3.9, hence the "write for 3.9" rule in `docs/connectors.md:101`). |
| macOS, developer | CLT or Homebrew python | Homebrew | the only setup that works today |
| Linux desktop | usually `/usr/bin/python3` (Debian / Ubuntu / Fedora ship it) | rarely | but no sandbox: every run is refused |
| Windows | none; `python3.exe` in `WindowsApps` is a Microsoft Store alias | none | the search path is POSIX-only (`manifest.py:52`), and `process.py` needs `/bin/sh`, `/usr/bin/env`, `os.killpg` |

Other R2 gaps found on the way:

- `process.py` is POSIX-only: the `ulimit` wrapper through `/bin/sh` and `/usr/bin/env -i`
  (`process.py:22-31`), `start_new_session` and `os.killpg` (`process.py:80`, `163-167`). Windows needs
  its own process backend.
- `cashu connectors test` run by an agent from inside Claude Code's own sandbox mode would nest
  `sandbox-exec`; not tested here (this session's `sandbox-exec` worked), worth a check before relying on
  it.
- The import-builder skill teaches Python first and the `./<file>` binary escape hatch; neither helps a
  user without developer tools.

Conclusion: with the app downloaded from the internet, a user on a fresh Mac, any Linux or any Windows
machine cannot get an agent-written connector to run. The single change that unblocks all three is an
interpreter the app ships itself, with a sandbox that works the same everywhere.

## (b) Deno evaluation

### Permission model against R3

Flags used by the prototype (`sandbox.py`, `DENO_FLAGS` and `deno_argv`):

```
deno run --no-config --no-lock --no-remote --no-npm --cached-only --deny-import --no-prompt --no-code-cache
         --allow-read=<connector dir>,<run dir> --allow-write=<run dir>
         [fetch only: --allow-net=<host1>:443,<host2>:443]
         <connector dir>/<script> [args...]
```

Environment (nothing inherited, `process.py` still does `env -i`): the existing `base_env` plus
`DENO_DIR=<run dir>/.deno`, `DENO_NO_UPDATE_CHECK=1`, `DENO_NO_PROMPT=1`, `NO_COLOR=1`. Deno's own
module cache therefore lives in the run dir and is deleted with it.

Probe results (a scratch experiment; most rows are also pytest cases in `tests/test_connectors_sandbox_deno.py`):

| Attempt | Result | R3 item |
| --- | --- | --- |
| read the input copy, read own dir, write the run dir | ok | allowed |
| read a file outside, `/etc/hosts`, list `/Users`, read the data dir | `NotCapable` | read only input + own dir |
| write outside the run dir | `NotCapable` | write only run dir |
| `Deno.symlinkSync` to an outside file | `NotCapable` ("requires unscoped --allow-read and --allow-write") | no escape via links |
| `Deno.linkSync` (hard link) to an outside file | `NotCapable` | same |
| `Deno.env.get`, `Deno.env.toObject`, `node:process` `env` | `NotCapable` | env not readable |
| `Deno.Command`, `node:child_process`, `Deno.kill(ppid)` | `NotCapable` | no subprocess, no signals |
| `Deno.dlopen` | `NotCapable` | no FFI |
| `Deno.hostname`, `osRelease`, `networkInterfaces`, `node:os` `userInfo` | `NotCapable` | no sys info |
| `Deno.connect` to localhost, `fetch`, `Deno.resolveDns` (file connector) | `NotCapable` | no network |
| `import("https://...")`, `import("jsr:...")`, `import("npm:...")` | `TypeError` (import access denied, `--no-npm`) | no remote code |
| `import()` of a file outside the allow list | `TypeError` (read access) | same |
| a `deno.json` in the connector with an import map and `"unstable"` | ignored with `--no-config`; **without** `--no-config` it enabled `--unstable-worker-options` | `--no-config` is mandatory |
| `deno.json` `"permissions"` | not applied (only with `-P`) | ok |
| `Deno.permissions.request` | denied (`--no-prompt`) | no interactive escalation |
| `new Worker(...)` | allowed, inherits the same permissions; `deno.permissions` on a worker needs an unstable flag | no escalation |
| `Deno.execPath()`, `Deno.cwd()` | ok (reveal the deno path and run dir only) | acceptable |

Mutation check: adding `--allow-env --allow-run --allow-sys --allow-net` to the flags makes 8 of the 22
tests fail, so the tests do detect a weakened flag set.

### Fetch connectors and the proxy

Experiment: a fake CONNECT listener as `HTTPS_PROXY`, `deno run` with three `--allow-net` variants:

| `--allow-net` | `fetch("https://api.example.com/...")` | `fetch` to another host | `Deno.connectTls` to the allowed host |
| --- | --- | --- | --- |
| `api.example.com:443` | goes through the proxy (`CONNECT api.example.com:443` seen) | `NotCapable` | **direct** (Deno resolves and connects itself, bypassing the proxy) |
| proxy `127.0.0.1:<port>` only | `NotCapable` (Deno checks the target host, not the proxy) | `NotCapable` | `NotCapable` |

So:

- Deno's `fetch` honours `HTTPS_PROXY` / `HTTP_PROXY` from the environment without `--allow-env` (the
  runtime reads it, not user code). The `--use-env-proxy` flag is only for `node:http` / `node:https`.
- `--allow-net` must name the manifest hosts with port 443. The prototype does that
  (`deno_argv`, `RunSpec.hosts`); the proxy stays the place that resolves names, refuses private
  addresses, counts bytes and records denied hosts.
- **Gap without a native layer:** raw `Deno.connect` / `connectTls` to an allowed host bypasses the proxy:
  the destination is still limited to the manifest hosts, but the proxy's "public addresses only" check
  and byte accounting are skipped (a manifest host whose DNS points into the LAN would reach the LAN on
  443). On macOS the `sandbox-exec` layer closes this (only the proxy port is reachable; the prototype test
  passes in both modes). On Linux, Landlock ABI v4 (kernel 6.7+) can restrict TCP connect to the proxy
  port; on Windows there is no unprivileged per-process network filter. Owner decision whether
  "host-limited but not proxy-limited" is acceptable for Linux / Windows fetch connectors.

### Contract mapping

| Contract item | Deno |
| --- | --- |
| request on stdin, one JSON response on stdout | `await new Response(Deno.stdin.readable).text()`, `console.log(JSON.stringify(...))` |
| `run` in the manifest | `run: [deno, connector.ts]`; `run[0]` already allows `deno` (`manifest.py:51`). New rule in the prototype: `run[1]` must be a script file of the connector, never a flag or `run` (the app owns every flag). |
| timeout, process-group kill, stdout cap, CPU limit | unchanged, `process.run_process` |
| `detect` within 10 s | cold start 38-71 ms with a fresh `DENO_DIR` and a TypeScript file (transpile included), max RSS about 46 MB |
| third-party libraries | no `npm:` / `jsr:` / `https:` at run time. Vendor the needed files into the connector dir (relative imports, inside the hash and the 5 MiB / 200 files limits), or bundle to one file with `deno bundle` while developing |
| exit codes, error kinds, document validation | unchanged |

### Shipping Deno with the app

| Option | Pros | Cons |
| --- | --- | --- |
| **Bundle the per-OS binary** (recommended) | works offline, version pinned and covered by the app's signature and notarization, no download code in the app | app size; must be signed correctly (below) |
| Download on first use, sha256 pinned in the app | smaller download | network fetch from the app (a new egress path to justify), a writable binary in the data dir that must be re-verified before each run, a first-run failure mode offline |

Size: the Homebrew build here is 141,032,720 bytes uncompressed (and links Homebrew `sqlite` / `lcms2`, so
it is not the one to ship). The official release archives are a self-contained single binary per target
(`aarch64-apple-darwin`, `x86_64-apple-darwin`, `x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu`,
`x86_64-pc-windows-msvc`), from memory roughly 40-50 MB zipped and 100-140 MB unpacked; not verified here
(no downloads in this spike). `denort` (the `deno compile` runtime) is smaller but runs only an embedded
payload, not a script with permission flags, so it does not fit. License: MIT ("Copyright 2018-2026 the
Deno authors", `LICENSE.md` of the installed package); ship the license text with the app.

**macOS signing finding.** `scripts/build_macos.sh` re-signs every Mach-O file in the bundle with the
hardened runtime and the app's (empty) entitlements (`build_macos.sh:137-147`). Tested on an ad-hoc copy
of deno re-signed with `--options runtime`:

- without `com.apple.security.cs.allow-jit`: V8 aborts at start ("Fatal process out of memory: Failed to
  reserve virtual memory for CodeRange");
- with `allow-jit`: runs;
- without `allow-jit` but with `--v8-flags=--jitless`: runs (WebAssembly is unavailable in jitless mode).

So either the deno binary gets its own entitlements file with `allow-jit` only (the main executable keeps
none), or the runner always passes `--v8-flags=--jitless` (smaller attack surface for untrusted code,
slower, no Wasm). Recommendation: `--jitless` first (no entitlement to justify, parsers are small), measure
on a large export, add `allow-jit` for deno only if it is too slow. Place the binary in
`Contents/Helpers/` or `Contents/MacOS/` (Apple's places for helper executables), not `Resources/`.

`resolve_interpreter("deno")` must then prefer the bundled binary (`runtime.bundle_dir()`), so the pinned
interpreter path is the app's own; an app update replaces it at the same path, which keeps approvals
valid (the path is pinned, not the binary hash, as for every interpreter today).

## (c) Native sandboxes on Linux and Windows

**Linux.**

- *bubblewrap* (`bwrap`): mount-namespace sandbox (bind only the interpreter, connector dir and run dir,
  `--unshare-net` or a network namespace with only the proxy reachable, `--die-with-parent`,
  `--new-session`). Strong and well known (Flatpak). Problems for a downloaded app: it is a separate
  package not always installed; Ubuntu 23.10+ restricts unprivileged user namespaces through AppArmor
  (`kernel.apparmor_restrict_unprivileged_userns=1`), which the distro's own `bwrap` is allowed past but a
  bundled copy is not; `--unshare-net` also cuts the proxy unless it is reached over a Unix socket bound
  into the sandbox.
- *Landlock* (kernel 5.13+ for files, 6.7+ ABI v4 for TCP bind / connect by port, 6.12+ ABI v6 for signal
  and abstract-socket scoping): unprivileged, no extra package, applied by the process to itself before
  `exec`. It fits as a launcher mode of the app's own binary (apply Landlock, then `exec` deno or python),
  keeping `process.py`'s rule of no `preexec_fn` in the server. It restricts file access and execution
  (`LANDLOCK_ACCESS_FS_EXECUTE` only for the interpreter) and, with ABI v4, TCP connect to the proxy port,
  which closes the raw-socket gap above. It does not filter env (already clean) and is best-effort on old
  kernels (fail open to "Deno only", never to unsandboxed).
- *seccomp* alone is too coarse for file paths.

**Windows.**

- A *Job Object* is required anyway to replace `process.py`'s POSIX parts: `KILL_ON_JOB_CLOSE` (process
  tree kill on timeout), `ACTIVE_PROCESS_LIMIT = 1` (no child processes at the OS level, a second layer
  under Deno's `--allow-run` denial), per-process memory and CPU time limits. Doable with `ctypes`.
- *AppContainer* / low-integrity restricted token: real file and network isolation, but needs ACLs on the
  connector and run dirs and is fiddly from Python; a later hardening step.
- No unprivileged per-process network filter (WFP needs admin).

**Recommendation.** Deno is the cross-OS tier (Linux and Windows: Deno permissions + Job Object /
optional Landlock). Keep `MacSandbox` for every interpreter on macOS and layer it around Deno (done).
Python / node / other interpreters on Linux and Windows stay `sandbox_unavailable` until a native layer
covers them; do not run them with Deno-less confinement.

## (d) Secrets across OSes

There is no macOS-specific keychain code: `core/secrets.py` uses `keyring` for everything (Anthropic key
and the namespaced connector secrets `connector/<id>/<slug>/<binding>/<secret>`, `secrets.py:1-12`,
`120-200`); connector secrets reach a connector only on stdin. `keyring` picks the backend per OS: macOS
Keychain, Windows Credential Manager (`WinVaultKeyring`), Linux Secret Service (GNOME Keyring / KWallet
over D-Bus). What is missing:

- **Build dependencies.** `packaging/requirements-build.lock` is resolved on macOS: it has `keyring` and
  `jaraco-*`, but no `SecretStorage` / `jeepney` (Linux) or `pywin32-ctypes` (Windows). Each OS build needs
  its own hash-pinned lock (the Windows spec stub already says so).
- **Headless or minimal Linux** (no D-Bus session, locked or no collection): `keyring` falls back to the
  `fail` backend; `get_connector_secret` returns None and `set_connector_secret` raises `SecretsError`
  (fail closed, correct). The UI needs a Polish message ("brak magazynu haseł") and fetch connectors are
  then unavailable; never fall back to a plaintext `keyrings.alt` file.
- **Windows Credential Manager** caps the stored blob (2,560 bytes; `keyring` stores UTF-16, so roughly
  1,280 characters), which a long token (JWT) can exceed; verify on Windows and reject with a clear error.
- `sandbox.sb` denies `/Library/Keychains` explicitly; the Deno tier never grants reads outside the two
  dirs, so no equivalent rule is needed there.

## (e) Implementation plan

| # | Step | Size |
| --- | --- | --- |
| 1 | Harden the prototype: decide `--jitless` vs `allow-jit`, add a V8 heap cap (`--v8-flags=--max-old-space-size=...`), refuse `run[1]` outside the connector at manifest time (done in the prototype), run-history `sandbox` name (`deno`, `deno+macos`). | S |
| 2 | `resolve_interpreter("deno")`: prefer the bundled binary (`runtime.bundle_dir()`), then the search path; a Windows search path and `.exe`. | S |
| 3 | Packaging: a pinned list of Deno release archives with sha256 per target (like `requirements-build.lock`), fetched and verified by the build scripts only; place in `Contents/Helpers/deno` (macOS) or next to the exe (Windows / Linux); sign it (macOS) with its own entitlements if `allow-jit`; ship the MIT license; `packaging/README.md` decision record. | M |
| 4 | Windows process backend for `process.py`: clean env (plus `SystemRoot`), `CREATE_NO_WINDOW`, Job Object (kill on close, process limit 1, memory and CPU limits), stdout cap and timeout unchanged; `cashu-cli.exe` console entry so the CLI (and `connectors test`) work on Windows. | M |
| 5 | Platform report: `GET /api/system` `connectors` becomes per tier (`{"native": "macos" / "landlock" / null, "deno": true}`), Settings > Konektory explains in Polish that on Linux / Windows only Deno connectors run. | S |
| 6 | Manifest and contract docs: `docs/connectors.md` gets a Deno section (run form, flags, env, permissions per OS, vendoring instead of `npm:` / `jsr:`), the "only macOS" sentences change, `scripts/gen_connector_schemas.py` regenerated if the `run` rule text is in the schema, `sync_skill_references.py`. | S |
| 7 | import-builder skill: Deno + TypeScript as the default for new connectors (works in the downloaded app on all OSes, no developer tools), Python stays for macOS users who have it; a `deno-file-example` and `deno-fetch-example` in `references/connector-examples/`; tell the agent the absolute CLI path for `connectors test` from the workspace `CLAUDE.md`. | S |
| 8 | Test loop without a source checkout: render the test command with the absolute CLI path in the workspace `CLAUDE.md` and in the MCP tool text, and add a `Bash(<cli> connectors test:*)` allow rule to the workspace settings (owner opt-in). Optional, owner decision: an MCP `test_connector` tool (see open questions). | S-M |
| 9 | Linux Landlock launcher (app binary mode that applies Landlock, then `exec`s the interpreter), feature-detected by ABI; closes the raw-socket proxy bypass on kernels 6.7+. | M |
| 10 | Secrets: per-OS build locks with the keyring backend deps, fail-closed UI message when no backend, Windows size check. | S |
| 11 | CI: run `tests/test_connectors_sandbox_deno.py` on Linux and Windows runners with Deno installed (the tests skip when it is missing; the FFI probe path is Linux / macOS specific today). | S |
| 12 | Later: Python on Linux / Windows under a native layer (bwrap or Landlock; AppContainer), only if users need it. | L |

Order: 1, 2, 6, 7, 8 make Deno connectors work end to end in the macOS app (R2 on macOS without
developer tools); 3 ships it; 4, 5, 10, 11 bring Windows and Linux (R1); 9 and 12 are hardening.

## Open questions for the owner

1. Bundle Deno in every download (about +40-50 MB compressed, estimate) or download on first use with a
   pinned checksum?
2. `--jitless` (no extra entitlement, no Wasm, slower) or a deno-only `allow-jit` entitlement?
3. On Linux / Windows a Deno fetch connector can open raw TLS sockets to its manifest hosts, bypassing
   the proxy's private-address check and byte counts (hosts stay limited). Acceptable, or fetch connectors
   only where a native layer exists (macOS, Linux with Landlock ABI v4)?
4. Should an agent be able to run `connectors test` over MCP (sandboxed, value-free report, unapproved
   code), or does the rule "MCP calls never run code" stay, with the CLI as the only test path?
5. Make Deno the default language of the import-builder skill on every OS, including macOS where Python
   works for developers?
6. Other interpreters on Linux / Windows: refuse (current proposal) or invest in bwrap / AppContainer?
