"""Registries: modules (ModuleSpec), account types, net-worth buckets, institutions."""

from __future__ import annotations

from pathlib import Path

import pytest

from cashu.core import account_types, institutions, modules
from cashu.core.modules import ModuleSpec, SetupAction, SetupStatus, SetupStep
from cashu.modules.budget.ingestion.csv_import import detect_importer, get_importer
from cashu.modules.budget.ingestion.enable_banking.sync import bank_from_aspsp

# --------------------------------------------------------------------------- #
# Modules
# --------------------------------------------------------------------------- #


def test_registry_lists_modules_in_display_order():
    reg = modules.registry()
    assert list(reg) == ["budget", "assets", "loans", "investments"]
    for module_id in ("budget", "assets", "loans"):
        spec = reg[module_id]
        assert spec.available and spec.cli is not None and spec.setup_status is not None
        assert spec.networth is not None and spec.tables and spec.skill == f"/{module_id}-setup"
    assert reg["budget"].router is not None and reg["loans"].router is not None


def test_investments_spec():
    spec = modules.get("investments")
    assert spec.available is True and spec.name == "Inwestycje"
    assert spec.router is not None and spec.router.prefix == "/investments"
    assert spec.cli is None and spec.cli_module is not None and spec.cli_name == "invest"
    assert spec.networth is not None and spec.tables and spec.skill == "/investments-setup"
    assert {i.id: i.kind for i in spec.institutions} == {
        "dif": "broker", "xtb": "broker", "binance": "exchange", "zonda": "exchange",
    }
    assert set(institutions.ids("broker")) >= {"dif", "xtb"}
    assert set(institutions.ids("exchange")) == {"binance", "zonda"}
    assert "dif" not in institutions.ids("bank") and "dif" not in institutions.csv_ids()


def test_unknown_module():
    with pytest.raises(KeyError):
        modules.get("nope")


def test_dependencies_are_enabled_together(monkeypatch):
    reg = dict(modules.registry())
    reg["extra"] = ModuleSpec(id="extra", name="Extra", description="x", depends_on=("budget",))
    monkeypatch.setattr(modules, "_registry", reg)
    assert modules.with_dependencies(["extra"]) == ["budget", "extra"]
    assert modules.with_dependencies(["loans", "budget"]) == ["budget", "loans"]


def test_setup_status_states_and_step_statuses():
    def steps(*done: bool) -> SetupStatus:
        return SetupStatus(steps=tuple(
            SetupStep(f"s{i}", "T", "D", d, (SetupAction("cli", "Kopiuj", "cashu x"),))
            for i, d in enumerate(done)
        ))

    assert steps(False, False).state == "empty"
    assert [s["status"] for s in steps(False, False).step_dicts()] == ["on", "todo"]
    assert steps(True, False, False).state == "partial"
    assert [s["status"] for s in steps(True, False, False).step_dicts()] == ["done", "on", "todo"]
    assert steps(True, True).state == "ready"
    assert steps(False, True).step_dicts()[1]["status"] == "done"  # done stays done
    assert SetupStatus(steps=()).state == "empty"
    assert steps(True).step_dicts()[0]["actions"] == [
        {"kind": "cli", "label": "Kopiuj", "target": "cashu x"}
    ]


def test_categorization_hooks_come_from_modules():
    assert ("RATA KREDYTU", "loans") in modules.text_rules()
    assert "loans" in modules.not_subscription_categories()
    from cashu.modules.budget.categorize import taxonomy

    assert taxonomy.apply_text_rules("SPLATA RATY 05/2026") == "loans"  # registered by loans
    assert taxonomy.apply_text_rules("CZYNSZ ZA WRZESIEN") == "housing"  # budget's own


# --------------------------------------------------------------------------- #
# Account types and net-worth buckets
# --------------------------------------------------------------------------- #


def test_account_types_carry_module_metadata():
    modules.registry()
    by_id = {t.id: t for t in account_types.all_types()}
    assert set(by_id) == {
        "checking", "savings", "credit", "cash", "property", "vehicle", "investment", "other",
        "mortgage", "loan", "brokerage",
    }
    assert (by_id["credit"].module, by_id["credit"].sign) == ("budget", "credit")
    assert (by_id["mortgage"].module, by_id["mortgage"].sign, by_id["mortgage"].liquid,
            by_id["mortgage"].bucket) == ("loans", "liability", False, "mortgage")
    assert (by_id["vehicle"].module, by_id["vehicle"].liquid, by_id["vehicle"].bucket) == (
        "assets", False, "vehicle"
    )
    assert by_id["investment"].liquid and by_id["investment"].bucket == "money"
    assert (by_id["brokerage"].module, by_id["brokerage"].sign, by_id["brokerage"].liquid,
            by_id["brokerage"].bucket) == ("investments", "asset", True, "investments")
    assert [b.id for b in account_types.buckets()] == [
        "money", "investments", "property", "vehicle", "mortgage", "loan"
    ]
    assert {b.id for b in account_types.buckets() if b.liability} == {"mortgage", "loan"}


def test_unknown_account_type_is_a_liquid_asset():
    info = account_types.get("brokerage-test")
    assert (info.sign, info.liquid, info.bucket) == ("asset", True, "money")


def test_conflicting_registration_is_rejected():
    with pytest.raises(ValueError, match="already registered"):
        account_types.register_type(account_types.AccountTypeInfo("credit", "other", "X"))
    account_types.register_type(account_types.get("credit"))  # the same entry again is fine


# --------------------------------------------------------------------------- #
# Institutions
# --------------------------------------------------------------------------- #


def test_builtin_institutions_keep_the_upstream_ids():
    assert {"mbank", "erste", "pekao", "manual"} <= set(institutions.ids())
    assert institutions.get("manual").kind == "manual"
    assert institutions.csv_ids() == ["mbank", "erste", "pekao"]
    assert institutions.display_name("erste") == "Erste Bank Polska"
    assert institutions.display_name("gone-bank") == "gone-bank"  # never raises


def test_open_banking_aspsp_mapping():
    assert bank_from_aspsp("mBank S.A.") == "mbank"
    assert bank_from_aspsp("Santander Bank Polska") == "erste"
    assert bank_from_aspsp("Erste Bank Polska") == "erste"
    assert bank_from_aspsp("Bank Pekao SA") == "pekao"
    assert bank_from_aspsp("Bank Millennium") == "millennium"
    with pytest.raises(ValueError, match="pass bank explicitly"):
        bank_from_aspsp("Bank Test")


def test_csv_importers_come_from_the_registry():
    assert get_importer("mbank").bank == "mbank"
    with pytest.raises(ValueError, match="No CSV importer"):
        get_importer("millennium")
    with pytest.raises(ValueError, match="Unknown bank"):
        get_importer("nope")


def test_adding_a_bank_is_one_registry_entry(monkeypatch, tmp_path: Path):
    """A new bank: a parser config (here: a subclass of an existing one) + one entry."""
    import sys
    import types

    from cashu.modules.budget.ingestion.csv_import.mbank import MBankImporter

    mod = types.ModuleType("cashu_test_bank")

    class TestBankImporter(MBankImporter):
        bank = "testbank"
        signature = ("testbank s.a.",)

    mod.TestBankImporter = TestBankImporter
    monkeypatch.setitem(sys.modules, "cashu_test_bank", mod)
    monkeypatch.setattr(institutions, "_REGISTRY", dict(institutions._REGISTRY))
    monkeypatch.setattr(institutions, "_IMPORTERS", {})
    institutions.register(institutions.Institution(
        "testbank", "bank", "Bank Test", "cashu_test_bank:TestBankImporter", ("testbank",)
    ))
    assert "testbank" in institutions.csv_ids()
    assert bank_from_aspsp("TestBank Online") == "testbank"
    f = tmp_path / "statement.csv"
    f.write_text("TestBank S.A.;\nnothing else\n", encoding="utf-8")
    assert detect_importer(f).bank == "testbank"
