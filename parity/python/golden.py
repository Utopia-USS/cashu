#!/usr/bin/env python3
"""Deterministic Python golden outputs for the TypeScript parity suite (scope S02).

    .venv/bin/python parity/python/golden.py --make-demo        # once: synthetic demo dataset
    .venv/bin/python parity/python/golden.py                    # both datasets
    .venv/bin/python parity/python/golden.py --dataset lab --check core.networth
    .venv/bin/python parity/python/golden.py --dataset lab --out ~/cashu-lab/parity/out-<branch>
    .venv/bin/python parity/python/golden.py --dataset lab --source-dir <run>/data --check 'store.table.*' --out <run>/out

Bridge harness helpers (counts only): ``--manifest <dataset>`` prints ``{"manifest", "files"}`` of the
dataset's source dir; ``--copy-dataset <dataset> --to <dir>`` copies it into ``<dir>`` (inside
``~/cashu-lab/parity/``, must not exist; source manifest unchanged, copy identical, ``quick_check``).

``--check`` takes a check name or a glob (``store.table.*``), repeatable. ``--source-dir`` (the bridge
harness, S31a spec 9.3 step 9) copies that dir instead of the dataset's, keeping the dataset's clock and
natural keys; it must resolve inside ``~/cashu-lab/parity/``.

Datasets (both live outside git):
- ``lab``:  ``~/cashu-lab/data`` (a copy of real data; its goldens never go into git);
- ``demo``: ``~/cashu-lab/parity/demo-data`` made by ``scripts/demo_data.py --today 2026-10-01``
  (synthetic; its goldens may be committed under ``parity/golden-demo/``).

Every run copies the dataset into a fresh ``~/cashu-lab/parity/run-<ts>-<dataset>/`` and runs the
checks in a child interpreter whose ``CASHU_DATA_DIR`` (and workspaces, HOME, legacy dir, launch
agents) point at that copy before cashU is imported; the child asserts ``paths.data_dir()`` is the
copy (``init_db`` upgrades the copy, never the source). The source dir is hashed before and after
and the run fails if a single byte changed. The child runs offline (``offline.py``), with
``CASHU_AUTO_DAILY=0``, ``CASHU_PRICE_REFRESH=0``, ``PYTHONHASHSEED=0``, ``TZ=Europe/Warsaw`` and a
frozen clock (``frozen.py``). Output: ``<out>/<dataset>/<check>.json`` (canonical JSON, ``canon.py``)
and ``index.json`` (check, rows, sha256, the repo ``commit`` the goldens came from and ``dirty``, whether
tracked files differed from it: ``pnpm parity`` refuses goldens of another commit). ``<out>`` defaults to
the shared ``~/cashu-lab/parity/out``, which only lab/ts-stack HEAD writes; a branch passes
``--out ~/cashu-lab/parity/out-<branch>``.

stdout shows only check names, row counts, hashes and counts: never values from a dataset.
"""

from __future__ import annotations

import argparse
import datetime as dt
import fnmatch
import hashlib
import os
import shutil
import subprocess
import sys
import traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
LAB_ROOT = Path(os.path.expanduser("~")) / "cashu-lab"
PARITY_ROOT = LAB_ROOT / "parity"
OUT_ROOT = PARITY_ROOT / "out"  # the shared goldens: written from lab/ts-stack HEAD only
DATASETS = {"lab": LAB_ROOT / "data", "demo": PARITY_ROOT / "demo-data"}
DEMO_TODAY = "2026-10-01"
# The frozen local wall clock of each dataset (the day the dataset is "as of").
CLOCKS = {"lab": "2026-10-31T12:00:00", "demo": f"{DEMO_TODAY}T12:00:00"}
TZ = "Europe/Warsaw"
FORMAT = 1  # bump when the canonical form or the index shape changes


# --------------------------------------------------------------------------- #
# Parent: never imports cashu
# --------------------------------------------------------------------------- #


def manifest(root: Path) -> tuple[int, str]:
    """(file count, sha256 of ``shasum -a 256``-style lines over every file, sorted by path)."""
    lines = []
    files = sorted("./" + p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file())
    for rel in files:
        digest = hashlib.sha256((root / rel[2:]).read_bytes()).hexdigest()
        lines.append(f"{digest}  {rel}\n")
    return len(files), hashlib.sha256("".join(lines).encode()).hexdigest()


def source_state() -> tuple[str | None, bool]:
    """(the repo commit the outputs come from, whether tracked files differ from it).

    ``pnpm parity`` refuses inputs whose recorded commit is not the HEAD under test (its staleness
    guard), so every producer records both in its ``index.json`` (``commit``, ``dirty``).
    """

    def git(*args: str) -> subprocess.CompletedProcess:
        return subprocess.run(["git", *args], cwd=REPO, capture_output=True, text=True, check=False)

    head = git("rev-parse", "HEAD")
    if head.returncode != 0:
        return None, False
    dirty = git("status", "--porcelain", "--untracked-files=no").stdout.strip()
    return head.stdout.strip(), bool(dirty)


def child_env(name: str, run: Path, before: tuple[int, str]) -> dict[str, str]:
    """The child's environment for dataset ``name`` in run dir ``run`` (golden.py and every bridge)."""
    env = safe_env(run / "home", run / "data", run / "workspaces", run)
    env["CASHU_PARITY_CLOCK"] = CLOCKS[name]
    env["CASHU_PARITY_SOURCE"] = f"{before[0]} files, manifest sha256 {before[1]}"
    commit, dirty = source_state()
    env["CASHU_PARITY_COMMIT"] = commit or ""
    env["CASHU_PARITY_DIRTY"] = "1" if dirty else "0"
    return env


def safe_env(home: Path, data_dir: Path, workspaces: Path, extra: Path) -> dict[str, str]:
    """The environment of every interpreter that imports cashU here: nothing points at a real dir."""
    env = {
        k: v
        for k, v in os.environ.items()
        if not k.startswith(("CASHU_", "FINANSE_")) and k != "PYTHONPATH"  # legacy name
    }
    for d in (home, workspaces, extra / "legacy-default-data-dir", extra / "LaunchAgents"):
        d.mkdir(parents=True, exist_ok=True)
    env.update(
        {
            "PYTHONHASHSEED": "0",
            "TZ": TZ,
            "HOME": str(home),
            "CASHU_TESTING": "1",  # no .env.dev, no calendar fetch, legacy-migration guard on
            "CASHU_DATA_DIR": str(data_dir),
            "CASHU_WORKSPACES_DIR": str(workspaces),
            "CASHU_LEGACY_DATA_DIR": str(extra / "legacy-default-data-dir"),
            "CASHU_LAUNCH_AGENTS_DIR": str(extra / "LaunchAgents"),
            "CASHU_APP_BUNDLE": "none",
            "CASHU_AUTO_DAILY": "0",
            "CASHU_PRICE_REFRESH": "0",
            "CASHU_LANG": "pl",
            "PYTHON_KEYRING_BACKEND": "keyring.backends.fail.Keyring",
        }
    )
    return env


def make_demo() -> int:
    target = DATASETS["demo"]
    if target.exists():
        print(f"demo dataset already exists at {target}; delete it to regenerate")
        return 1
    extra = PARITY_ROOT / "demo-env"
    env = safe_env(extra / "home", target, extra / "workspaces", extra)
    env.pop("CASHU_DATA_DIR")  # demo_data.py sets it from --data-dir before importing cashU
    cmd = [
        sys.executable,
        str(REPO / "scripts" / "demo_data.py"),
        "--data-dir",
        str(target),
        "--today",
        DEMO_TODAY,
    ]
    proc = subprocess.run(cmd, env=env, cwd=REPO, capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        print(proc.stdout[-4000:], proc.stderr[-4000:])
        return proc.returncode
    n, digest = manifest(target)
    print(f"demo dataset: {n} files, manifest sha256 {digest}")
    return 0


def source_dir_allowed(path: Path) -> bool:
    """A ``--source-dir`` must resolve inside ``~/cashu-lab/parity/`` (case-insensitive: APFS)."""
    real = os.path.realpath(path).casefold()
    base = os.path.realpath(PARITY_ROOT).casefold().rstrip(os.sep) + os.sep
    return real.startswith(base)


def quick_check(db: Path) -> bool:
    """``PRAGMA quick_check`` of a copied database, opened read-only (stdlib sqlite3, no cashU)."""
    import sqlite3

    try:
        conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        try:
            return conn.execute("PRAGMA quick_check").fetchone()[0] == "ok"
        finally:
            conn.close()
    except sqlite3.DatabaseError:
        return False


def copy_dataset(name: str, dest: Path) -> int:
    """``--copy-dataset <name> --to <dest>`` (the bridge harness, S31a spec 9.1): the dataset's source
    dir copied whole (``profiles/``, ``imports/`` ...) into ``dest`` the way a golden run copies it.
    The source manifest is taken before and after (a change while copying = exit 2, the copy may be
    torn) and the copied database must pass ``quick_check``. Prints the source manifest as JSON."""
    import json

    source = DATASETS[name]
    if not source_dir_allowed(dest):
        print(json.dumps({"error": f"--to must be inside {PARITY_ROOT}"}))
        return 1
    if dest.exists():
        print(json.dumps({"error": "--to must not exist yet"}))
        return 1
    if not (source / "cashu.db").is_file():
        print(json.dumps({"error": "no dataset"}))
        return 1
    before = manifest(source)
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(source, dest)
    after = manifest(source)
    if before != after:
        print(json.dumps({"error": "the source dataset changed while copying"}))
        return 2
    if manifest(dest) != before:
        print(json.dumps({"error": "the copy differs from the source"}))
        return 2
    if not quick_check(dest / "cashu.db"):
        print(json.dumps({"error": "the copied database fails quick_check"}))
        return 2
    print(json.dumps({"manifest": before[1], "files": before[0]}))
    return 0


def selects(name: str, only: list[str]) -> bool:
    """``--check`` values are names or globs (``store.table.*``); none = every check."""
    return not only or any(fnmatch.fnmatchcase(name, pattern) for pattern in only)


def run_dataset(
    name: str, checks: list[str], keep: bool, out_root: Path = OUT_ROOT, source: Path | None = None
) -> int:
    source = DATASETS[name] if source is None else source
    if not (source / "cashu.db").is_file():
        print(f"[{name}] no dataset at {source}" + (" (run --make-demo)" if name == "demo" else ""))
        return 1
    before = manifest(source)
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    run = PARITY_ROOT / f"run-{stamp}-{name}"
    run.mkdir(parents=True)
    os.chmod(run, 0o700)
    shutil.copytree(source, run / "data")
    out = out_root / name
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    env = child_env(name, run, before)
    cmd = [
        sys.executable,
        str(Path(__file__).resolve()),
        "--child",
        name,
        "--run-dir",
        str(run),
        "--child-out",
        str(out),
    ]
    for c in checks:
        cmd += ["--check", c]
    proc = subprocess.run(cmd, env=env, cwd=run, check=False)
    after = manifest(source)
    print(f"[{name}] source manifest before {before[1]} ({before[0]} files)")
    print(f"[{name}] source manifest after  {after[1]} ({after[0]} files)")
    if before != after:
        print(f"[{name}] FAIL: the source dataset changed during the run")
        return 2
    if not keep:
        shutil.rmtree(run, ignore_errors=True)
    return proc.returncode


# --------------------------------------------------------------------------- #
# Child: the only process that imports cashu
# --------------------------------------------------------------------------- #

SKIP_IMPORT = ("cashu.desktop", "cashu.core.migrations", "cashu.__main__")


def import_all() -> tuple[int, int]:
    """Import every cashu module (so ``frozen.install`` can rebind their date classes)."""
    import importlib
    import pkgutil

    import cashu

    ok = failed = 0
    for info in pkgutil.walk_packages(cashu.__path__, "cashu."):
        if info.name.startswith(SKIP_IMPORT):
            continue
        try:
            importlib.import_module(info.name)
            ok += 1
        except Exception:  # noqa: BLE001 - optional modules (GUI, platform specific)
            failed += 1
    return ok, failed


# The MCP payee references (``payee:<hmac>``, core/mcp/names.py) are keyed by a per-installation
# secret; neither dataset has one, so the run copy gets this fixed one (the TS port uses the same).
PARITY_PAYEE_KEY = hashlib.sha256(b"cashu-parity-payee-key-v1").digest()


def payee_key(data: Path) -> None:
    path = data / "mcp" / "payee.key"
    if path.exists():  # a dataset with its own key keeps it (only ever the run copy)
        return
    path.parent.mkdir(mode=0o700, exist_ok=True)
    path.write_bytes(PARITY_PAYEE_KEY)
    path.chmod(0o600)


def offline_sources() -> None:
    """The market sources the app would call are replaced by the offline ones the test suite uses
    (``tests/conftest.py``), on top of the network guard: nothing even tries to fetch."""
    from cashu.modules.investments.service import daily, instrument_search, prices

    instrument_search.default_sources = instrument_search.offline_sources
    instrument_search.clear_cache()
    prices.default_sources = prices.offline_sources
    prices.clear_cache()

    def offline_daily_sources():
        offline = prices.offline_sources()
        return daily.MarketSources(offline.prices, offline.fx)

    daily.default_sources = offline_daily_sources


def child(name: str, run: Path, out: Path, only: list[str]) -> int:
    sys.path.insert(0, str(HERE))
    import offline

    offline.install()

    from cashu.core import paths

    data = (run / "data").resolve()
    assert paths.data_dir() == data, "data dir is not the run copy"
    assert paths.db_path() == data / "cashu.db", "database is not the run copy"
    imported, import_failed = import_all()

    import frozen

    frozen.install(os.environ["CASHU_PARITY_CLOCK"])

    import logging

    logging.basicConfig(filename=str(run / "child.log"), level=logging.WARNING, force=True)

    from cashu.core import db as core_db
    from cashu.core.db import init_db

    assert core_db.sqlite_file(str(core_db.engine.url)).resolve() == data / "cashu.db"
    init_db()
    offline_sources()
    payee_key(data)

    import canon

    canon.PATH_ALIASES[:] = [(str(data), "$DATA_DIR"), (str(run), "$RUN_DIR")]

    from checks import CHECKS, Ctx

    ctx = Ctx.open(name, frozen_clock=os.environ["CASHU_PARITY_CLOCK"])
    selected = [c for c in CHECKS if selects(c.name, only)]
    if only and not selected:
        print(f"[{name}] no check matches {only}")
    index: dict = {
        "format": FORMAT,
        "dataset": name,
        "clock": os.environ["CASHU_PARITY_CLOCK"],
        "tz": TZ,
        "source": os.environ.get("CASHU_PARITY_SOURCE"),
        "commit": os.environ.get("CASHU_PARITY_COMMIT") or None,
        "dirty": os.environ.get("CASHU_PARITY_DIRTY") == "1",
        "modules_imported": imported,
        "modules_import_failed": import_failed,
        "checks": [],
        "skipped": [],
    }
    errors = out / "errors.log"
    status = 0
    for check in selected:
        blocked_before = offline.blocked()
        dangling_before = ctx.ids.dangling
        try:
            data_obj, rows = check.run(ctx)
            text = canon.dumps(data_obj)
        except canon.UnmappedId as e:
            status = 1
            with errors.open("a") as fh:
                fh.write(f"{check.name}: unmapped id at {e.path}\n")
            print(f"[{name}] {check.name:<34} ERROR unmapped id (path in errors.log)")
            continue
        except Exception as e:  # noqa: BLE001 - report the type only; the traceback goes to the file
            status = 1
            with errors.open("a") as fh:
                fh.write(f"--- {check.name}\n{traceback.format_exc()}\n")
            print(f"[{name}] {check.name:<34} ERROR {type(e).__name__} (traceback in errors.log)")
            continue
        finally:
            ctx.reset()
        digest = canon.sha256(text)
        (out / f"{check.name}.json").write_text(text, encoding="utf-8")
        blocked = offline.blocked() - blocked_before
        dangling = ctx.ids.dangling - dangling_before
        index["checks"].append(
            {
                "check": check.name,
                "rows": rows,
                "sha256": digest,
                "network_blocked": blocked,
                "dangling_refs": dangling,
            }
        )
        print(
            f"[{name}] {check.name:<34} rows={rows:<6} sha256={digest}"
            + (f" network_blocked={blocked}" if blocked else "")
            + (f" dangling_refs={dangling}" if dangling else "")
        )
    for skipped in ctx.skipped:
        index["skipped"].append(skipped)
    index["natural_keys"] = ctx.ids.count()
    (out / "index.json").write_text(canon.dumps(index), encoding="utf-8")
    print(
        f"[{name}] {len(index['checks'])} checks written, {len(index['skipped'])} skipped items, "
        f"index sha256={canon.sha256(canon.dumps(index['checks']))}"
    )
    return status


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--dataset", choices=[*DATASETS, "all"], default="all")
    parser.add_argument(
        "--check", action="append", default=[], help="Run only this check (a name or a glob, repeatable)."
    )
    parser.add_argument(
        "--source-dir",
        type=Path,
        help="Copy this dir instead of the dataset's (inside ~/cashu-lab/parity/; one --dataset).",
    )
    parser.add_argument(
        "--manifest", choices=list(DATASETS), help="Print the dataset source's manifest as JSON and exit."
    )
    parser.add_argument(
        "--copy-dataset", choices=list(DATASETS), help="Copy the dataset source into --to (inside the parity tree)."
    )
    parser.add_argument("--to", type=Path, help="The target dir of --copy-dataset (must not exist).")
    parser.add_argument("--keep-run", action="store_true", help="Keep the run-<ts> copy.")
    parser.add_argument("--make-demo", action="store_true", help="Generate the demo dataset.")
    parser.add_argument(
        "--update-golden-demo",
        action="store_true",
        help="After a green demo run, copy its goldens into parity/golden-demo/ (committable).",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=OUT_ROOT,
        help="Golden root: writes <out>/<dataset>/ (default: the shared ~/cashu-lab/parity/out).",
    )
    parser.add_argument("--child", choices=list(DATASETS), help=argparse.SUPPRESS)
    parser.add_argument("--run-dir", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--child-out", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)

    if args.manifest:
        import json

        if not (DATASETS[args.manifest] / "cashu.db").is_file():
            print(json.dumps({"error": "no dataset"}))
            return 1
        n, digest = manifest(DATASETS[args.manifest])
        print(json.dumps({"manifest": digest, "files": n}))
        return 0
    if args.copy_dataset:
        if args.to is None:
            print("--copy-dataset needs --to")
            return 1
        return copy_dataset(args.copy_dataset, Path(os.path.abspath(args.to.expanduser())))
    source = None
    if args.source_dir is not None:
        if args.dataset == "all" or args.update_golden_demo:
            print("--source-dir needs one --dataset (lab or demo) and no --update-golden-demo")
            return 1
        if not source_dir_allowed(args.source_dir.expanduser()):
            print(f"--source-dir must be inside {PARITY_ROOT}")
            return 1
        source = Path(os.path.realpath(args.source_dir.expanduser()))
    if args.child:
        return child(args.child, args.run_dir, args.child_out, args.check)
    if "cashu" in sys.modules:
        raise SystemExit("the parent process must not import cashu")
    if args.make_demo:
        return make_demo()
    names = list(DATASETS) if args.dataset == "all" else [args.dataset]
    status = 0
    for n in names:
        status = max(
            status, run_dataset(n, args.check, args.keep_run, args.out.expanduser().resolve(), source)
        )
    if args.update_golden_demo:
        if status != 0 or "demo" not in names or args.check:
            print("golden-demo not updated: needs a full, green demo run")
            return status or 1
        target = REPO / "parity" / "golden-demo"
        if target.exists():
            shutil.rmtree(target)
        shutil.copytree(args.out.expanduser().resolve() / "demo", target)
        print(f"golden-demo updated ({len(list(target.glob('*.json')))} files)")
    return status


if __name__ == "__main__":
    sys.exit(main())
