# Connector sandbox on Linux and Windows

Connectors are third-party programs, possibly malicious. The contract (`docs/connectors.md`, "Security
model") is the same on every OS: read only the system runtime, the connector's own directory and the run
directory; write only the run directory; no network for a `file` connector; only the app's egress proxy
for a `fetch` connector; timeouts and a process-tree kill. Deno's own permission flags are not enough
(static imports bypass `--allow-read`), so each OS needs a kernel-enforced layer. macOS has one
(`sandbox-exec`, `core/connectors/sandbox.py` + `sandbox.sb`). This page covers Linux (built: file
connectors only) and Windows (study only: file connectors first).

**Evidence levels.** In this page, *verified* means run on this machine (macOS 15, Darwin 24.6, arm64).
*Recalled* means from kernel / Win32 documentation as I remember it, not run here. **Nothing below was
run on a Linux kernel or on Windows**: the Docker daemon was off, and starting it was out of scope.
What still needs a kernel is listed under "What still needs a Linux kernel to verify".

## Linux: what is built

Files: `core/connectors/landlock_exec.py` (the launcher, standard library + `ctypes` only),
`core/connectors/sandbox_linux.py` (`LinuxSandbox`, `build_policy`), a hook in
`sandbox.default_sandbox()`, the `--landlock-exec` mode in `desktop/entry.py`, and
`tests/test_connectors_sandbox_linux.py`.

**Process chain.** `process.run_process` is unchanged: `/bin/sh` (ulimit CPU and file size) ->
`/usr/bin/env -i` (exact environment) -> launcher -> `execv(interpreter, argv)`. The launcher is the
app's own Python (`python -I -m cashu.core.connectors.landlock_exec`) or, in a packaged app, the app
binary in `--landlock-exec` mode, the same pattern as `--notify-helper`. The server process never runs a
`preexec_fn`. The policy is one JSON argument built by `build_policy` from the `RunSpec`, with real paths.

**Launcher steps.**

1. Check the architecture (x86_64 and aarch64 only; anything else is refused) and read the Landlock ABI
   (`landlock_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION)`).
2. Best effort: `unshare(CLONE_NEWUSER | CLONE_NEWNET)` and map the own uid / gid. A fresh network
   namespace has only a downed `lo`, so no TCP reaches the host even where Landlock cannot restrict TCP
   (ABI < 4, where the namespace is required). This step fails on Ubuntu 23.10+ (AppArmor restricts
   unprivileged user namespaces) and under Docker's default seccomp profile.
3. Landlock ruleset. Every file-system right the kernel knows is handled, so anything not granted is
   denied:

   | Path | Rights |
   | --- | --- |
   | `/usr`, `/lib`, `/lib64`, `/lib32`, `/libx32`, `/etc/ld.so.cache`, `/etc/ssl`, `/etc/pki`, `/etc/ca-certificates`, `/etc/crypto-policies`, `/etc/localtime`, `/dev/urandom`, `/dev/random`, `/dev/zero` | read |
   | `/dev/null` | read, write, truncate |
   | the interpreter file and its ELF loader (`PT_INTERP`, parsed from the binary) | read, execute |
   | the interpreter's installation when it is not under `/usr` (pyenv, `/opt/...`) | read, execute |
   | the connector directory | read, execute |
   | the run directory | read, write, create, remove, rename inside it; **no execute** |

   Not granted: `/home`, the cashU data dir, `/tmp`, `/proc`, `/sys`, `/run`, `/etc/passwd` and the rest of
   `/etc`, every other connector. No `execute` on `/usr/bin`, so `/bin/sh`, `curl` and so on cannot start.
   ABI >= 4: TCP bind and connect are denied (the launcher's fetch mode allows connect to the proxy port
   only; production does not use it yet). ABI >= 6: abstract Unix sockets and signals are scoped to the
   sandbox. Then `PR_SET_NO_NEW_PRIVS` and `landlock_restrict_self`.
4. seccomp filter (`seccomp_program`, classic BPF through `prctl(PR_SET_SECCOMP)`):

   | Call | Decision |
   | --- | --- |
   | any syscall from a foreign `AUDIT_ARCH` (e.g. i386 `int 0x80` on x86_64) | kill |
   | x32 syscalls (x86_64, `nr >= 0x40000000`) | EPERM |
   | `socket`: `AF_INET` / `AF_INET6`, type `SOCK_STREAM` (flags masked), protocol 0 or TCP | allow |
   | `socket`: anything else (`AF_UNIX`, UDP, raw, SCTP / MPTCP, netlink, packet, vsock, ...) | EPERM |
   | `socketpair` | EPERM |
   | `io_uring_setup` / `_enter` / `_register` (`IORING_OP_SOCKET` would bypass the socket rule) | EPERM |
   | `ptrace`, `process_vm_readv` / `_writev`, `bpf`, `perf_event_open` | EPERM |
   | `keyctl`, `add_key`, `request_key` | EPERM |
   | `mount`, `umount2`, `pivot_root`, `open_tree`, `move_mount`, `fsopen`, `fsconfig`, `fsmount`, `fspick`, `mount_setattr` | EPERM |
   | `unshare`, `setns`, `clone` with any `CLONE_NEW*` flag | EPERM |
   | `clone3` (its flags sit behind a pointer) | ENOSYS: glibc falls back to `clone` |
   | `personality` | EPERM |
   | everything else | allow |

   Denials return an errno, not a kill, so a connector fails cleanly. Then `execv`.

**When Linux is used.** `default_sandbox()` returns `LinuxSandbox` only when `sandbox_linux.available()`
is true. It runs `<launcher> --probe` once per app process in a child. The child applies an empty
Landlock ruleset and the filter to itself and checks that an `AF_UNIX` and a UDP socket are refused.
Otherwise the app keeps `UnsupportedSandbox`. **Fetch connectors are refused on Linux**
(`sandbox_unavailable`, "fetch connectors do not run on Linux yet") until the relay below exists.

**Kernel support matrix (file connectors).**

| Landlock ABI | Linux | File run |
| --- | --- | --- |
| none (LSM off or kernel < 5.13) | - | refused (`UnsupportedSandbox`) |
| 1-3 | 5.13-6.6 | runs only if the private network namespace works (e.g. Debian 12, kernel 6.1), else refused |
| 4-5 | 6.7-6.11 | runs; Landlock denies TCP, seccomp everything else; plus the namespace if allowed |
| 6+ | 6.12+ | as above, plus abstract-socket and signal scoping |

A refusal in the launcher prints `cashu-landlock: <reason>` and exits 97; `LinuxSandbox` turns that into
`sandbox_unavailable`. A connector that fakes this only gets itself refused.

**Connector compatibility costs.** No `socketpair` and no `AF_UNIX` means Python's `asyncio` event loop
(its self-pipe is a `socketpair`) and `multiprocessing` do not start. A file connector needs neither,
but the import-builder skill should say so. Deno / tokio use `eventfd` / `epoll`, so they are probably
unaffected (recalled; check when Deno lands).

**Process limits (`process.py`).** Process groups, `killpg`, `/bin/sh`, `/usr/bin/env -i` and RLIMIT_CPU
work the same on Linux (recalled; POSIX). One bug was found and fixed: `ulimit -f` counts 512-byte blocks
in dash (Debian / Ubuntu `/bin/sh`) but 1024-byte blocks in macOS `/bin/sh`. That would have made the
128 MiB cap 64 MiB on Linux. *Verified* with macOS `/bin/dash` (same upstream dash): `ulimit -f 2` gives
RLIMIT_FSIZE 1024 bytes under dash and 2048 bytes under `/bin/sh`. Bash in POSIX mode (Fedora / Arch
`/bin/sh`) also uses 512 (recalled). `FSIZE_UNIT` is now 1024 on macOS and 512 elsewhere.

### Linux residual risks after seccomp

The escape found earlier is closed: connecting to a pathname Unix socket (session D-Bus ->
`systemd-run --user`, Secret Service, `docker.sock`, X11 / Wayland, ssh-agent) needs an `AF_UNIX`
socket, and `socket(AF_UNIX)` / `socketpair` now fail. UDP and every non-TCP protocol are closed the
same way. What remains, by severity:

1. **Unverified on a real kernel.** All of the above is from the kernel ABI as I remember it, checked
   only by a BPF interpreter in the tests. Watch for:
   - Python start-up under exactly these rules (locale files, TLS store paths per distribution). A
     missing read path shows up as a failed run (fail closed), not a leak.
   - glibc's `clone3` -> `clone` fallback on ENOSYS (recalled for glibc 2.34+, both threads and
     `posix_spawn`).
   - Syscall numbers in `SYSCALLS` (recalled from the x86_64 and asm-generic tables).
   - The `sock_fprog` layout.
2. **Inherited file descriptors.** seccomp filters `socket()`, not sockets the process already holds.
   `process.py` starts the chain with `close_fds=True` and only stdin / stdout / stderr pipes. Keep it
   that way: never pass a socket fd into a run.
3. **Fetch connectors (deferred).** Landlock's TCP rule is port-only. With it, a fetch connector could
   connect to *any* address on the proxy's port number, which it knows from `HTTPS_PROXY`. That is why
   fetch runs are refused on Linux. **Follow-up: namespace + relay.**
   - The launcher forks. The child enters a user + network namespace, brings `lo` up, listens on
     `127.0.0.1:<port>` and passes the listening fd to the parent over `SCM_RIGHTS` (on a `socketpair`
     created before the filter).
   - The parent stays in the host namespace, outside Landlock and seccomp but running only our code. It
     relays every accepted connection to the real egress proxy. The child then restricts itself
     (Landlock, filter) and execs the connector.
   - Size: about 120-150 lines in `landlock_exec.py` (fork, fd passing, a small select / thread relay,
     clean shutdown with the process group), plus tests. About 1-2 days with a real kernel to test on.
   - It needs unprivileged user namespaces, so on Ubuntu 23.10+ (AppArmor) fetch connectors stay
     refused unless the app ships an AppArmor profile. A distribution package could do that; a
     downloaded app cannot without root.
4. **Abstract Unix sockets before ABI 6** are now unreachable anyway (no `AF_UNIX` socket). **Signals
   before ABI 6** (Linux < 6.12) remain: a connector can `kill()` any process of the same user, the cashU
   server included (denial of service, no data access). ABI 6 scoping closes it. Ptrace is denied by the
   filter, and Landlock limits it too.
5. **No memory or process-count limit.** A fork bomb or a large allocation can hurt the machine (same on
   macOS today). Options: RLIMIT_AS / RLIMIT_NPROC in the launcher (NPROC is per user, so it would also
   count the user's other processes), or a systemd user scope / cgroup.
6. **Kernel attack surface.** The filter is a deny-list, not an allow-list: every syscall not listed is
   reachable. An allow-list (Docker's ~300 entries) is stricter but brittle across interpreters. The
   user namespace for file runs widens the surface (user-namespace-only code paths); that trade-off is
   accepted for "no network at all" on old kernels.
7. **System V IPC** (message queues, semaphores, `shmget`) is not covered by Landlock or the filter.
   Low value to an attacker, but noted. It could be added to the deny-list.

**What still needs a Linux kernel to verify** (the coordinator is arranging Docker / CI):

- `test_probe_passes_and_default_sandbox_is_linux`: Landlock and the filter install, and the ABI
  printed with `-s` matches.
- `test_file_connector_is_confined`: every denial, including EPERM for UDP, `AF_UNIX`, `socketpair`,
  `unshare`, `io_uring_setup`, `ptrace`, `personality`, `keyctl` and `bpf`, while reads of the input and
  the connector dir, and writes to the run dir, still work.
- `test_real_python_file_connector_converts`: a real `python3` starts and converts under both layers.
- `test_launcher_fetch_mode_reaches_only_the_proxy_port`: the launcher layer the relay will build on.
- Ideally also on one Ubuntu 24.04 host (namespace refused by AppArmor, ABI 4+) and one Debian 12 host
  (ABI 2, namespace path required).

**How to run the Linux tests** (from macOS with Docker Desktop running):

```bash
docker run --rm -v "$PWD":/w -w /w python:3.12 bash -c \
  'pip install -e ".[dev]" -c constraints.txt && pytest -s tests/test_connectors_sandbox_linux.py'
```

`-s` prints the kernel's Landlock ABI, the probe output, and whether the namespace was applied.

- Docker's default seccomp profile blocks `unshare(CLONE_NEWUSER)`, so expect `netns: false`.
- Docker Desktop's LinuxKit kernel is recent, so expect ABI >= 4 (recalled, not checked).
- Docker's profile must allow the `landlock_*` syscalls and stacking a seccomp filter. If it does not,
  the probe fails and every real-kernel test is refused: re-run with `--security-opt
  seccomp=unconfined`.

The real-kernel tests are skipped on macOS. The portable tests in the same file (policy, refusals, the
BPF program through an interpreter for both architectures) pass on macOS (verified).

## Windows: options (study, no code)

Goal: the same guarantees without admin rights, from the Python app. All of this is **recalled**; none of
it was run.

### Building blocks

**AppContainer** (Windows 8+; LPAC from Windows 10 1703).

- Create or open a profile with `CreateAppContainerProfile` (`userenv.dll`, no admin). This gives an
  AppContainer SID derived from a name (`DeriveAppContainerSidFromAppContainerName`).
- Start the process with `CreateProcessW` + `EXTENDED_STARTUPINFO_PRESENT`, and an attribute list with:
  - `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`: the SID, and **no** capabilities;
  - `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`: only the three pipe handles;
  - optionally `PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY` for LPAC.
- Files. An AppContainer token passes an access check only through ACEs for its SID, for
  `ALL APPLICATION PACKAGES` (S-1-15-2-1), or for a capability it holds.
  - The user's profile, Documents, the cashU data dir and the keyring files carry no such ACEs, so they
    are denied.
  - `C:\Windows` and `C:\Program Files` grant `ALL APPLICATION PACKAGES` read / execute, so a system or
    per-machine interpreter just works.
  - The connector and run dirs get an explicit ACE for the SID: read / execute on the connector
    snapshot, modify on the run dir. `SetNamedSecurityInfoW` with an inheritable ACE works because the
    user owns these dirs (no admin).
  - A per-user Python (`%LOCALAPPDATA%\Programs\Python`, the python.org default) or the app's bundled
    Deno under `%LOCALAPPDATA%` needs the same grant on its install dir.
  - With LPAC, `ALL APPLICATION PACKAGES` no longer applies. Every read path then needs an explicit
    grant, the interpreter's system DLL locations included (some are granted to
    `ALL RESTRICTED APPLICATION PACKAGES`). This is stricter, and more work.
- Network. With no capability (`internetClient`, `internetClientServer`, `privateNetworkClientServer`),
  the container has **no network at all**. That is exactly the file-connector contract.
  - **Loopback to the proxy is the problem.** AppContainers cannot reach loopback unless the container
    is loopback-exempt. That is `NetworkIsolationSetAppContainerConfig` / `CheckNetIsolation.exe
    LoopbackExempt -a`, and it **needs admin**.
  - Granting `internetClient` instead gives direct internet access and bypasses the proxy (host-limited
    only by Deno's `--allow-net`).
  - Not known: whether loopback between two processes in the *same* AppContainer is allowed without
    the exemption. If it is, a proxy helper started in the same container (with `internetClient`) could
    serve a connector process started without it. **Open question, test first.**
- Other effects: a private object namespace, no access to most of HKCU, no handles to other processes
  of the user (integrity is low inside the container).

**Restricted token + low integrity** (`CreateRestrictedToken`, `SetTokenInformation(TokenIntegrityLevel)`).

- Low integrity enforces *no-write-up* on files by default but **not no-read-up**. A low-integrity
  process can still read the user's documents and the cashU database. This fails the read rule on its
  own.
- A restricted token with restricting SIDs (Chromium's "lockdown" token) can deny reads. It does not
  isolate the network, and it is harder to get an interpreter to start under it than under an
  AppContainer. Use it only as a fallback where AppContainer is unavailable, which is no supported
  Windows version.

**Job Object** (needed in every option; it replaces the POSIX half of `process.py`).

- `CreateJobObjectW`, then `SetInformationJobObject(JobObjectExtendedLimitInformation)` with:
  - `KILL_ON_JOB_CLOSE`: the tree dies with the handle, which replaces `killpg`;
  - `ACTIVE_PROCESS` with `ActiveProcessLimit = 1`: no child processes, a kernel layer under Deno's
    `--allow-run` denial;
  - `PROCESS_MEMORY` / `JOB_MEMORY`: memory caps, which macOS and Linux lack today;
  - `PROCESS_TIME`: the CPU limit, which replaces `ulimit -t`;
  - `DIE_ON_UNHANDLED_EXCEPTION`.
- `JobObjectBasicUIRestrictions`: no clipboard read / write, no global atoms, no desktop switching, no
  `ExitWindows`, no handles to other users' UI objects.
- Start the process `CREATE_SUSPENDED`, then `AssignProcessToJobObject`, then `ResumeThread`. Nested
  jobs work since Windows 8, so it does not matter if the app itself runs in a job (e.g. a terminal's).
- There is no file-size limit: cap the run dir by checking its size after the run, or use a quota-less
  rule ("the output is read through stdout only").

**Non-options.**

- *Windows Sandbox* needs Pro / Enterprise and turning on an optional feature (admin). It is a whole VM
  per run (seconds to start), and passing files in and out goes through a `.wsb` config.
- *WSL* is an optional feature (admin to enable, often absent), a Linux VM with the user's drives
  mounted under `/mnt/c` by default. It would need its own Landlock layer anyway, and the interpreter
  would be a different OS.
- *WFP / Windows Firewall rules per app* need admin.

### Python libraries

- Python's `subprocess.Popen` accepts only `lpAttributeList={"handle_list": ...}`, not
  `SECURITY_CAPABILITIES`. AppContainer process creation therefore needs a direct `CreateProcessW` call.
  Do it through `ctypes`: `InitializeProcThreadAttributeList`, `UpdateProcThreadAttribute`,
  `CreatePipe` with inheritable handles, `msvcrt.open_osfhandle` to wrap the pipe ends as Python files.
- pywin32 has `win32job` (Job Objects) and `win32security` (ACLs), but as far as I remember no
  `STARTUPINFOEX` / attribute-list support, so it cannot start the AppContainer process. It would be a
  ~10 MB dependency (recalled) for the easy half only. **Recommendation: pure `ctypes`, no new
  dependency.**

### Recommendation for Windows

**Plan: file connectors first, without admin, on AppContainer (normal, not LPAC, at first) + a Job
Object, in a `sandbox_windows.py` built on `ctypes`, with one fixed container name (`cashu.connector`).
Fetch connectors on Windows come later.** This matches Linux: file connectors now, fetch connectors once
traffic can be forced through the proxy.

**Phase 1: file connectors, no admin.** Rough size:

- process creation, pipes and wait / timeout / kill, replacing `process.py` on Windows: ~250 lines;
- AppContainer profile and SID: ~60 lines;
- ACL grant and revoke on the run dir and the code snapshot: ~80 lines;
- Job Object limits: ~60 lines;
- tests on a `windows-latest` CI runner: ~300 lines.

About 3-5 days including CI.

What phase 1 gives, with no network capability:

- no network at all;
- reads and writes confined by ACLs;
- no child processes (`ActiveProcessLimit = 1`);
- memory and CPU limits;
- no clipboard.

As on Linux, a fetch run on Windows returns `sandbox_unavailable`.

**Phase 2: fetch connectors, later.** Options, in order of preference:

1. A per-machine installer (it runs elevated once anyway) registers the loopback exemption for the
   fixed container SID. Fetch runs then reach the proxy, and only the proxy. A per-user install without
   it keeps refusing fetch runs.
2. If loopback between two processes of the same container works without the exemption (open question,
   test first), run a proxy helper in the same container: no admin at all.
3. Owner decision: `internetClient` + Deno's host allow-list ("host-limited, not proxy-limited"). Linux
   does not accept this level either, so it is not recommended.

**One container for all runs, or one per run?** `CreateAppContainerProfile` writes registry and profile
folders per name, so one fixed container is cheaper. Per-run ACEs on fresh dirs keep runs apart. The
rule: never leave an ACE for the container on anything that outlives the run, except the interpreter's
install dir.

**Open risks (Windows).**

- Loopback without admin (phase 2, above).
- Interpreters that write to `%APPDATA%` or read HKCU at start-up. Set `TEMP` / `TMP` /
  `USERPROFILE` / `APPDATA` to the run dir. Python reads `HKLM\Software\Python` (readable by
  `ALL APPLICATION PACKAGES`, recalled) and `HKCU\Software\Python` (denied: harmless).
- Named pipes and ALPC ports that grant `Everyone` or `ALL APPLICATION PACKAGES` are reachable from
  AppContainers. This is the Windows counterpart of the Linux Unix-socket escape, and the main
  real-world AppContainer escape class. With LPAC far fewer are reachable: plan LPAC as the hardening
  step right after phase 1.
- ACL grants on a per-user interpreter dir persist and are visible to every connector run. That is
  read / execute only, the same as the system dirs.
- Antivirus scanning per process start (Defender) can add 100+ ms per run (recalled, typical).

## Summary

| | macOS | Linux (built, not run on a kernel) | Windows (proposed, phase 1) |
| --- | --- | --- | --- |
| Mechanism | `sandbox-exec` SBPL | Landlock + seccomp + optional user / network namespace | AppContainer + Job Object |
| Admin needed | no | no | no |
| Connector kinds | file and fetch | file only (fetch refused) | file only (fetch later) |
| File reads outside allow-list | denied | denied | denied (ACLs) |
| Writes outside run dir | denied | denied | denied |
| Exec of other programs | denied | denied (no execute right) | denied (`ActiveProcessLimit = 1`) |
| File run network | none | none (Landlock TCP / namespace, seccomp: TCP sockets only) | none (no capability) |
| Fetch run network | `localhost:<proxy port>` only | refused until the namespace relay | refused until the exemption or same-container proxy |
| Local IPC (Unix sockets / pipes) | denied by default | no `AF_UNIX` sockets (seccomp) | named pipes with broad ACLs reachable (LPAC narrows) |
| Signals to the user's other processes | denied | allowed before Linux 6.12 (ABI 6 scoping) | denied (integrity / container) |
| Memory limit | none | none | Job Object |

Next steps, in order:

1. Run the Linux tests in Docker or CI, then on one Ubuntu 24.04 and one Debian 12 host (list above).
2. Mention the Linux limits (file connectors only, no asyncio or multiprocessing) in the import-builder
   skill.
3. The namespace + relay for Linux fetch runs (~120-150 lines, 1-2 days).
4. Windows phase 1: first a spike that starts `python.exe` and `deno.exe` in an AppContainer + Job
   Object, plus the same-container loopback test, then `sandbox_windows.py`.
