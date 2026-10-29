"""The Linux connector sandbox (Landlock + seccomp through the ``landlock_exec`` launcher). Synthetic
data only.

Two parts:

- portable unit tests (any OS): the policy, the ELF loader lookup, refusals (no Landlock, fetch runs,
  other architectures, a failing probe), the seccomp BPF program run through a small interpreter, the
  launcher's argument handling, the packaged-app mode;
- real-kernel tests (Linux with Landlock only): the ``--probe``; reads and writes outside the allowed
  places are denied (a file under ``$HOME`` and the data dir included); TCP, UDP, Unix sockets and the
  seccomp-denied syscalls fail with EPERM; the launcher's fetch mode reaches only the proxy port; a real
  ``python3`` file connector converts a synthetic export.

Run on macOS: ``docker run --rm -v "$PWD":/w -w /w python:3.12 bash -c
'pip install -e .[dev] -c constraints.txt && pytest -s tests/test_connectors_sandbox_linux.py'``.
"""

from __future__ import annotations

import json
import os
import socket
import struct
import sys
import threading
from pathlib import Path

import pytest
from connector_support import PYTHON3, target_of, write_connector

from cashu.core.connectors import landlock_exec as ll
from cashu.core.connectors import sandbox_linux as sl
from cashu.core.connectors.runner import InputFile, execute
from cashu.core.connectors.sandbox import RunSpec

ABI = ll.abi_version()
linux_landlock = pytest.mark.skipif(
    not sys.platform.startswith("linux") or ABI < 1, reason="Linux with Landlock only"
)
needs_net_abi = pytest.mark.skipif(ABI < ll.NET_ABI, reason="Landlock ABI 4 (TCP rules) needed")


@pytest.fixture(autouse=True)
def _data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("CASHU_DATA_DIR", str(tmp_path / "data"))


def _spec(tmp_path: Path, *, proxy_port: int | None = None, interpreter: str = "/usr/bin/python3") -> RunSpec:
    connector = tmp_path / "c"
    run_dir = tmp_path / "run"
    connector.mkdir(exist_ok=True)
    run_dir.mkdir(exist_ok=True)
    return RunSpec(
        argv=(interpreter, str(connector / "main.py")), connector_dir=connector,
        interpreter=Path(interpreter), run_dir=run_dir, env={"PATH": "/usr/bin:/bin"}, stdin=b"{}",
        timeout_s=30, max_stdout=1 << 20, proxy_port=proxy_port,
    )


# --------------------------------------------------------------------------- #
# Portable
# --------------------------------------------------------------------------- #


def _elf64(interp: bytes) -> bytes:
    """A minimal little-endian ELF64 header + one PT_LOAD and one PT_INTERP program header."""
    ehdr = bytearray(64)
    ehdr[:6] = b"\x7fELF\x02\x01"
    struct.pack_into("<Q", ehdr, 32, 64)  # e_phoff
    struct.pack_into("<HH", ehdr, 54, 56, 2)  # e_phentsize, e_phnum
    data_off = 64 + 2 * 56
    load = struct.pack("<IIQQQQQQ", 1, 5, 0, 0, 0, 0, 0, 0x1000)
    pinterp = struct.pack("<IIQQQQQQ", 3, 4, data_off, 0, 0, len(interp) + 1, len(interp) + 1, 1)
    return bytes(ehdr) + load + pinterp + interp + b"\0"


def test_elf_interpreter_reads_pt_interp(tmp_path):
    binary = tmp_path / "prog"
    binary.write_bytes(_elf64(b"/lib/ld-linux-aarch64.so.1"))
    assert ll.elf_interpreter(str(binary)) == "/lib/ld-linux-aarch64.so.1"


@pytest.mark.parametrize("content", [b"#!/bin/sh\necho\n", b"", b"\x7fELF\x02\x01" + b"\0" * 10])
def test_elf_interpreter_is_none_for_non_elf(tmp_path, content):
    path = tmp_path / "x"
    path.write_bytes(content)
    assert ll.elf_interpreter(str(path)) is None
    assert ll.elf_interpreter(str(tmp_path / "missing")) is None


def test_policy_grants_only_the_listed_places(tmp_path):
    spec = _spec(tmp_path)
    policy = sl.build_policy(spec)
    modes = {path: mode for path, mode in policy["paths"]}
    assert modes[os.path.realpath(spec.run_dir)] == "rw"
    assert modes[os.path.realpath(spec.connector_dir)] == "rx"
    assert policy["net"] == "none" and policy["min_abi"] == 1 and "port" not in policy
    home = os.path.realpath(os.path.expanduser("~"))
    data_dir = os.path.realpath(os.environ["CASHU_DATA_DIR"])
    for path, mode in policy["paths"]:
        assert path not in ("/", "/home", "/root", "/tmp", "/proc", "/run", "/etc", home, data_dir)
        if mode == "rw":
            assert path == os.path.realpath(spec.run_dir)
        if mode == "dev":
            assert path.startswith("/dev/")


def test_policy_for_fetch_names_the_proxy_port(tmp_path):
    policy = sl.build_policy(_spec(tmp_path, proxy_port=41234))
    assert (policy["net"], policy["port"], policy["min_abi"]) == ("proxy", 41234, ll.NET_ABI)
    with pytest.raises(ValueError):
        sl.build_policy(_spec(tmp_path, proxy_port=70000))


def test_uapi_struct_sizes():
    """Sizes the kernel expects (include/uapi/linux/landlock.h)."""
    import ctypes

    assert ctypes.sizeof(ll._RulesetAttr) == 24
    assert ctypes.sizeof(ll._NetPortAttr) == 16
    assert ctypes.sizeof(ll._path_beneath_attr(ll.READ, 3)) == 12


def test_read_write_mode_never_executes():
    assert not ll.READ_WRITE & ll.FS_EXECUTE
    assert not ll.READ & ll.FS_EXECUTE
    assert ll.handled_fs(1) & ll.READ_WRITE == ll.READ_WRITE & ((1 << 13) - 1)


def test_no_landlock_refuses(tmp_path, monkeypatch):
    monkeypatch.setattr(ll, "abi_version", lambda: 0)
    outcome = sl.LinuxSandbox().run(_spec(tmp_path))
    assert (outcome.error_kind, outcome.message, outcome.process) == (
        "sandbox_unavailable", sl.UNAVAILABLE_PL, None,
    )


@pytest.mark.parametrize("abi", [3, 4, 6])
def test_fetch_runs_are_refused_on_linux(tmp_path, monkeypatch, abi):
    """Until a namespace relay forces traffic through the proxy (Landlock's TCP rule is port-only)."""
    monkeypatch.setattr(ll, "abi_version", lambda: abi)
    outcome = sl.LinuxSandbox().run(_spec(tmp_path, proxy_port=41234))
    assert (outcome.error_kind, outcome.message, outcome.process) == (
        "sandbox_unavailable", sl.FETCH_UNAVAILABLE_PL, None,
    )


def test_available_needs_linux_landlock_and_a_working_probe(monkeypatch):
    calls = []

    class _Done:
        def __init__(self, code):
            self.returncode = code

    def fake_run(argv, **kwargs):
        calls.append(argv)
        return _Done(probe_code)

    monkeypatch.setattr(sl.subprocess, "run", fake_run)
    monkeypatch.setattr(ll, "machine", lambda: "x86_64")
    for platform, abi, probe_code, expected in (
        ("darwin", 6, 0, False), ("linux", 0, 0, False), ("linux", 6, ll.REFUSED_EXIT, False),
        ("linux", 6, 0, True),
    ):
        sl.available.cache_clear()
        monkeypatch.setattr(sys, "platform", platform)
        monkeypatch.setattr(ll, "abi_version", lambda abi=abi: abi)
        assert sl.available() is expected, (platform, abi, probe_code)
    sl.available.cache_clear()
    assert calls and all(argv[-1] == "--probe" for argv in calls)


def test_default_sandbox_without_a_working_probe_is_unsupported(monkeypatch):
    from cashu.core.connectors import sandbox as sb

    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(sl, "available", lambda: False)
    assert isinstance(sb.default_sandbox(), sb.UnsupportedSandbox)
    monkeypatch.setattr(sl, "available", lambda: True)
    assert isinstance(sb.default_sandbox(), sl.LinuxSandbox)


# seccomp: the BPF program, checked with the small interpreter (the kernel is the real judge)

ALLOW, EPERM_RET = ll.SECCOMP_RET_ALLOW, ll.SECCOMP_RET_ERRNO | ll.EPERM


@pytest.mark.parametrize("arch", ["x86_64", "aarch64"])
def test_seccomp_program_decisions(arch):
    prog = ll.seccomp_program(arch)
    nrs, audit = ll.SYSCALLS[arch], ll.AUDIT_ARCH[arch]

    def decide(name, *args, nr=None, audit_arch=audit):
        return ll.run_bpf(prog, nrs[name] if nr is None else nr, audit_arch, args + (0,) * (6 - len(args)))

    stream, dgram = 1, 2
    assert decide("socket", ll.AF_INET, stream) == ALLOW
    assert decide("socket", ll.AF_INET6, stream | 0o4000 | 0o2000000) == ALLOW  # NONBLOCK | CLOEXEC
    assert decide("socket", ll.AF_INET, stream, 6) == ALLOW
    assert decide("socket", ll.AF_INET, stream, 132) == EPERM_RET  # SCTP
    assert decide("socket", ll.AF_INET, stream, 262) == EPERM_RET  # MPTCP
    assert decide("socket", ll.AF_INET, dgram) == EPERM_RET
    assert decide("socket", ll.AF_INET6, 3) == EPERM_RET  # raw
    for family in (ll.AF_UNIX, 16, 17, 40, 0):  # unix, netlink, packet, vsock, unspec
        assert decide("socket", family, stream) == EPERM_RET, family
    for name in ll.DENIED_SYSCALLS:
        assert decide(name) == EPERM_RET, name
    assert decide("clone3") == ll.SECCOMP_RET_ERRNO | ll.ENOSYS
    assert decide("clone", 0x003D0F00) == ALLOW  # glibc pthread_create flags
    assert decide("clone", 0x01200011) == ALLOW  # fork(): CLONE_CHILD_SETTID | CLEARTID | SIGCHLD
    for flag in (0x00020000, 0x10000000, 0x40000000, 0x20000000):
        assert decide("clone", 0x01200011 | flag) == EPERM_RET, hex(flag)
    for harmless in (0, 1, 59, 221, 231, 444, 446):  # read, write, execve (both), exit_group, landlock
        assert ll.run_bpf(prog, harmless, audit) == ALLOW
    assert ll.run_bpf(prog, 0, 0x40000003) == ll.SECCOMP_RET_KILL_PROCESS  # i386
    if arch == "x86_64":
        assert ll.run_bpf(prog, ll.X32_SYSCALL_BIT | 41, audit) == EPERM_RET


def test_seccomp_syscall_tables_are_complete():
    needed = set(ll.DENIED_SYSCALLS) | {"socket", "clone", "clone3"}
    for arch, table in ll.SYSCALLS.items():
        assert needed <= set(table), (arch, needed - set(table))
        assert len(set(table.values())) == len(table), arch  # no duplicate numbers


def test_seccomp_refuses_other_architectures():
    with pytest.raises(ll.Refused):
        ll.seccomp_program("riscv64")


def test_launcher_refuses_other_architectures(monkeypatch, capsys):
    monkeypatch.setattr(ll, "machine", lambda: "armv7l")
    assert ll.main([json.dumps({"paths": []}), "--", "/bin/true"]) == ll.REFUSED_EXIT
    assert "architecture" in capsys.readouterr().err


def test_launcher_refuses_without_landlock(monkeypatch, capsys):
    monkeypatch.setattr(ll, "abi_version", lambda: 0)
    code = ll.main([json.dumps({"paths": []}), "--", "/bin/true"])
    assert code == ll.REFUSED_EXIT
    assert ll.MARKER in capsys.readouterr().err


def test_launcher_refuses_fetch_below_abi_4(monkeypatch, capsys):
    monkeypatch.setattr(ll, "abi_version", lambda: 3)
    code = ll.main([json.dumps({"paths": [], "net": "proxy", "port": 1}), "--", "/bin/true"])
    assert code == ll.REFUSED_EXIT and "ABI 3" in capsys.readouterr().err


def test_launcher_refuses_file_run_below_abi_4_without_netns(monkeypatch, capsys):
    monkeypatch.setattr(ll, "abi_version", lambda: 3)
    monkeypatch.setattr(ll, "enter_private_netns", lambda: False)
    code = ll.main([json.dumps({"paths": []}), "--", "/bin/true"])
    assert code == ll.REFUSED_EXIT and "namespace" in capsys.readouterr().err


@pytest.mark.parametrize("args", [[], ["{}"], ["{}", "/bin/true"], ["not json", "--", "/bin/true"]])
def test_launcher_rejects_bad_arguments(args, capsys):
    assert ll.main(args) == ll.REFUSED_EXIT


def test_packaged_app_dispatches_the_launcher_mode(monkeypatch):
    from cashu.desktop import entry

    seen = []
    monkeypatch.setattr(ll, "main", lambda args: seen.append(args) or 7)
    with pytest.raises(SystemExit) as stop:
        entry.main([sl.LAUNCHER_ARG, "{}", "--", "/x", "-psn_kept"])
    assert stop.value.code == 7 and seen == [["{}", "--", "/x", "-psn_kept"]]
    assert entry.LANDLOCK_EXEC == sl.LAUNCHER_ARG


def test_launcher_argv_from_source_and_frozen(monkeypatch):
    assert sl.launcher_argv()[1:] == ["-I", "-m", sl.LAUNCHER_MODULE]
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    assert sl.launcher_argv() == [sys.executable, sl.LAUNCHER_ARG]


# --------------------------------------------------------------------------- #
# Real kernel (Linux + Landlock)
# --------------------------------------------------------------------------- #


class _Listener:
    def __init__(self):
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen()
        self.port = self.sock.getsockname()[1]
        self.accepted = 0
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self):
        while True:
            try:
                conn, _ = self.sock.accept()
            except OSError:
                return
            self.accepted += 1
            conn.close()

    def close(self):
        self.sock.close()


class _UdpListener:
    def __init__(self):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.bind(("127.0.0.1", 0))
        self.sock.settimeout(1.0)
        self.port = self.sock.getsockname()[1]

    def received(self) -> bool:
        try:
            return bool(self.sock.recv(64))
        except OSError:
            return False

    def close(self):
        self.sock.close()


PROBE = '''\
import ctypes, json, os, socket, subprocess, sys
req = json.load(sys.stdin)
out = {{}}
def attempt(name, fn):
    try:
        fn()
        out[name] = "ok"
    except Exception as e:
        out[name] = type(e).__name__
attempt("read_home_file", lambda: open({home_file!r}).read())
attempt("list_home", lambda: os.listdir({home!r}))
attempt("read_data_db", lambda: open({data_file!r}).read())
attempt("read_passwd", lambda: open("/etc/passwd").read())
attempt("read_proc_environ", lambda: open("/proc/1/environ", "rb").read())
attempt("read_input", lambda: open(req["file"]["path"]).read())
attempt("read_own_dir", lambda: open({own!r}).read())
attempt("write_outside", lambda: open({outside!r}, "w").write("x"))
attempt("write_tmp", lambda: open("/tmp/cashu-landlock-probe", "w").write("x"))
attempt("write_run_dir", lambda: open("scratch.txt", "w").write("x"))
attempt("write_home_env", lambda: open(os.path.join(os.environ["HOME"], "h.txt"), "w").write("x"))
attempt("exec_shell", lambda: subprocess.run(["/bin/sh", "-c", "true"], check=True))
attempt("tcp_denied", lambda: socket.create_connection(("127.0.0.1", {denied}), timeout=3).close())
attempt("tcp_bind", lambda: socket.socket().bind(("127.0.0.1", 0)))
def udp():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.sendto(b"leak", ("127.0.0.1", {udp}))
attempt("udp", udp)
attempt("unix_socket", lambda: socket.socket(socket.AF_UNIX).connect("/run/dbus/system_bus_socket"))
attempt("socketpair", lambda: socket.socketpair())
attempt("unshare", lambda: os.unshare(os.CLONE_NEWUSER))
libc = ctypes.CDLL(None, use_errno=True)
def raw(nr, *args):
    if libc.syscall(nr, *args) < 0 and ctypes.get_errno() == 1:
        raise PermissionError()
NR = {nrs!r}
attempt("io_uring_setup", lambda: raw(NR["io_uring_setup"], 1, None))
attempt("ptrace", lambda: raw(NR["ptrace"], 0, 0, 0, 0))  # PTRACE_TRACEME
attempt("personality", lambda: raw(NR["personality"], 0xFFFFFFFF))
attempt("keyctl", lambda: raw(NR["keyctl"], 0, -3, 0))  # KEYCTL_GET_KEYRING_ID, session keyring
attempt("bpf", lambda: raw(NR["bpf"], 0, None, 0))
print(json.dumps({{"document": {{"records": [], "probe": out}}}}))
'''


def _applied(stderr: bytes) -> dict:
    for line in stderr.decode(errors="replace").splitlines():
        if line.startswith(f"{ll.MARKER} applied "):
            return json.loads(line.split(" applied ", 1)[1])
    return {}


@pytest.fixture
def export(tmp_path) -> InputFile:
    path = tmp_path / "exports" / "statement.csv"
    path.parent.mkdir()
    path.write_text("date,amount\n2026-01-05,1000.00\n2026-01-06,-200.00\n", encoding="utf-8")
    return InputFile(path, "statement.csv")


@linux_landlock
@pytest.mark.skipif(PYTHON3 is None, reason="no python3 on the fixed search path")
def test_file_connector_is_confined(tmp_path, export, capsys):
    home = Path(os.environ["HOME"])
    home.mkdir(parents=True, exist_ok=True)
    home_file = home / "secret.txt"
    home_file.write_text("FAKE SECRET", encoding="utf-8")
    data_file = Path(os.environ["CASHU_DATA_DIR"]) / "cashu.db"
    data_file.parent.mkdir(parents=True, exist_ok=True)
    data_file.write_text("FAKE DB", encoding="utf-8")
    denied, udp_sink = _Listener(), _UdpListener()
    root = tmp_path / "c"
    code = PROBE.format(
        home_file=str(home_file), home=str(home), data_file=str(data_file),
        own=str(root / "connector.yaml"), outside=str(tmp_path / "outside.txt"),
        denied=denied.port, udp=udp_sink.port, nrs=ll.SYSCALLS[ll.machine()],
    )
    try:
        target = target_of(write_connector(root, code=code))
        result = execute(target, "convert", file=export, sandbox=sl.LinuxSandbox(report=True))
        udp_leaked = udp_sink.received()
    finally:
        denied.close()
        udp_sink.close()
    assert result.ok, (result.error_kind, result.message, result.stderr_tail)
    applied = _applied((result.stderr_tail or "").encode())
    with capsys.disabled():
        print(f"\n[landlock] kernel ABI {ABI}, applied {applied}, udp_leaked={udp_leaked}")
    probe = result.response.document["probe"]
    assert probe["read_input"] == "ok" and probe["read_own_dir"] == "ok"
    assert probe["write_run_dir"] == "ok" and probe["write_home_env"] == "ok"
    for name in ("read_home_file", "list_home", "read_data_db", "read_passwd", "read_proc_environ",
                 "write_outside", "write_tmp", "exec_shell", "udp", "unix_socket", "socketpair", "unshare",
                 "io_uring_setup", "ptrace", "personality", "keyctl", "bpf"):
        assert probe[name] == "PermissionError", (name, probe)
    assert not (tmp_path / "outside.txt").exists()
    if applied.get("netns"):  # no interface in the namespace: unreachable / no address
        assert probe["tcp_denied"] != "ok" and probe["tcp_bind"] != "ok", probe
    else:  # Landlock ABI >= 4 alone (the launcher refuses a file run otherwise)
        assert (probe["tcp_denied"], probe["tcp_bind"]) == ("PermissionError", "PermissionError"), probe
    assert denied.accepted == 0 and not udp_leaked
    assert applied.get("seccomp") == ll.machine()


CONVERTER = '''\
import csv, json, sys
req = json.load(sys.stdin)
if req["command"] == "detect":
    print(json.dumps({"match": True, "confidence": 0.9}))
    sys.exit(0)
records = []
with open(req["file"]["path"], newline="", encoding="utf-8") as f:
    for row in csv.DictReader(f):
        amount = row["amount"]
        kind = "withdrawal" if amount.startswith("-") else "deposit"
        records.append({"record": "txn", "date": row["date"], "type": kind, "currency": "PLN",
                        "gross_amount": amount})
print(json.dumps({"document": {"format": "cashu-import", "format_version": 1, "source": "test_broker",
                               "records": records}}))
'''


@linux_landlock
@pytest.mark.skipif(PYTHON3 is None, reason="no python3 on the fixed search path")
def test_real_python_file_connector_converts(tmp_path, export):
    target = target_of(write_connector(tmp_path / "conv", code=CONVERTER))
    detect = execute(target, "detect", file=export, sandbox=sl.LinuxSandbox())
    assert detect.ok, (detect.error_kind, detect.message, detect.stderr_tail)
    result = execute(target, "convert", file=export, sandbox=sl.LinuxSandbox())
    assert result.ok, (result.error_kind, result.message, result.stderr_tail)
    records = result.response.document["records"]
    assert [(r["date"], r["type"], r["gross_amount"]) for r in records] == [
        ("2026-01-05", "deposit", "1000.00"), ("2026-01-06", "withdrawal", "-200.00"),
    ]
    assert result.records == 2


NET_PROBE = '''\
import json, socket, sys
json.load(sys.stdin)
out = {{}}
for name, port in (("proxy", {proxy}), ("other", {other})):
    try:
        socket.create_connection(("127.0.0.1", port), timeout=3).close()
        out[name] = "ok"
    except Exception as e:
        out[name] = type(e).__name__
print(json.dumps(out))
'''


@linux_landlock
@needs_net_abi
@pytest.mark.skipif(PYTHON3 is None, reason="no python3 on the fixed search path")
def test_launcher_fetch_mode_reaches_only_the_proxy_port(tmp_path):
    """The launcher layer for the future relay (LinuxSandbox.run refuses fetch runs today)."""
    proxy, other = _Listener(), _Listener()
    interpreter = os.path.realpath(PYTHON3)
    spec = _spec(tmp_path, proxy_port=proxy.port, interpreter=interpreter)
    (spec.connector_dir / "main.py").write_text(
        NET_PROBE.format(proxy=proxy.port, other=other.port), encoding="utf-8"
    )
    try:
        outcome = sl.LinuxSandbox().launch(spec)
    finally:
        proxy.close()
        other.close()
    assert outcome.error_kind is None, (outcome.message, outcome.process and outcome.process.stderr)
    assert outcome.process.exit_code == 0, outcome.process.stderr
    probe = json.loads(outcome.process.stdout)
    assert probe == {"proxy": "ok", "other": "PermissionError"}
    assert (proxy.accepted, other.accepted) == (1, 0)


@linux_landlock
def test_probe_passes_and_default_sandbox_is_linux(capsys):
    """Landlock and the seccomp filter install in a child (``--probe``); the app picks LinuxSandbox."""
    import subprocess

    from cashu.core.connectors.sandbox import default_sandbox

    probe = subprocess.run([*sl.launcher_argv(), "--probe"], env={}, capture_output=True, timeout=30,
                           check=False)
    with capsys.disabled():
        print(f"\n[landlock] probe exit {probe.returncode}: {probe.stdout!r} {probe.stderr!r}")
    assert probe.returncode == 0, probe.stderr
    assert json.loads(probe.stdout)["abi"] == ABI
    sl.available.cache_clear()
    assert default_sandbox().name == "linux"
