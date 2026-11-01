# TRANSITIONAL(S38a): supplies the MCP name providers' outputs until their TS ports land; remove then.
"""Temporary bridge: what the MCP name guard is collected from, per profile, for the TS privacy layer.

``core/mcp/names.collect`` builds a profile's guard from the profile name, the stored account names
(both read in TS through ``PythonDb``) and the modules' name providers (``NAME_PROVIDERS``:
``tools/budget.name_sources`` over the bank transactions, ``tools/investments.strong_names`` /
``name_sources`` / ``strict_aliases`` over the instruments). The providers are not ported yet (S38a),
so this script exports their raw outputs; the TS producer runs the ported ``collect`` on them. The
macro summary vocabulary the ``market`` label's gate needs comes from the TS port of
``investments/macro/texts`` (S20).

    .venv/bin/python packages/parity/src/producers/mcp/guard_bridge.py --dataset demo

It reuses golden.py's harness (run copy, offline, frozen clock, source hashed before and after).
Output: ``<out>/<dataset>/mcp.guard_sources.json``, ``<out>`` = ``--out`` or the shared
``<lab>/parity/bridge-mcp`` (lab/ts-stack HEAD only; a branch passes its own dir and hands the same
dir to ``pnpm parity:produce --bridge-mcp``); stdout shows counts and hashes only.
The lab output holds real names: it stays in the lab dir, never in git, never printed.
"""

from __future__ import annotations

import argparse
import datetime as dt
import importlib
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

CHECK = "mcp.guard_sources"


def guard_sources(ctx) -> dict:
    from cashu.core.mcp.names import NAME_PROVIDERS

    profiles: dict = {}
    for p in ctx.profiles:
        providers = []
        for provider in NAME_PROVIDERS:
            module = importlib.import_module(provider)
            strong = getattr(module, "strong_names", lambda *_: set())(ctx.session, p.id)
            persons, private = module.name_sources(ctx.session, p.id)
            aliases = getattr(module, "strict_aliases", lambda *_: [])(ctx.session, p.id)
            symbols = getattr(module, "known_symbols", lambda *_: set())(ctx.session, p.id)
            providers.append(
                {
                    "provider": provider.rsplit(".", 1)[-1],
                    "strong": sorted(strong),
                    "persons": sorted(persons),
                    "private": sorted(private),
                    "aliases": [list(a) for a in aliases],
                    "symbols": sorted(symbols),  # S37fix R5: digit-only tickers
                }
            )
        ctx.session.rollback()
        profiles[ctx.pkey(p)] = {"providers": providers}
    return {"profiles": profiles}


def child(name: str, run: Path, out: Path) -> int:
    import checks

    checks.CHECKS.append(checks.Check(CHECK, guard_sources, per_profile=False))
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
    golden.copy_source(source, run / "data")
    out = out_root / name
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    env = golden.child_env(name, run, before)
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
    parser.add_argument(
        "--out",
        type=Path,
        default=golden.PARITY_ROOT / "bridge-mcp",
        help="Bridge root: writes <out>/<dataset>/ (default: the shared ~/cashu-lab/parity/bridge-mcp).",
    )
    parser.add_argument("--child", choices=list(golden.DATASETS), help=argparse.SUPPRESS)
    parser.add_argument("--run-dir", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--child-out", type=Path, help=argparse.SUPPRESS)
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
