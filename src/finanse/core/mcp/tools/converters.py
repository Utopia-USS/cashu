"""Converter scripts (tier-2 extensions): a profile's own Python scripts that turn a broker export into
the finanse import format.

- Location: ``<data dir>/profiles/<slug>/extensions/importers/<name>.py`` (``name``: ``[a-z][a-z0-9_]{0,40}``).
- Contract: ``python -I <script> <input file> <output.csv>``; exit 0 = ok; the output is a finanse-format
  file (docs/import-format.md).
- Approval: a script runs only after the owner approved it in the app, pinned by its sha256. The approved
  hashes are the converters of the profile's approved import proposals; a changed file is not run until
  a proposal with the new hash is approved.
- Isolation: run out of process with the same interpreter in isolated mode (``-I``: no user site, no
  PYTHON* variables), an empty environment (no secrets), a fresh temporary working directory holding
  copies of the script and the input (so the approved bytes are the ones that run), stdin closed, a
  60 s timeout and a 64 MB output limit. stdout / stderr are discarded (they may echo data).
"""

from __future__ import annotations

import hashlib
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from sqlmodel import Session, select

from finanse.core.agent_models import Proposal

NAME = re.compile(r"^[a-z][a-z0-9_]{0,40}$")
TIMEOUT_SECONDS = 60
MAX_OUTPUT = 64 * 1024 * 1024
MAX_SCRIPT = 512 * 1024


class ConverterError(ValueError):
    """The converter cannot be used or failed (message safe to show; never contains file data)."""


def converters_dir(slug: str) -> Path:
    from finanse.modules.investments.service import files

    return files.profile_dir(slug) / "extensions" / "importers"


def clean_name(name: str) -> str:
    name = (name or "").strip()
    name = name.removesuffix(".py")
    if not NAME.match(name):
        raise ConverterError(
            "converter name must look like broker_x (lower-case letters, digits, _)"
        )
    return name


def script_path(slug: str, name: str) -> Path:
    return converters_dir(slug) / f"{clean_name(name)}.py"


def read_script(slug: str, name: str) -> tuple[Path, bytes, str]:
    """(path, source bytes, sha256) of a converter script."""
    path = script_path(slug, name)
    if not path.is_file() or path.is_symlink():
        raise ConverterError(
            f"no converter {clean_name(name)}.py in the profile's extensions/importers folder"
        )
    data = path.read_bytes()
    if len(data) > MAX_SCRIPT:
        raise ConverterError("the converter script is too large")
    return path, data, hashlib.sha256(data).hexdigest()


def approved_hashes(session: Session, profile_id: int, name: str) -> set[str]:
    rows = session.exec(
        select(Proposal).where(
            Proposal.profile_id == profile_id,
            Proposal.kind == "import",
            Proposal.status == "approved",
        )
    ).all()
    out: set[str] = set()
    for row in rows:
        conv = (row.payload or {}).get("converter") or {}
        if conv.get("name") == name and conv.get("sha256"):
            out.add(conv["sha256"])
    return out


def run(script: bytes, input_name: str, input_content: bytes) -> bytes:
    """Run the (approved) script bytes on the input; returns the output file's bytes."""
    suffix = Path(input_name).suffix.lower()
    suffix = suffix if re.fullmatch(r"\.[a-z0-9]{1,10}", suffix or "") else ".bin"
    work = Path(tempfile.mkdtemp(prefix="finanse-converter-"))
    try:
        (work / "converter.py").write_bytes(script)
        (work / f"input{suffix}").write_bytes(input_content)
        out = work / "output.csv"
        try:
            proc = subprocess.run(
                [
                    sys.executable,
                    "-I",
                    str(work / "converter.py"),
                    str(work / f"input{suffix}"),
                    str(out),
                ],
                cwd=work,
                env={"PYTHONIOENCODING": "utf-8", "LC_ALL": "C.UTF-8"},
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,  # never read: an approved script cannot flood memory
                stderr=subprocess.DEVNULL,
                timeout=TIMEOUT_SECONDS,
                check=False,
            )
        except subprocess.TimeoutExpired:
            raise ConverterError(
                f"the converter did not finish within {TIMEOUT_SECONDS} s"
            ) from None
        except OSError:
            raise ConverterError("the converter could not be started") from None
        if proc.returncode != 0:
            raise ConverterError(f"the converter failed (exit code {proc.returncode})")
        if not out.is_file():
            raise ConverterError("the converter wrote no output file")
        if out.stat().st_size > MAX_OUTPUT:
            raise ConverterError("the converter output is too large")
        return out.read_bytes()
    finally:
        shutil.rmtree(work, ignore_errors=True)
