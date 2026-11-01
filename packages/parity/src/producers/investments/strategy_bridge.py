# TRANSITIONAL(S14): supplies the parsed strategy inputs of the portfolio pipeline until the TS strategy loader lands; remove then.
"""Temporary bridge: what ``service/portfolio.build`` takes from a profile's strategy.

The TS ``investments.valuation`` / ``investments.allocation`` producers run the whole pipeline in
TS (``buildSnapshot`` -> ``valuePortfolio`` -> ``allocate``) from the dataset's rows, read through
``packages/parity/src/sources``. Only the strategy loader (``strategy/loader.py``, scope S14) is not
ported yet, so this script exports per profile exactly the strategy values ``build`` uses: the base
currency, the data-quality thresholds (``strategy.data`` or the ``DataQualityPolicy()`` defaults)
and the allocation plan (buckets in declaration order, targets in their dict order); for the
performance producer also the strategy state and the benchmark (its id as ``name``: canon.py would
treat an ``id`` field as a row id). Instrument
ids in bucket matches stay the app's domain ids (``str(pk)``), the ids the TS pipeline uses.

    .venv/bin/python packages/parity/src/producers/investments/strategy_bridge.py --dataset demo
    .venv/bin/python packages/parity/src/producers/investments/strategy_bridge.py --dataset demo --out ~/cashu-lab/parity/out-<branch>/bridge-strategy

It reuses golden.py's harness: the dataset is copied to a fresh run dir, the child runs offline with
the frozen clock and the run copy's ``CASHU_DATA_DIR``, the source is hashed before and after. The
output is canonical JSON in ``<lab>/parity/bridge-strategy/<dataset>/investments.strategy.json``
(golden.py's child: natural profile keys, an index); stdout shows counts and hashes only.
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

CHECK = "investments.strategy"
OUT_DIR = "bridge-strategy"  # not bridge/<dataset>: networth_bridge.py replaces that dir


def _match(match) -> dict:
    return {
        "asset_classes": sorted(a.value for a in match.asset_classes),
        "tags": sorted(match.tags),
        "mics": sorted(match.mics),
        "currencies": sorted(str(c) for c in match.currencies),
        # not ``*_ids``: canon.py would turn an id-like field into natural keys
        "pinned_instruments": sorted(str(i) for i in match.instrument_ids),
    }


def strategies(ctx) -> dict:
    from cashu.modules.investments.rules import DataQualityPolicy
    from cashu.modules.investments.service import strategy as strategy_files

    out: dict = {}
    for p in ctx.with_module("investments"):
        loaded = strategy_files.load(ctx.session, p)
        config = loaded.config
        data = config.data if config is not None else DataQualityPolicy()
        bench = config.benchmark if config is not None else None
        entry: dict = {
            "data": {
                "max_price_age_days": data.max_price_age_days,
                "max_fx_age_days": data.max_fx_age_days,
            },
            # what performance/service.load reads besides the portfolio inputs
            "state": loaded.state,
            "benchmark": None if bench is None else {"name": bench.id, "proxy": bench.proxy},
            "strategy": None,
        }
        if config is not None:
            entry["strategy"] = {
                "base_currency": str(config.base_currency),
                "buckets": [
                    {"bucket": b.id, "match": _match(b.match)} for b in config.allocation.buckets
                ],
                # pairs, not an object: the dict order decides where extra targets go
                "targets": [[k, float(v)] for k, v in config.allocation.targets.items()],
            }
        out[ctx.pkey(p)] = entry
    return out


def child(name: str, run: Path, out: Path) -> int:
    import checks

    checks.CHECKS.append(checks.Check(CHECK, strategies))
    return golden.child(name, run, out, [CHECK])


def parent(name: str, keep: bool, out_root: Path) -> int:
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
    out = out_root / name
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    env = golden.child_env(name, run, before)  # records the source commit (staleness guard)
    cmd = [sys.executable, str(HERE), "--child", name, "--run-dir", str(run), "--child-out", str(out)]
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
    parser.add_argument("--child-out", type=Path, help=argparse.SUPPRESS)
    parser.add_argument(
        "--out",
        type=Path,
        default=golden.PARITY_ROOT / OUT_DIR,
        help="Bridge root: writes <out>/<dataset>/ (default: the shared ~/cashu-lab/parity/bridge-strategy; a branch passes its own).",
    )
    args = parser.parse_args(argv)
    if args.child:
        return child(args.child, args.run_dir, args.child_out)
    if "cashu" in sys.modules:
        raise SystemExit("the parent process must not import cashu")
    if args.dataset is None:
        parser.error("--dataset is required")
    return parent(args.dataset, args.keep_run, args.out.expanduser().resolve())


if __name__ == "__main__":
    sys.exit(main())
