# Connector sandbox on Linux and Windows

Connectors are third-party programs, possibly malicious. The contract (`docs/connectors.md`, "Security
model") is the same on every OS: read only the system runtime, the connector's own directory and the run
directory; write only the run directory; no network for a `file` connector; only the app's egress proxy
for a `fetch` connector; timeouts and a process-tree kill. Deno's own permission flags are not enough
(static imports bypass `--allow-read`), so each OS needs a kernel-enforced layer. macOS has one
(`sandbox-exec`, `core/connectors/sandbox.py` + `sandbox.sb`). This page covers Linux (built) and
Windows (study only).

**Evidence levels.** In this page, *verified* means run on this machine (macOS 15, Darwin 24.6, arm64).
*Recalled* means from kernel / Win32 documentation as I remember it, not run here. **Nothing below was
run on a Linux kernel or on Windows**: the Docker daemon was off, and starting it was out of scope.

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

1. Read the Landlock ABI (`landlock_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION)`). With no
   Landlock the parent already refuses (`sandbox_unavailable`); the launcher checks again.
2. File runs: best effort, `unshare(CLONE_NEWUSER | CLONE_NEWNET)` and map the own uid / gid. A fresh
   network namespace has only a downed `lo`, so no TCP, UDP or host abstract Unix socket is reachable.
   This step fails on Ubuntu 23.10+ (AppArmor restricts unprivileged user namespaces) and in Docker's
   default seccomp profile; then Landlock alone has to do the job.
3. Ruleset. Every file-system right the kernel knows is handled, so anything not granted is denied:

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
   ABI >= 4: TCP bind is denied, and TCP connect is denied except to the proxy port on a fetch run.
   ABI >= 6: abstract Unix sockets and signals are scoped to the sandbox (`LANDLOCK_SCOPE_*`).
4. `prctl(PR_SET_NO_NEW_PRIVS)`, `landlock_restrict_self`, `execv`. The domain is inherited by every
   child and cannot be removed.

**Kernel support matrix.**

| Landlock ABI | Linux | File run | Fetch run |
| --- | --- | --- | --- |
| none (LSM off or kernel < 5.13) | - | refused | refused |
| 1-3 | 5.13-6.6 | runs only if the private network namespace works (e.g. Debian 12 with 6.1), else refused | refused |
| 4-5 | 6.7-6.11 | runs; no TCP; plus the namespace if allowed | runs; TCP only to the proxy port |
| 6+ | 6.12+ | as above, plus abstract-socket and signal scoping | as above, plus scoping |

A refusal in the launcher prints `cashu-landlock: <reason>` and exits 97; `LinuxSandbox` turns that into
`sandbox_unavailable`. A connector that fakes this only gets itself refused.

**Process limits (`process.py`).** Process groups, `killpg`, `/bin/sh`, `/usr/bin/env -i` and RLIMIT_CPU
work the same on Linux (recalled; POSIX). One bug was found and fixed: `ulimit -f` counts 512-byte blocks
in dash (Debian / Ubuntu `/bin/sh`) but 1024-byte blocks in macOS `/bin/sh`. That would have made the
128 MiB cap 64 MiB on Linux. *Verified* with macOS `/bin/dash` (same upstream dash): `ulimit -f 2` gives
RLIMIT_FSIZE 1024 bytes under dash and 2048 bytes under `/bin/sh`. Bash in POSIX mode (Fedora / Arch
`/bin/sh`) also uses 512 (recalled). `FSIZE_UNIT` is now 1024 on macOS and 512 elsewhere. Memory is not
limited on either OS (gap, below).

### Linux residual risks (read before enabling it for users)

Ordered by severity. Items 1-3 mean the Linux sandbox is **weaker than the macOS profile**. Of the
gaps below, 1 is a real **escape**. The `default_sandbox()` hook turns Linux on, so the owner should
decide whether that hook ships before item 1 is fixed (recommendation: no).

1. **Pathname Unix sockets are not covered (escape).** Landlock checks opening files and directories,
   not `connect()` to an existing socket file (recalled; newer kernels have work on a Unix-socket
   right, which I cannot confirm and which no current distribution has). Path lookup is never
   restricted. So a connector can connect to:
   - `/run/user/<uid>/bus`, the session D-Bus. Through it, `org.freedesktop.systemd1` can start a
     transient user unit (what `systemd-run --user` does) **outside the sandbox**. That is a full escape.
     The Secret Service (`org.freedesktop.secrets`) hands out the user's keyring items, cashU's
     connector secrets included, while the keyring is unlocked.
   - `/var/run/docker.sock` (root when the user is in the `docker` group), the X11 / Wayland sockets
     (keystroke capture and input injection), `ssh-agent`, `gpg-agent`.

   The network namespace does not help here: pathname sockets live in the file system.
   **Fix (needed before shipping):** a seccomp-BPF filter installed by the launcher after Landlock:
   - `socket()`: `AF_UNIX` -> `EACCES`. `AF_INET` / `AF_INET6` are allowed only with type
     `SOCK_STREAM` (mask off `SOCK_NONBLOCK | SOCK_CLOEXEC`). `AF_NETLINK`, `AF_PACKET`, `AF_VSOCK` and
     others -> `EACCES`. `socketpair` stays allowed (asyncio uses it).
   - `io_uring_setup` -> `EPERM` (`IORING_OP_SOCKET` would bypass the `socket()` rule).
   - a foreign `AUDIT_ARCH` -> kill (no 32-bit `socketcall` bypass).

   Size: about 80 lines of `ctypes` (filter and `prctl(PR_SET_SECCOMP)`), with x86_64 and aarch64
   syscall numbers. An alternative is a mount namespace with an empty `tmpfs` over `/run`, `/tmp` and
   `/var/run`, but that needs user namespaces, which Ubuntu restricts.
2. **UDP and other non-TCP protocols are not restricted by Landlock** (ABI 4 covers TCP bind / connect
   only; recalled). A fetch run, or a file run without the namespace, can `sendto()` UDP anywhere. That
   is a data exfiltration path (DNS to any resolver, QUIC), and on a file run it breaks "no network".
   The seccomp rule above (inet sockets only with `SOCK_STREAM`) closes it. File runs in the private
   namespace are already closed. The test reports `udp_leaked` and asserts it only when the namespace
   was applied.
3. **The network rule is port-only, not address and port.** A fetch connector may connect to *any*
   address on the proxy's port number, and it knows that number from `HTTPS_PROXY`. A server that
   listens on that port anywhere on the internet receives a direct, unproxied, unlogged connection.
   macOS allows only `localhost:<port>`. So on Linux a fetch connector is limited to "TCP on one port
   number", **not** to the proxy. Fixes:
   - (a) A private network namespace for fetch runs too, with a host-side relay. The launcher forks.
     The child enters the namespace, brings `lo` up, listens on `127.0.0.1:<port>` and hands that
     listening fd to the parent over `SCM_RIGHTS`. The parent stays in the host namespace and relays
     each accepted connection to the real proxy. The child then restricts itself and execs. Needs user
     namespaces (Ubuntu restricts them).
   - (b) A seccomp filter cannot check `connect()` addresses (pointer argument).
   - (c) Bind the proxy to a Unix socket and connect through it: connectors cannot use that with
     `HTTPS_PROXY`.

   Without (a), the fetch tier on Linux is "Deno host allow-list + TCP on one port", the same level the
   Deno spike called "host-limited but not proxy-limited" for Linux and Windows.
4. **Abstract Unix sockets and signals before ABI 6** (Linux < 6.12): without the namespace, a connector
   can reach abstract sockets (`@/tmp/.X11-unix/X0`, D-Bus on older setups). It can also `kill()` any
   process of the same user, including the cashU server (denial of service). ABI 6 scoping, or the
   namespace (abstract sockets only), closes this. Ptrace is already limited by Landlock: a sandboxed
   process cannot trace a process outside its domain (recalled, all ABIs), and Yama usually applies too.
5. **No memory or process-count limit.** A fork bomb or a large allocation can hurt the machine (same on
   macOS today). Options: RLIMIT_AS in the launcher, or a systemd user scope / cgroup (more setup).
6. **Kernel attack surface.** Without seccomp, every syscall is reachable. The user namespace for file
   runs widens it (user-namespace-only code paths). That trade-off is accepted for "no network at all".
7. **System V IPC** (message queues, semaphores, `shmget`) is not a file-system object and is not
   covered (recalled). Low value to an attacker, but noted.
8. **Unverified on a real kernel.** Python start-up under exactly these rules (locale files,
   `ld.so.cache`, TLS store paths per distribution) is untested. If a distribution needs one more read
   path, the symptom is a failed run (fail closed), not a leak.

**How to run the Linux tests** (from macOS with Docker Desktop running):

```bash
docker run --rm -v "$PWD":/w -w /w python:3.12 bash -c \
  'pip install -e ".[dev]" -c constraints.txt && pytest -s tests/test_connectors_sandbox_linux.py'
```

`-s` prints the kernel's Landlock ABI and whether the namespace was applied. Docker's default seccomp
profile blocks `unshare(CLONE_NEWUSER)`, so expect `netns: false` there. Docker Desktop's LinuxKit
kernel is recent, so expect ABI >= 4 (recalled, not checked). Docker's default profile must also allow
the `landlock_*` syscalls. If it does not, every real-kernel test fails with a refusal: re-run with
`--security-opt seccomp=unconfined`. The real-kernel tests are skipped on macOS; the 19 portable tests
in the same file pass on macOS (verified).

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

**AppContainer (normal, not LPAC, at first) + Job Object, in a `sandbox_windows.py` built on `ctypes`,
with one fixed container name (`cashu.connector`).** Rough size:

- process creation, pipes and wait / timeout / kill, replacing `process.py` on Windows: ~250 lines;
- AppContainer profile and SID: ~60 lines;
- ACL grant and revoke on the run dir and the code snapshot: ~80 lines;
- Job Object limits: ~60 lines;
- tests on a `windows-latest` CI runner: ~300 lines.

About 3-5 days including CI.

- **File connectors:** full contract (no network, read / write confined by ACLs, no child processes,
  memory limit).
- **Fetch connectors:** pick one, in order:
  1. A per-machine installer (it runs elevated once anyway) registers the loopback exemption for the
     fixed container SID. Fetch runs then reach the proxy, and only the proxy. A per-user install
     without it refuses fetch runs.
  2. If the same-container loopback works (open question), use a proxy helper in the same container:
     no admin at all.
  3. Owner decision: `internetClient` + Deno's host allow-list ("host-limited, not proxy-limited"), the
     same level as Linux today (risk 3 above).
- Run a new SID per run? `CreateAppContainerProfile` writes registry and profile folders per name. One
  fixed container is cheaper, and per-run ACEs on fresh dirs give isolation between runs. The rule:
  never leave an ACE for the container on anything that outlives the run except the interpreter
  install dir.

**Open risks (Windows).**

- Loopback without admin (above).
- Interpreters that write to `%APPDATA%` or read HKCU at start-up. Set `TEMP` / `TMP` /
  `USERPROFILE` / `APPDATA` to the run dir. Python reads `HKLM\Software\Python` (readable by
  `ALL APPLICATION PACKAGES`, recalled) and `HKCU\Software\Python` (denied: harmless).
- Named pipes and ALPC ports that grant `Everyone` or `ALL APPLICATION PACKAGES` are reachable from
  AppContainers (the main real-world AppContainer escape class). With LPAC far fewer are reachable.
  Plan LPAC as the second step.
- ACL grants on a per-user interpreter dir persist and are visible to every connector run. That is
  read / execute only, the same as the system dirs.
- Antivirus scanning per process start (Defender) can add 100+ ms per run (recalled, typical).

## Summary

| | macOS | Linux (built, not run) | Windows (proposed) |
| --- | --- | --- | --- |
| Mechanism | `sandbox-exec` SBPL | Landlock + optional user / network namespace | AppContainer + Job Object |
| Admin needed | no | no | no (loopback exemption: yes, once) |
| File reads outside allow-list | denied | denied | denied (ACLs) |
| Writes outside run dir | denied | denied | denied |
| Exec of other programs | denied | denied (no execute right) | denied (`ActiveProcessLimit = 1`) |
| File run network | none | none (ABI 4 TCP + namespace); **UDP open without the namespace** | none |
| Fetch run network | `localhost:<proxy port>` only | **any address on the proxy port, plus UDP** | proxy only with the exemption, else refused or direct |
| Local IPC (Unix sockets / pipes) | denied by default | **pathname sockets open (escape); abstract scoped on ABI 6** | named pipes with broad ACLs reachable |
| Memory limit | none | none | Job Object |

Next steps, in order:

1. A seccomp filter in the Linux launcher, before the Linux hook ships (closes risks 1 and 2).
2. Run the Linux tests in Docker and on one Ubuntu 24.04 and one Debian 12 host.
3. The netns + relay for Linux fetch runs (risk 3).
4. A Windows spike: AppContainer + Job Object start of `python.exe` and `deno.exe`, and the
   same-container loopback test.
