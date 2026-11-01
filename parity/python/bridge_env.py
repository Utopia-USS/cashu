#!/usr/bin/env python3
"""The environment of every Python child of a bridge harness run (S31a spec 9.2), as one JSON object.

    .venv/bin/python parity/python/bridge_env.py --run <run dir> --dataset lab|demo [--sync]

golden.py ``safe_env(home=<run>/home, data=<run>/data, workspaces=<run>/workspaces, extra=<run>)`` (the
dirs are created; ``data/`` is the harness's copy and is not), plus the lab keyring
(``PYTHON_KEYRING_BACKEND=parity.python.lab_keyring.FileKeyring``, ``CASHU_LAB_KEYRING=<run>/keys/
keyring.json``, ``keys/`` created 0700), the dataset's frozen clock (``CASHU_PARITY_CLOCK``),
``PYTHONPATH=<repo root>`` (so ``parity.python.lab_keyring`` imports) and ``CASHU_SYNC=1`` only with
``--sync``. The harness passes it verbatim to ``cashu``, ``bridge_writes.py`` and the data-dir check.
Refuses a run dir outside ``~/cashu-lab/parity/`` (resolved, case-insensitive) or inside a dataset
source. Never imports cashU.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
sys.path.insert(0, str(HERE))

import golden  # the sibling module (no cashU import)

KEYRING_BACKEND = "parity.python.lab_keyring.FileKeyring"


def run_dir_allowed(run: Path) -> bool:
    if not golden.source_dir_allowed(run):
        return False
    real = os.path.realpath(run).casefold()
    for source in golden.DATASETS.values():
        base = os.path.realpath(source).casefold()
        if real == base or real.startswith(base.rstrip(os.sep) + os.sep):
            return False
    return True


def bridge_env(run: Path, dataset: str, *, sync: bool) -> dict[str, str]:
    env = golden.safe_env(run / "home", run / "data", run / "workspaces", run)
    keys = run / "keys"
    keys.mkdir(mode=0o700, exist_ok=True)
    keys.chmod(0o700)
    env.update(
        {
            "PYTHON_KEYRING_BACKEND": KEYRING_BACKEND,
            "CASHU_LAB_KEYRING": str(keys / "keyring.json"),
            "CASHU_PARITY_CLOCK": golden.CLOCKS[dataset],
            "PYTHONPATH": str(REPO),
        }
    )
    if sync:
        env["CASHU_SYNC"] = "1"
    return env


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--dataset", choices=list(golden.DATASETS), required=True)
    parser.add_argument("--sync", action="store_true", help="Add CASHU_SYNC=1.")
    args = parser.parse_args(argv)
    run = Path(os.path.realpath(args.run.expanduser()))
    if not run_dir_allowed(run):
        print(json.dumps({"error": f"--run must be inside {golden.PARITY_ROOT} and not a dataset"}))
        return 1
    if not run.is_dir():
        print(json.dumps({"error": "--run does not exist"}))
        return 1
    print(json.dumps(bridge_env(run, args.dataset, sync=args.sync), sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
