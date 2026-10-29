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

1. ABI check (``landlock_create_ruleset(NULL, 0, VERSION)``); below the policy's minimum: refuse.
2. File connectors (``net: none``): best effort, a private user + network namespace (no interface, so no
   TCP, UDP or abstract Unix socket reaches the host). Required when the ABI is below 4, because then
   Landlock cannot restrict sockets at all.
3. Ruleset: file-system rules; with ABI >= 4, TCP bind denied and TCP connect allowed only to the proxy
   port; with ABI >= 6, abstract Unix sockets and signals scoped to the sandbox.
4. ``PR_SET_NO_NEW_PRIVS``, ``landlock_restrict_self``, ``execv``.

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


def prepare(policy: dict) -> dict:
    """Steps 1-3 of the module doc for this process; returns what was applied (for tests / diagnostics)."""
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
    return {"abi": abi, "netns": netns}


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
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
