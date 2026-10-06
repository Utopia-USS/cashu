"""The connector manifest (``connector.yaml``, api_version 1), the directory rules and the content hash.

A connector is a directory with ``connector.yaml`` plus code in any language. This module is pure apart
from reading that directory: it validates the manifest (unknown keys are errors with a did-you-mean hint,
every limit of the contract), checks the directory (file count, size, no symlinks, no hidden files except
``.gitignore``, UTF-8 names), computes ``content_sha256`` and resolves ``run[0]`` to the interpreter the app
will start (pinned at approval: a different resolved path later means the connector ``changed``).
"""

from __future__ import annotations

import difflib
import hashlib
import os
import re
import shutil
import stat
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Any, Literal

import yaml
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    ValidationError,
    model_validator,
)

API_VERSION = 1
MANIFEST_NAME = "connector.yaml"
MAX_MANIFEST_BYTES = 64 * 1024

MAX_FILES = 200
MAX_TOTAL_BYTES = 5 * 1024 * 1024
ALLOWED_HIDDEN = frozenset({".gitignore"})

DEFAULT_TIMEOUT_S = 60
MAX_TIMEOUT_S = 600
DETECT_TIMEOUT_S = 10
DEFAULT_HISTORY_DAYS = 365

MODULES = ("investments", "budget")
KINDS = ("file", "fetch")
PARAM_TYPES = ("string", "date", "number", "boolean")

# argv[0] is one of these interpreter names (resolved on a fixed search path) or ./<file in the dir>.
INTERPRETERS = ("python3", "node", "deno", "bun", "ruby", "perl")
SYSTEM_SEARCH_PATH = ("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin")
# Per-user dirs with real interpreters. Version-manager shim dirs (``~/.pyenv/shims``, rbenv, asdf) are
# left out: their entries are shell scripts that need the manager's state, which the sandbox does not
# grant; any other script found on the path is skipped too (see ``resolve_interpreter``).
HOME_SEARCH_PATH = (".local/bin", ".nvm/current/bin")
# Apple's /usr/bin stubs that run the developer dir's tool through xcrun: they need xcode-select state
# the sandbox does not grant, so the real tool of the active developer dir is pinned instead.
XCRUN_SHIMS = frozenset({"/usr/bin/python3"})
DEVELOPER_DIR_LINKS = ("/var/select/developer_dir", "/var/db/xcode_select_link")
DEFAULT_DEVELOPER_DIR = "/Library/Developer/CommandLineTools"

CONNECTOR_ID = r"^[a-z][a-z0-9-]{1,39}$"
FIELD_ID = r"^[a-z][a-z0-9_]{0,31}$"
_HOST = re.compile(
    r"^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$"
)
_EXTENSION = r"^[a-z0-9]{1,10}$"
MAX_RUN_ARGS = 8
MAX_ARG_CHARS = 200


class ManifestError(ValueError):
    """The manifest or the connector directory breaks the contract. ``issues`` lists every problem."""

    def __init__(self, issues: Iterable[str]):
        self.issues = tuple(issues)
        super().__init__("; ".join(self.issues) or "invalid connector")


class InterpreterError(ValueError):
    """``run[0]`` cannot be resolved to an executable."""


# --------------------------------------------------------------------------- #
# Manifest model
# --------------------------------------------------------------------------- #

Text = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
FieldId = Annotated[str, StringConstraints(pattern=FIELD_ID)]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class SecretSpec(_Strict):
    """A secret the owner enters once per binding (stored in the OS keychain, given only on stdin)."""

    id: FieldId
    label: Annotated[Text, StringConstraints(max_length=60)]


class ParamSpec(_Strict):
    """A non-secret setting of a binding."""

    id: FieldId
    label: Annotated[Text, StringConstraints(max_length=60)]
    type: Literal["string", "date", "number", "boolean"] = "string"
    required: bool = False


class FileSpec(_Strict):
    """``kind: file``: the export file extensions the connector converts."""

    extensions: Annotated[
        list[Annotated[str, StringConstraints(pattern=_EXTENSION)]],
        Field(min_length=1, max_length=20),
    ]


class FetchSpec(_Strict):
    """``kind: fetch``: the hosts the egress proxy allows (port 443 only), secrets and params."""

    hosts: Annotated[list[str], Field(min_length=1, max_length=10)]
    secrets: Annotated[list[SecretSpec], Field(max_length=5)] = []
    params: Annotated[list[ParamSpec], Field(max_length=10)] = []
    history_days: Annotated[int, Field(ge=1, le=3650)] = DEFAULT_HISTORY_DAYS

    @model_validator(mode="after")
    def _check(self) -> FetchSpec:
        for host in self.hosts:
            if not _HOST.match(host):
                raise ValueError(
                    f"hosts: {host!r} is not an exact lower-case host name (no scheme, port, "
                    "wildcard or IP address)"
                )
        _unique("hosts", self.hosts)
        _unique("secrets", [s.id for s in self.secrets])
        _unique("params", [p.id for p in self.params])
        return self


class Manifest(_Strict):
    """``connector.yaml``, api_version 1 (docs/connectors.md)."""

    api_version: Literal[1]
    id: Annotated[str, StringConstraints(pattern=CONNECTOR_ID)]
    name: Annotated[Text, StringConstraints(max_length=60)]
    version: Annotated[Text, StringConstraints(max_length=20)]
    author: Annotated[Text, StringConstraints(max_length=80)] | None = None
    description: Annotated[Text, StringConstraints(max_length=280)] | None = None
    module: Literal["investments", "budget"]
    kind: Literal["file", "fetch"]
    run: Annotated[list[str], Field(min_length=1, max_length=MAX_RUN_ARGS)]
    timeout_s: Annotated[int, Field(ge=1, le=MAX_TIMEOUT_S)] = DEFAULT_TIMEOUT_S
    file: FileSpec | None = None
    fetch: FetchSpec | None = None

    @model_validator(mode="after")
    def _check(self) -> Manifest:
        if self.kind == "file" and (self.file is None or self.fetch is not None):
            raise ValueError("kind file needs a `file` section and no `fetch` section")
        if self.kind == "fetch" and (self.fetch is None or self.file is not None):
            raise ValueError("kind fetch needs a `fetch` section and no `file` section")
        for problem in run_problems(self.run):
            raise ValueError(problem)
        return self

    @property
    def hosts(self) -> tuple[str, ...]:
        return tuple(self.fetch.hosts) if self.fetch else ()

    @property
    def secret_ids(self) -> tuple[str, ...]:
        return tuple(s.id for s in self.fetch.secrets) if self.fetch else ()

    @property
    def extensions(self) -> tuple[str, ...]:
        return tuple(self.file.extensions) if self.file else ()


def _unique(what: str, values: list[str]) -> None:
    seen: set[str] = set()
    for value in values:
        if value in seen:
            raise ValueError(f"{what}: {value!r} is listed twice")
        seen.add(value)


def run_problems(run: list[str]) -> list[str]:
    """Problems of the ``run`` argv (empty when it is fine)."""
    problems = []
    for i, arg in enumerate(run):
        where = f"run[{i}]"
        if not isinstance(arg, str) or not arg:
            problems.append(f"{where}: must be a non-empty string")
            continue
        if len(arg) > MAX_ARG_CHARS:
            problems.append(f"{where}: longer than {MAX_ARG_CHARS} characters")
        if any(ord(ch) < 32 for ch in arg):
            problems.append(f"{where}: control characters are not allowed")
        if ".." in arg.replace("\\", "/").split("/"):
            problems.append(f"{where}: `..` is not allowed")
        if arg.startswith(("/", "~")):
            problems.append(f"{where}: absolute paths are not allowed")
    if run and isinstance(run[0], str) and run[0]:
        first = run[0]
        if first.startswith("./"):
            if len(first) == 2 or "=" in first:
                problems.append("run[0]: ./ must name a file in the connector directory")
        elif first not in INTERPRETERS:
            problems.append(
                f"run[0]: {first!r} is not an allowed interpreter{_did_you_mean(first, INTERPRETERS)}"
                f" (allowed: {', '.join(INTERPRETERS)}, or ./<executable in the connector dir>)"
            )
    return problems


# --------------------------------------------------------------------------- #
# Parsing with readable issues
# --------------------------------------------------------------------------- #

_SECTIONS: dict[str, tuple[str, ...]] = {
    "": tuple(Manifest.model_fields),
    "file": tuple(FileSpec.model_fields),
    "fetch": tuple(FetchSpec.model_fields),
    "fetch.secrets[]": tuple(SecretSpec.model_fields),
    "fetch.params[]": tuple(ParamSpec.model_fields),
}


def _did_you_mean(text: str, candidates: Iterable[str]) -> str:
    match = difflib.get_close_matches(str(text).lower(), list(candidates), n=1, cutoff=0.6)
    return f' (did you mean "{match[0]}"?)' if match else ""


def _unknown_keys(data: Any, section: str, where: str) -> list[str]:
    if not isinstance(data, dict):
        return []
    known = _SECTIONS[section]
    issues = []
    for key in data:
        if key not in known:
            issues.append(f"{where}{key}: unknown key{_did_you_mean(str(key), known)}")
    return issues


def _all_unknown_keys(data: dict) -> list[str]:
    issues = _unknown_keys(data, "", "")
    if isinstance(data.get("file"), dict):
        issues += _unknown_keys(data["file"], "file", "file.")
    fetch = data.get("fetch")
    if isinstance(fetch, dict):
        issues += _unknown_keys(fetch, "fetch", "fetch.")
        for list_key in ("secrets", "params"):
            items = fetch.get(list_key)
            if isinstance(items, list):
                for i, item in enumerate(items):
                    issues += _unknown_keys(item, f"fetch.{list_key}[]", f"fetch.{list_key}[{i}].")
    return issues


def _pydantic_issues(error: ValidationError) -> list[str]:
    issues = []
    for e in error.errors():
        if e["type"] == "extra_forbidden":
            continue  # reported with a did-you-mean hint by _all_unknown_keys
        where = ".".join(str(p) for p in e["loc"])
        message = e["msg"].removeprefix("Value error, ")
        issues.append(f"{where}: {message}" if where else message)
    return issues


def parse_manifest(text: str) -> Manifest:
    """Validate manifest YAML text. Raises :class:`ManifestError` with every problem found."""
    if len(text.encode("utf-8")) > MAX_MANIFEST_BYTES:
        raise ManifestError([f"{MANIFEST_NAME} is larger than {MAX_MANIFEST_BYTES // 1024} KiB"])
    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError as e:
        mark = getattr(e, "problem_mark", None)
        line = f" (line {mark.line + 1})" if mark is not None else ""
        raise ManifestError([f"{MANIFEST_NAME} is not valid YAML{line}"]) from None
    return manifest_from_data(data)


def manifest_from_data(data: Any) -> Manifest:
    if not isinstance(data, dict):
        raise ManifestError([f"{MANIFEST_NAME} must be a mapping of keys"])
    issues = _all_unknown_keys(data)
    try:
        manifest = Manifest.model_validate(data)
    except ValidationError as e:
        issues += _pydantic_issues(e)
        manifest = None
        run = data.get("run")
        if isinstance(run, list):  # the model check of `run` does not run when a field failed
            issues += [p for p in run_problems(run) if not any(p in i for i in issues)]
    if issues or manifest is None:
        raise ManifestError(issues)
    return manifest


# --------------------------------------------------------------------------- #
# Directory: file list, limits, content hash
# --------------------------------------------------------------------------- #


@dataclass(frozen=True, slots=True)
class FileEntry:
    path: str  # relative, "/"-separated
    size: int
    sha256: str
    executable: bool


def scan_dir(root: Path) -> list[FileEntry]:
    """Every regular file of a connector directory, sorted by path. Raises :class:`ManifestError` on a
    symlink, a hidden name (except ``.gitignore``), a special file, a non UTF-8 name or a broken limit."""
    root = Path(root)
    if root.is_symlink() or not root.is_dir():
        raise ManifestError([f"{root.name or root}: not a directory"])
    issues: list[str] = []
    entries: list[FileEntry] = []
    total = 0

    def walk(directory: Path, prefix: str) -> None:
        nonlocal total
        try:
            children = sorted(os.scandir(directory), key=lambda e: e.name)
        except OSError as e:
            issues.append(f"{prefix or '.'}: cannot be read ({type(e).__name__})")
            return
        for child in children:
            name = child.name
            rel = f"{prefix}{name}"
            try:
                name.encode("utf-8")
            except UnicodeEncodeError:
                issues.append(f"{prefix}<name>: file names must be UTF-8")
                continue
            if name.startswith(".") and not (name in ALLOWED_HIDDEN and child.is_file(
                follow_symlinks=False
            )):
                issues.append(f"{rel}: hidden files are not allowed (only .gitignore)")
                continue
            if child.is_symlink():
                issues.append(f"{rel}: symlinks are not allowed")
                continue
            if child.is_dir(follow_symlinks=False):
                walk(Path(child.path), f"{rel}/")
                continue
            if not child.is_file(follow_symlinks=False):
                issues.append(f"{rel}: only regular files are allowed")
                continue
            if len(entries) >= MAX_FILES:
                if len(entries) == MAX_FILES:
                    issues.append(f"more than {MAX_FILES} files")
                entries.append(FileEntry(rel, 0, "", False))  # counted, never hashed
                continue
            mode = child.stat(follow_symlinks=False).st_mode
            digest, size = _sha256_file(Path(child.path))
            total += size
            entries.append(FileEntry(rel, size, digest, bool(mode & stat.S_IXUSR)))

    walk(root, "")
    if total > MAX_TOTAL_BYTES:
        issues.append(f"larger than {MAX_TOTAL_BYTES // (1024 * 1024)} MiB in total")
    if not any(e.path == MANIFEST_NAME for e in entries):
        issues.append(f"{MANIFEST_NAME} is missing")
    if issues:
        raise ManifestError(issues)
    return entries


def _sha256_file(path: Path) -> tuple[str, int]:
    h = hashlib.sha256()
    size = 0
    with path.open("rb") as f:
        while chunk := f.read(1024 * 1024):
            h.update(chunk)
            size += len(chunk)
            if size > MAX_TOTAL_BYTES:
                break  # the total limit fails anyway; never hash a huge file to the end
    return h.hexdigest(), size


def content_sha256(entries: Iterable[FileEntry]) -> str:
    """sha256 over the sorted ``<relpath>\\0<sha256 of file>\\n`` lines of every file."""
    lines = sorted(f"{e.path}\0{e.sha256}\n" for e in entries)
    return hashlib.sha256("".join(lines).encode("utf-8")).hexdigest()


# --------------------------------------------------------------------------- #
# Interpreter resolution
# --------------------------------------------------------------------------- #


def search_path(home: Path | None = None) -> list[str]:
    """The fixed search path for interpreter names: system dirs, then a few per-user dirs if present."""
    home = home if home is not None else Path.home()
    dirs = list(SYSTEM_SEARCH_PATH)
    for rel in HOME_SEARCH_PATH:
        candidate = home / rel
        if candidate.is_dir():
            dirs.append(str(candidate))
    return dirs


def developer_dir() -> Path:
    """The active Apple developer dir (xcode-select), read from its link without running anything."""
    for link in DEVELOPER_DIR_LINKS:
        if os.path.islink(link):
            return Path(os.path.realpath(link))
    return Path(DEFAULT_DEVELOPER_DIR)


def resolve_interpreter(argv0: str, connector_dir: Path, *, home: Path | None = None) -> Path:
    """The real path of the program ``run[0]`` starts. Raises :class:`InterpreterError`."""
    if argv0.startswith("./"):
        root = Path(os.path.realpath(connector_dir))
        target = Path(os.path.realpath(root / argv0[2:]))
        if root not in target.parents:
            raise InterpreterError(f"{argv0}: must be a file inside the connector directory")
        if not target.is_file() or not os.access(target, os.X_OK):
            raise InterpreterError(f"{argv0}: not an executable file in the connector directory")
        return target
    if argv0 not in INTERPRETERS:
        raise InterpreterError(f"{argv0!r} is not an allowed interpreter")
    dirs = search_path(home)
    scripts: list[str] = []
    xcrun_error: str | None = None
    for folder in dirs:
        found = shutil.which(argv0, path=folder)
        if not found:
            continue
        real = os.path.realpath(found)
        if real in XCRUN_SHIMS:
            tool = developer_dir() / "usr" / "bin" / argv0
            if not tool.exists():
                xcrun_error = (
                    f"{real} needs the Apple developer tools (xcode-select --install) or another {argv0}"
                )
                continue
            real = os.path.realpath(tool)
        if not os.path.isfile(real) or not os.access(real, os.X_OK):
            continue
        if _is_script(real):
            scripts.append(real)  # a shim / wrapper script: cannot run sandboxed
            continue
        return Path(real)
    if xcrun_error:
        raise InterpreterError(xcrun_error)
    if scripts:
        raise InterpreterError(
            f"{argv0} resolves only to scripts ({', '.join(scripts)}); install a real {argv0} binary "
            "(e.g. Homebrew)"
        )
    raise InterpreterError(f"{argv0} was not found (searched {', '.join(dirs)}); install it first")


def _is_script(path: str) -> bool:
    """A ``#!`` script (a version-manager shim or wrapper), not an executable binary."""
    try:
        with open(path, "rb") as f:
            return f.read(2) == b"#!"
    except OSError:
        return True


def interpreter_prefix(interpreter: Path) -> Path | None:
    """The installation an interpreter may read and exec from (e.g. a framework ``Versions/3.12``, a
    ``~/.pyenv/versions/3.12.4``, a Homebrew keg). None for a system location already covered by the
    sandbox's system read rules, where exec stays limited to the interpreter itself."""
    parent = interpreter.parent
    prefix = parent.parent if parent.name == "bin" else parent
    if str(prefix) in {"/", "/usr", "/bin", "/usr/local", "/opt/homebrew", "/opt", "/Users"}:
        return None
    if prefix == Path.home() or len(prefix.parts) < 3:
        return None
    return prefix


@dataclass(frozen=True, slots=True)
class LoadedConnector:
    """A validated connector directory: manifest, files, hash and the resolved interpreter."""

    root: Path
    manifest: Manifest
    files: tuple[FileEntry, ...]
    content_sha256: str
    interpreter: Path

    def argv(self) -> list[str]:
        """The argv the sandbox starts: the resolved interpreter, then the manifest's arguments."""
        return [str(self.interpreter), *self.manifest.run[1:]]


def load_dir(root: Path, *, home: Path | None = None) -> LoadedConnector:
    """Validate a connector directory end to end. Raises :class:`ManifestError` (the interpreter problem
    included as an issue)."""
    root = Path(os.path.realpath(root))
    files = scan_dir(root)
    text = (root / MANIFEST_NAME).read_text(encoding="utf-8", errors="replace")
    manifest = parse_manifest(text)
    first = manifest.run[0]
    if first.startswith("./") and not any(e.path == first[2:] for e in files):
        raise ManifestError([f"run[0]: {first} is not a file of the connector"])
    try:
        interpreter = resolve_interpreter(first, root, home=home)
    except InterpreterError as e:
        raise ManifestError([f"run[0]: {e}"]) from None
    return LoadedConnector(root, manifest, tuple(files), content_sha256(files), interpreter)


__all__ = [
    "API_VERSION",
    "DETECT_TIMEOUT_S",
    "INTERPRETERS",
    "MANIFEST_NAME",
    "FileEntry",
    "InterpreterError",
    "LoadedConnector",
    "Manifest",
    "ManifestError",
    "content_sha256",
    "interpreter_prefix",
    "load_dir",
    "parse_manifest",
    "resolve_interpreter",
    "scan_dir",
    "search_path",
]
