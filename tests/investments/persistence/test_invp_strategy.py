"""Strategy files of a profile: states, versions, templates, and the loader's partial config
(the additive ``StrategyLoadResult.partial`` / ``inactive_rules``)."""

from __future__ import annotations

import pytest
from invp_support import STRATEGY_YAML, make_profile
from sqlmodel import select

from cashu.core.db import get_session
from cashu.core.models import Profile
from cashu.modules.investments.models import InvStrategyVersion
from cashu.modules.investments.service import files
from cashu.modules.investments.service import strategy as strategy_files
from cashu.modules.investments.strategy import load_strategy


def test_partial_config_when_only_rules_have_errors():
    broken = STRATEGY_YAML.replace("max_weight: 0.30", "max_weight: 2").replace(
        "kind: cash_level", "kind: cash_levle"
    )
    result = load_strategy(broken)
    assert result.config is None and not result.is_valid
    assert result.partial is not None and result.partial.rules == ()
    assert [(r.index, r.rule_id, r.kind) for r in result.inactive_rules] == [
        (0, "concentration", "position_concentration"),
        (1, "idle_cash", "cash_levle"),
    ]
    assert all(r.line and r.issues and r.issues[0].is_error for r in result.inactive_rules)
    one_broken = load_strategy(STRATEGY_YAML.replace("kind: cash_level", "kind: nope"))
    assert [r.id for r in one_broken.partial.rules] == ["concentration"]
    assert one_broken.partial.allocation.targets == {"stocks": 0.9, "cash": 0.1}


def test_no_partial_config_for_errors_outside_rules():
    result = load_strategy(STRATEGY_YAML.replace("stocks: 0.9", "stocks: 0.5"))  # targets sum
    assert result.config is None and result.partial is None and result.inactive_rules == ()
    valid = load_strategy(STRATEGY_YAML)
    assert valid.config is not None and valid.partial is None and valid.inactive_rules == ()


def test_states_and_versions(db_engine):
    pid, slug = make_profile()
    with get_session() as s:
        profile = s.get(Profile, pid)
        assert strategy_files.load(s, profile, record=True).state == "missing"
        files.write_text_private(files.strategy_yaml_path(slug), STRATEGY_YAML)
        st = strategy_files.load(s, profile)
        assert (st.state, st.version, st.changed) == ("valid", None, True)  # not recorded on read
        st = strategy_files.load(s, profile, record=True)
        assert st.version.version == 1 and not st.changed
        assert strategy_files.load(s, profile, record=True).version.version == 1  # unchanged
        files.write_text_private(files.strategy_md_path(slug), "Cel: emerytura.")
        assert strategy_files.load(s, profile, record=True).version.version == 2  # md counts
        files.write_text_private(files.strategy_yaml_path(slug), "version: [")
        st = strategy_files.load(s, profile, record=True)
        assert st.state == "invalid" and st.version.version == 3 and st.config is None
        assert st.issues[0].line == 1
        rows = s.exec(select(InvStrategyVersion).order_by(InvStrategyVersion.version)).all()
        assert [(r.version, r.state) for r in rows] == [(1, "valid"), (2, "valid"), (3, "invalid")]
        assert rows[2].issues[0]["severity"] == "error"


def test_init_from_template(db_engine):
    _pid, slug = make_profile()
    written = strategy_files.init_files(slug, "blank")
    assert [p.name for p in written] == ["strategy.yaml", "strategy.md"]
    assert written[0].stat().st_mode & 0o077 == 0
    with pytest.raises(strategy_files.StrategyExists):
        strategy_files.init_files(slug)
    strategy_files.init_files(slug, "passive_etf", force=True)
    assert "global_equity" in written[0].read_text()
    with pytest.raises(KeyError):
        strategy_files.init_files(slug, "nope", force=True)


def test_profile_dirs_reject_path_tricks():
    for bad in ("../x", "a/b", "", ".hidden"):
        with pytest.raises(ValueError):
            files.profile_dir(bad)
    with pytest.raises(ValueError):
        files.staged_path("ok", "../../etc/passwd", "x.csv")
