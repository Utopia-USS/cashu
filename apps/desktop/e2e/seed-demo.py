"""Run the original synthetic generator with a completed historical research run.

The generator finishes research at its start plus twelve minutes. Its fixture run starts
twenty minutes ago, so genesis and the real host clock see completed work, without changing
financial dates, model defaults, the generator or any drift guard.
"""

import argparse
import datetime as dt
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
from unittest.mock import patch


def main() -> int:
    root_value = os.environ.get("E2E_ROOT")
    if os.environ.get("CASHU_TESTING") != "1" or not root_value:
        raise SystemExit("explicit isolated Electron fixture setup is required")
    root = Path(root_value).resolve()
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--force", action="store_true")
    args, _ = parser.parse_known_args(sys.argv[2:])
    if (not root.is_relative_to(Path(tempfile.gettempdir()).resolve())
            or not root.name.startswith("cashu-e2e-desktop-") or args.force
            or Path(args.data_dir).resolve() != root / "data"):
        raise SystemExit("the Electron fixture target must be its isolated temp data directory")
    generator = Path(sys.argv[1]).resolve()
    if generator != Path(__file__).resolve().parents[3] / "scripts" / "demo_data.py":
        raise SystemExit("the original checkout demo generator is required")
    spec = importlib.util.spec_from_file_location("cashu_e2e_demo_generator", generator)
    if spec is None or spec.loader is None:
        raise RuntimeError("synthetic generator is unavailable")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    # This module's top level imports stdlib only. Its original main still owns fresh-interpreter
    # and data-dir guards before any cashU import or fixture setup.
    spec.loader.exec_module(module)
    original = module.Seeder.research

    def research(seeder: object, plan: object, profile: object) -> None:
        from cashu.core import models
        # Keep existing service aliases/default factories on the real clock. Only the generator's
        # local import of models.utcnow supplies this historical research run's explicit start.
        from cashu.modules.investments.research import service, topic_theses  # noqa: F401

        started = models.utcnow() - dt.timedelta(minutes=20)
        with patch.object(models, "utcnow", new=lambda: started):
            original(seeder, plan, profile)

    module.Seeder.research = research
    sys.argv = [str(generator), *sys.argv[2:]]
    return module.main()


if __name__ == "__main__":
    raise SystemExit(main())
