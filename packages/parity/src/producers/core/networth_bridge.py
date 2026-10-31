"""Temporary bridge: the net-worth values of the module contributors the TS port does not have yet.

The TS ``core.networth`` producer recomputes everything core owns from the dataset's rows (accounts,
balance snapshots, the cash pool's transactions) through ``packages/parity/src/sources``. The loans
(S11), assets (S11) and investments (S13) contributors are not ported yet, so this script exports
only their results: per profile and module, the accounts that module values and its
``Valuation.latest(as_of)`` for "now" and for as_of - 365 days (what ``checks/core.py`` asks).
A module drops out of ``BRIDGED`` the day its TS contributor lands; the bridge is deleted with the
last one.

    .venv/bin/python packages/parity/src/producers/core/networth_bridge.py --dataset demo

It reuses golden.py's harness: the dataset is copied to a fresh run dir, the child runs offline with
the frozen clock and the run copy's ``CASHU_DATA_DIR``, the source is hashed before and after. The
output is canonical JSON (natural keys, Decimal strings) in
``<lab>/parity/bridge/<dataset>/core.networth_contributors.json``; stdout shows counts and hashes only.
"""

from __future__ import annotations

import argparse
import datetime as dt
import os
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve()
REPO = HERE.parents[5]
PARITY_PY = REPO / "parity" / "python"
sys.path.insert(0, str(PARITY_PY))

import golden  # parity/python is on the path; golden never imports cashu at import time

CHECK = "core.networth_contributors"
BRIDGED = ("loans", "assets", "investments")


def contributors(ctx) -> dict:
    from sqlmodel import select

    from cashu.core import modules
    from cashu.core.models import Account

    year_ago = ctx.as_of - dt.timedelta(days=365)
    out: dict = {}
    for p in ctx.profiles:
        accounts = {
            a.id: a
            for a in ctx.session.exec(
                select(Account).where(Account.profile_id == p.id, Account.removed_at.is_(None))
            ).all()
        }
        per_module: dict = {}
        for spec in modules.all_modules():
            if spec.id not in BRIDGED or spec.networth is None:
                continue
            values: dict = {}
            for acc_id, v in spec.networth.valuations(ctx.session, accounts).items():
                entries = {}
                for label, as_of in (("now", None), ("year_ago", year_ago)):
                    entry = v.latest(as_of)
                    entries[label] = None if entry is None else {"as_of": entry[0], "amount": entry[1]}
                values[ctx.ids.key("accounts", acc_id)] = entries
            per_module[spec.id] = values
        out[ctx.pkey(p)] = {"year_ago": year_ago, "modules": per_module}
    return out


def child(name: str, run: Path, out: Path) -> int:
    import checks

    checks.CHECKS.append(checks.Check(CHECK, contributors))
    return golden.child(name, run, out, [CHECK])


def parent(name: str, keep: bool) -> int:
    source = golden.DATASETS[name]
    if not (source / "cashu.db").is_file():
        print(f"[{name}] no dataset at its source dir")
        return 1
    before = golden.manifest(source)
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    run = golden.PARITY_ROOT / f"bridge-run-{stamp}-{name}"
    run.mkdir(parents=True)
    os.chmod(run, 0o700)
    shutil.copytree(source, run / "data")
    out = golden.PARITY_ROOT / "bridge" / name
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    env = golden.safe_env(run / "home", run / "data", run / "workspaces", run)
    env["CASHU_PARITY_CLOCK"] = golden.CLOCKS[name]
    env["CASHU_PARITY_SOURCE"] = f"{before[0]} files, manifest sha256 {before[1]}"
    cmd = [sys.executable, str(HERE), "--child", name, "--run-dir", str(run), "--out", str(out)]
    proc = subprocess.run(cmd, env=env, cwd=run, check=False)
    after = golden.manifest(source)
    if before != after:
        print(f"[{name}] FAIL: the source dataset changed during the run")
        return 2
    if not keep:
        shutil.rmtree(run, ignore_errors=True)
    return proc.returncode


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--dataset", choices=list(golden.DATASETS))
    parser.add_argument("--keep-run", action="store_true")
    parser.add_argument("--child", choices=list(golden.DATASETS), help=argparse.SUPPRESS)
    parser.add_argument("--run-dir", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--out", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    if args.child:
        return child(args.child, args.run_dir, args.out)
    if "cashu" in sys.modules:
        raise SystemExit("the parent process must not import cashu")
    if args.dataset is None:
        parser.error("--dataset is required")
    return parent(args.dataset, args.keep_run)


if __name__ == "__main__":
    sys.exit(main())
