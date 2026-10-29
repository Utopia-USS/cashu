"""Linux connector launcher: restrict this process with Landlock, then ``exec`` the connector.

Started by :class:`~cashu.core.connectors.sandbox_linux.LinuxSandbox` as the last link of the process
chain (``sh`` limits -> ``env -i`` -> this launcher -> the interpreter), so the server process itself never
runs a ``preexec_fn``. From source it runs as ``python -I -m cashu.core.connectors.landlock_exec``; in the
packaged app as ``<app binary> --landlock-exec`` (``desktop/entry.py``). Arguments::

    <policy json> -- <interpreter> <args...>

The policy (built by ``sandbox_linux.build_policy``) lists paths with a mode (``r`` read, ``rx`` read and
execute, ``rw`` read and write in the run dir, ``dev`` a read / write device such as ``/dev/null``), the
network mode (``none`` or ``proxy`` with the proxy port) and the minimum Landlock ABI. Every file-system
right the running kernel knows is handled, so everything not granted is denied. Steps:

1. Architecture (x86_64 / aarch64 only) and ABI check (``landlock_create_ruleset(NULL, 0, VERSION)``);
   below the policy's minimum: refuse.
2. File connectors (``net: none``): best effort, a private user + network namespace (no interface, so no
   TCP reaches the host). Required when the ABI is below 4, because then Landlock cannot restrict TCP.
3. Ruleset: file-system rules; with ABI >= 4, TCP bind denied and TCP connect allowed only to the proxy
   port; with ABI >= 6, abstract Unix sockets and signals scoped to the sandbox.
   ``PR_SET_NO_NEW_PRIVS``, ``landlock_restrict_self``.
4. seccomp filter (:func:`seccomp_program`): only TCP sockets (no Unix sockets, no UDP, no netlink),
   no io_uring, ptrace, process_vm_*, bpf, perf_event_open, keyrings, mounts, namespaces,
   personality. Denials return EPERM so a connector fails cleanly. Then ``execv``.

``--probe`` (no other argument) sets up an empty sandbox in the launcher itself and checks that the filter
denies a Unix and a UDP socket; ``sandbox_linux.available`` runs it once per app process.

A refusal writes ``cashu-landlock: <reason>`` to stderr and exits with :data:`REFUSED_EXIT`; the sandbox
maps that to ``sandbox_unavailable``. Only the standard library is imported: this runs before every
connector, and the module must also work as a plain script.
"""

from __future__ import annotations

import ctypes
import json
import os
import struct
import sys

REFUSED_EXIT = 97
MARKER = "cashu-landlock:"

# Syscall numbers are the same on every architecture (unified numbering of new syscalls).
SYS_LANDLOCK_CREATE_RULESET = 444
SYS_LANDLOCK_ADD_RULE = 445
SYS_LANDLOCK_RESTRICT_SELF = 446
LANDLOCK_CREATE_RULESET_VERSION = 1 << 0
LANDLOCK_RULE_PATH_BENEATH = 1
LANDLOCK_RULE_NET_PORT = 2
PR_SET_NO_NEW_PRIVS = 38

# File-system access rights (include/uapi/linux/landlock.h) and the ABI that introduced them.
FS_EXECUTE = 1 << 0
FS_WRITE_FILE = 1 << 1
FS_READ_FILE = 1 << 2
FS_READ_DIR = 1 << 3
FS_REMOVE_DIR = 1 << 4
FS_REMOVE_FILE = 1 << 5
FS_MAKE_CHAR = 1 << 6
FS_MAKE_DIR = 1 << 7
FS_MAKE_REG = 1 << 8
FS_MAKE_SOCK = 1 << 9
FS_MAKE_FIFO = 1 << 10
FS_MAKE_BLOCK = 1 << 11
FS_MAKE_SYM = 1 << 12
FS_REFER = 1 << 13  # ABI 2
FS_TRUNCATE = 1 << 14  # ABI 3
FS_IOCTL_DEV = 1 << 15  # ABI 5
NET_BIND_TCP = 1 << 0  # ABI 4
NET_CONNECT_TCP = 1 << 1  # ABI 4
SCOPE_ABSTRACT_UNIX_SOCKET = 1 << 0  # ABI 6
SCOPE_SIGNAL = 1 << 1  # ABI 6

_FS_ABI1 = (1 << 13) - 1
# Rights that apply to a regular file (a rule on a file may carry only these).
_FILE_RIGHTS = FS_EXECUTE | FS_WRITE_FILE | FS_READ_FILE | FS_TRUNCATE | FS_IOCTL_DEV

READ = FS_READ_FILE | FS_READ_DIR
READ_EXEC = READ | FS_EXECUTE
READ_WRITE = (
    READ | FS_WRITE_FILE | FS_REMOVE_DIR | FS_REMOVE_FILE | FS_MAKE_DIR | FS_MAKE_REG | FS_MAKE_SYM
    | FS_MAKE_FIFO | FS_MAKE_SOCK | FS_REFER | FS_TRUNCATE
)  # no EXECUTE: nothing written in the run dir can be started
DEVICE = FS_READ_FILE | FS_WRITE_FILE | FS_TRUNCATE
MODES = {"r": READ, "rx": READ_EXEC, "rw": READ_WRITE, "dev": DEVICE}

NET_ABI = 4
SCOPE_ABI = 6


class Refused(Exception):
    """The sandbox cannot be set up as the policy demands: nothing runs."""


class _RulesetAttr(ctypes.Structure):
    _fields_ = [
        ("handled_access_fs", ctypes.c_uint64),
        ("handled_access_net", ctypes.c_uint64),
        ("scoped", ctypes.c_uint64),
    ]


def _path_beneath_attr(allowed_access: int, parent_fd: int) -> ctypes.Array:
    """``struct landlock_path_beneath_attr``: __u64 + __s32, packed (12 bytes, native byte order)."""
    return ctypes.create_string_buffer(struct.pack("=Qi", allowed_access, parent_fd), 12)


class _NetPortAttr(ctypes.Structure):
    _fields_ = [("allowed_access", ctypes.c_uint64), ("port", ctypes.c_uint64)]


_libc = None


def _syscall():
    global _libc
    if _libc is None:
        _libc = ctypes.CDLL(None, use_errno=True)
        _libc.syscall.restype = ctypes.c_long
    return _libc.syscall


def abi_version() -> int:
    """The kernel's Landlock ABI version; 0 when Landlock is missing, disabled or not Linux."""
    if not sys.platform.startswith("linux"):
        return 0
    try:
        version = _syscall()(
            ctypes.c_long(SYS_LANDLOCK_CREATE_RULESET), None, ctypes.c_size_t(0),
            ctypes.c_uint32(LANDLOCK_CREATE_RULESET_VERSION),
        )
    except (OSError, AttributeError):
        return 0
    return max(0, int(version))


def handled_fs(abi: int) -> int:
    rights = _FS_ABI1
    if abi >= 2:
        rights |= FS_REFER
    if abi >= 3:
        rights |= FS_TRUNCATE
    if abi >= 5:
        rights |= FS_IOCTL_DEV
    return rights


def elf_interpreter(path: str) -> str | None:
    """The program interpreter (``PT_INTERP``, e.g. ``/lib64/ld-linux-x86-64.so.2``) of an ELF file, or
    None (static binary, not ELF, unreadable). The kernel opens it for execution, so it needs the
    execute right too."""
    try:
        with open(path, "rb") as f:
            head = f.read(64)
            if len(head) < 52 or head[:4] != b"\x7fELF":
                return None
            is64 = head[4] == 2
            end = "<" if head[5] == 1 else ">"
            if is64:
                phoff, = struct.unpack_from(end + "Q", head, 32)
                phentsize, phnum = struct.unpack_from(end + "HH", head, 54)
            else:
                phoff, = struct.unpack_from(end + "I", head, 28)
                phentsize, phnum = struct.unpack_from(end + "HH", head, 42)
            if not 0 < phnum <= 512 or phentsize < (56 if is64 else 32):
                return None
            f.seek(phoff)
            table = f.read(phentsize * phnum)
            for i in range(phnum):
                base = i * phentsize
                if len(table) < base + phentsize:
                    return None
                p_type, = struct.unpack_from(end + "I", table, base)
                if p_type != 3:  # PT_INTERP
                    continue
                if is64:
                    offset, = struct.unpack_from(end + "Q", table, base + 8)
                    size, = struct.unpack_from(end + "Q", table, base + 32)
                else:
                    offset, = struct.unpack_from(end + "I", table, base + 4)
                    size, = struct.unpack_from(end + "I", table, base + 16)
                if not 0 < size <= 4096:
                    return None
                f.seek(offset)
                raw = f.read(size).split(b"\0", 1)[0]
                text = raw.decode("utf-8", errors="strict")
                return text if text.startswith("/") else None
    except (OSError, ValueError, struct.error):
        return None
    return None


def enter_private_netns() -> bool:
    """Move this process into a new user + network namespace (no interfaces up: no network at all, and
    abstract Unix sockets of the host are out of reach). False when the kernel or the distribution does
    not allow unprivileged user namespaces (e.g. Ubuntu's AppArmor restriction, container seccomp)."""
    unshare = getattr(os, "unshare", None)
    flags = getattr(os, "CLONE_NEWUSER", 0) | getattr(os, "CLONE_NEWNET", 0)
    if unshare is None or not getattr(os, "CLONE_NEWNET", 0):
        return False
    uid, gid = os.getuid(), os.getgid()
    try:
        unshare(flags)
    except OSError:
        return False
    # Map our own ids so files keep their owner; failure here does not undo the namespace.
    for name, text in (("setgroups", "deny"), ("uid_map", f"{uid} {uid} 1"), ("gid_map", f"{gid} {gid} 1")):
        try:
            with open(f"/proc/self/{name}", "w") as f:
                f.write(text)
        except OSError:
            pass
    return True


def _check(result: int, what: str) -> int:
    if result < 0:
        err = ctypes.get_errno()
        raise Refused(f"{what} failed: {os.strerror(err)}")
    return result


def restrict(policy: dict, abi: int) -> None:
    """Build the ruleset for ``policy`` and restrict this process (irrevocable)."""
    syscall = _syscall()
    fs = handled_fs(abi)
    net_mode = policy.get("net", "none")
    attr = _RulesetAttr(fs, 0, 0)
    size = 8
    if abi >= NET_ABI:
        attr.handled_access_net = NET_BIND_TCP | NET_CONNECT_TCP
        size = 16
    if abi >= SCOPE_ABI:
        attr.scoped = SCOPE_ABSTRACT_UNIX_SOCKET | SCOPE_SIGNAL
        size = 24
    ruleset = _check(
        syscall(ctypes.c_long(SYS_LANDLOCK_CREATE_RULESET), ctypes.byref(attr), ctypes.c_size_t(size),
                ctypes.c_uint32(0)),
        "landlock_create_ruleset",
    )
    try:
        for path, mode in policy.get("paths", []):
            rights = MODES[mode] & fs
            try:
                fd = os.open(path, os.O_PATH | os.O_CLOEXEC)
            except OSError:
                continue  # a missing path: no rule, so no access (always the safe side)
            try:
                if not os.path.isdir(path):
                    rights &= _FILE_RIGHTS
                if not rights:
                    continue
                rule = _path_beneath_attr(rights, fd)
                _check(
                    syscall(ctypes.c_long(SYS_LANDLOCK_ADD_RULE), ctypes.c_int(ruleset),
                            ctypes.c_int(LANDLOCK_RULE_PATH_BENEATH), rule, ctypes.c_uint32(0)),
                    f"landlock_add_rule({mode})",
                )
            finally:
                os.close(fd)
        if net_mode == "proxy":
            port = int(policy["port"])
            if not 0 < port < 65536:
                raise Refused("bad proxy port")
            rule = _NetPortAttr(NET_CONNECT_TCP, port)
            _check(
                syscall(ctypes.c_long(SYS_LANDLOCK_ADD_RULE), ctypes.c_int(ruleset),
                        ctypes.c_int(LANDLOCK_RULE_NET_PORT), ctypes.byref(rule), ctypes.c_uint32(0)),
                "landlock_add_rule(net)",
            )
        libc = ctypes.CDLL(None, use_errno=True)
        _check(libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0), "prctl(NO_NEW_PRIVS)")
        _check(
            syscall(ctypes.c_long(SYS_LANDLOCK_RESTRICT_SELF), ctypes.c_int(ruleset), ctypes.c_uint32(0)),
            "landlock_restrict_self",
        )
    finally:
        os.close(ruleset)


# --------------------------------------------------------------------------- #
# seccomp: what Landlock does not cover (Unix sockets, UDP and other protocols, kernel interfaces)
# --------------------------------------------------------------------------- #

PR_SET_SECCOMP = 22
SECCOMP_MODE_FILTER = 2
SECCOMP_RET_KILL_PROCESS = 0x80000000
SECCOMP_RET_ERRNO = 0x00050000
SECCOMP_RET_ALLOW = 0x7FFF0000
EPERM = 1
ENOSYS = 38
AUDIT_ARCH_X86_64 = 0xC000003E
AUDIT_ARCH_AARCH64 = 0xC00000B7
X32_SYSCALL_BIT = 0x40000000

# classic BPF opcodes
BPF_LD_W_ABS = 0x20
BPF_ALU_AND_K = 0x54
BPF_JEQ_K = 0x15
BPF_JSET_K = 0x45
BPF_JGE_K = 0x35
BPF_RET_K = 0x06

# struct seccomp_data: int nr; __u32 arch; __u64 instruction_pointer; __u64 args[6]
_OFF_NR, _OFF_ARCH = 0, 4


def _off_arg_low(i: int) -> int:
    return 16 + 8 * i  # low 32 bits on little-endian (both supported architectures)


AF_UNIX, AF_INET, AF_INET6 = 1, 2, 10
SOCK_STREAM, SOCK_TYPE_MASK = 1, 0xF
IPPROTO_IP, IPPROTO_TCP = 0, 6  # SCTP / MPTCP stream sockets are refused: Landlock rules cover TCP only
# CLONE_NEWNS | NEWCGROUP | NEWUTS | NEWIPC | NEWUSER | NEWPID | NEWNET
CLONE_NS_FLAGS = 0x00020000 | 0x02000000 | 0x04000000 | 0x08000000 | 0x10000000 | 0x20000000 | 0x40000000

# Syscalls denied outright (EPERM), by name; numbers per architecture below.
DENIED_SYSCALLS = (
    "socketpair",
    "io_uring_setup", "io_uring_enter", "io_uring_register",
    "ptrace", "process_vm_readv", "process_vm_writev",
    "bpf", "perf_event_open",
    "keyctl", "add_key", "request_key",
    "mount", "umount2", "pivot_root", "open_tree", "move_mount", "fsopen", "fsconfig", "fsmount",
    "fspick", "mount_setattr",
    "unshare", "setns",
    "personality",
)
# Shared by both tables (asm-generic numbers, also used by x86_64 for syscalls added since 5.1).
_COMMON = {
    "io_uring_setup": 425, "io_uring_enter": 426, "io_uring_register": 427, "open_tree": 428,
    "move_mount": 429, "fsopen": 430, "fsconfig": 431, "fsmount": 432, "fspick": 433, "clone3": 435,
    "mount_setattr": 442,
}
SYSCALLS = {
    "x86_64": {
        **_COMMON,
        "socket": 41, "socketpair": 53, "clone": 56, "ptrace": 101, "personality": 135, "pivot_root": 155,
        "mount": 165, "umount2": 166, "add_key": 248, "request_key": 249, "keyctl": 250, "unshare": 272,
        "perf_event_open": 298, "setns": 308, "process_vm_readv": 310, "process_vm_writev": 311,
        "bpf": 321,
    },
    "aarch64": {
        **_COMMON,
        "umount2": 39, "mount": 40, "pivot_root": 41, "personality": 92, "unshare": 97, "ptrace": 117,
        "socket": 198, "socketpair": 199, "add_key": 217, "request_key": 218, "keyctl": 219, "clone": 220,
        "perf_event_open": 241, "setns": 268, "process_vm_readv": 270, "process_vm_writev": 271,
        "bpf": 280,
    },
}
AUDIT_ARCH = {"x86_64": AUDIT_ARCH_X86_64, "aarch64": AUDIT_ARCH_AARCH64}


def machine() -> str:
    m = os.uname().machine.lower()
    return {"amd64": "x86_64", "arm64": "aarch64"}.get(m, m)


def seccomp_program(arch: str) -> list[tuple[int, int, int, int]]:
    """The filter as ``(code, jt, jf, k)`` instructions for ``arch`` (``x86_64`` / ``aarch64``).

    Foreign architecture (e.g. i386 ``int 0x80`` on x86_64): kill. x32 syscalls: EPERM. Denied
    syscalls: EPERM. ``clone3``: ENOSYS (its flags sit behind a pointer; glibc then falls back to
    ``clone``). ``clone`` with a namespace flag: EPERM. ``socket``: only ``AF_INET`` / ``AF_INET6`` with
    ``SOCK_STREAM`` and protocol 0 or TCP; everything else (``AF_UNIX``, UDP, raw, netlink, packet,
    vsock, ...) EPERM. Everything else: allowed.
    """
    if arch not in SYSCALLS:
        raise Refused(f"unsupported architecture {arch!r} (x86_64 and aarch64 only)")
    nrs = SYSCALLS[arch]
    labels: dict[str, int] = {}
    prog: list[tuple] = []  # (code, jt, jf, k) with jt / jf as label names or 0

    def emit(code, k=0, jt=0, jf=0):
        prog.append((code, jt, jf, k))

    def label(name):
        labels[name] = len(prog)

    emit(BPF_LD_W_ABS, _OFF_ARCH)
    emit(BPF_JEQ_K, AUDIT_ARCH[arch], 0, "kill")
    emit(BPF_LD_W_ABS, _OFF_NR)
    if arch == "x86_64":
        emit(BPF_JGE_K, X32_SYSCALL_BIT, "eperm", 0)
    for name in DENIED_SYSCALLS:
        emit(BPF_JEQ_K, nrs[name], "eperm", 0)
    emit(BPF_JEQ_K, nrs["clone3"], "enosys", 0)
    emit(BPF_JEQ_K, nrs["clone"], "clone", 0)
    emit(BPF_JEQ_K, nrs["socket"], "socket", 0)
    emit(BPF_RET_K, SECCOMP_RET_ALLOW)
    label("clone")
    emit(BPF_LD_W_ABS, _off_arg_low(0))
    emit(BPF_JSET_K, CLONE_NS_FLAGS, "eperm", 0)
    emit(BPF_RET_K, SECCOMP_RET_ALLOW)
    label("socket")
    emit(BPF_LD_W_ABS, _off_arg_low(0))
    emit(BPF_JEQ_K, AF_INET, "sock_type", 0)
    emit(BPF_JEQ_K, AF_INET6, "sock_type", "eperm")
    label("sock_type")
    emit(BPF_LD_W_ABS, _off_arg_low(1))
    emit(BPF_ALU_AND_K, SOCK_TYPE_MASK)
    emit(BPF_JEQ_K, SOCK_STREAM, 0, "eperm")
    emit(BPF_LD_W_ABS, _off_arg_low(2))
    emit(BPF_JEQ_K, IPPROTO_IP, "allow", 0)
    emit(BPF_JEQ_K, IPPROTO_TCP, "allow", "eperm")
    label("allow")
    emit(BPF_RET_K, SECCOMP_RET_ALLOW)
    label("eperm")
    emit(BPF_RET_K, SECCOMP_RET_ERRNO | EPERM)
    label("enosys")
    emit(BPF_RET_K, SECCOMP_RET_ERRNO | ENOSYS)
    label("kill")
    emit(BPF_RET_K, SECCOMP_RET_KILL_PROCESS)

    out = []
    for i, (code, jt, jf, k) in enumerate(prog):
        def rel(target, i=i):
            if not isinstance(target, str):
                return target
            offset = labels[target] - i - 1
            if not 0 <= offset <= 255:
                raise ValueError(f"jump to {target} out of range")
            return offset
        out.append((code, rel(jt), rel(jf), k))
    return out


def run_bpf(program: list[tuple[int, int, int, int]], nr: int, arch: int, args=(0,) * 6) -> int:
    """Interpret ``program`` for one syscall (only the opcodes it uses). For tests and the probe:
    the kernel is the real judge."""
    acc, pc = 0, 0
    data = {_OFF_NR: nr & 0xFFFFFFFF, _OFF_ARCH: arch}
    for i, value in enumerate(args):
        data[_off_arg_low(i)] = value & 0xFFFFFFFF
    while True:
        code, jt, jf, k = program[pc]
        pc += 1
        if code == BPF_LD_W_ABS:
            acc = data[k]
        elif code == BPF_ALU_AND_K:
            acc &= k
        elif code == BPF_JEQ_K:
            pc += jt if acc == k else jf
        elif code == BPF_JGE_K:
            pc += jt if acc >= k else jf
        elif code == BPF_JSET_K:
            pc += jt if acc & k else jf
        elif code == BPF_RET_K:
            return k
        else:
            raise ValueError(f"opcode {code:#x}")


def install_seccomp(arch: str | None = None) -> None:
    """Load the filter into this process (needs NO_NEW_PRIVS, set by :func:`restrict`; irrevocable)."""
    program = seccomp_program(arch or machine())
    packed = b"".join(struct.pack("=HBBI", *ins) for ins in program)
    buf = ctypes.create_string_buffer(packed, len(packed))

    class _SockFprog(ctypes.Structure):
        _fields_ = [("len", ctypes.c_ushort), ("filter", ctypes.c_void_p)]

    fprog = _SockFprog(len(program), ctypes.addressof(buf))
    libc = ctypes.CDLL(None, use_errno=True)
    _check(libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0), "prctl(NO_NEW_PRIVS)")
    _check(libc.prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, ctypes.byref(fprog), 0, 0), "seccomp")


def prepare(policy: dict) -> dict:
    """Steps 1-4 of the module doc for this process; returns what was applied (for tests / diagnostics)."""
    arch = machine()
    if arch not in SYSCALLS:
        raise Refused(f"unsupported architecture {arch!r} (x86_64 and aarch64 only)")
    abi = abi_version()
    if abi < 1:
        raise Refused("Landlock is not available in this kernel")
    net_mode = policy.get("net", "none")
    if net_mode not in ("none", "proxy"):
        raise Refused("bad network mode")
    if net_mode == "proxy" and abi < NET_ABI:
        raise Refused(f"Landlock ABI {abi} cannot restrict TCP (needs {NET_ABI}, Linux 6.7+)")
    if abi < int(policy.get("min_abi", 1)):
        raise Refused(f"Landlock ABI {abi} is below the required {policy.get('min_abi')}")
    netns = False
    if net_mode == "none":
        netns = enter_private_netns()
        if not netns and abi < NET_ABI:
            raise Refused(
                f"Landlock ABI {abi} cannot restrict sockets and no private network namespace is allowed"
            )
    restrict(policy, abi)
    install_seccomp(arch)
    return {"abi": abi, "netns": netns, "seccomp": arch}


def probe() -> int:
    """``--probe``: set up an empty sandbox in this process and check that the filter bites. Exit 0
    means connectors can run here (``sandbox_linux.available``)."""
    import socket

    try:
        arch = machine()
        if arch not in SYSCALLS:
            raise Refused(f"unsupported architecture {arch!r}")
        abi = abi_version()
        if abi < 1:
            raise Refused("Landlock is not available in this kernel")
        restrict({"paths": [], "net": "none"}, abi)
        install_seccomp(arch)
        for family, kind in ((socket.AF_UNIX, socket.SOCK_STREAM), (socket.AF_INET, socket.SOCK_DGRAM)):
            try:
                socket.socket(family, kind).close()
            except PermissionError:
                continue
            raise Refused("the seccomp filter did not deny a socket")
    except (Refused, OSError) as e:
        sys.stderr.write(f"{MARKER} {e}\n")
        return REFUSED_EXIT
    sys.stdout.write(json.dumps({"abi": abi, "seccomp": arch}) + "\n")
    return 0


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if args == ["--probe"]:
        return probe()
    if len(args) < 3 or args[1] != "--":
        sys.stderr.write(f"{MARKER} usage: <policy json> -- <program> [args...]\n")
        return REFUSED_EXIT
    try:
        policy = json.loads(args[0])
        program = args[2:]
        applied = prepare(policy)
    except (Refused, ValueError, KeyError, TypeError) as e:
        sys.stderr.write(f"{MARKER} {e}\n")
        return REFUSED_EXIT
    if policy.get("report"):
        sys.stderr.write(f"{MARKER} applied {json.dumps(applied)}\n")
    sys.stderr.flush()
    try:
        os.execv(program[0], program)
    except OSError as e:
        sys.stderr.write(f"{MARKER} exec failed: {os.strerror(e.errno or 0)}\n")
        return 126
    return 126  # pragma: no cover - execv does not return


if __name__ == "__main__":
    raise SystemExit(main())
