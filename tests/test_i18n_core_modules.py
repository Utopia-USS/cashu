"""English texts of core, budget, assets and loans (docs/agents/localization.md): module names and
setup steps, net-worth bucket labels, category labels, the default profile, the manual institution,
worker notifications, the desktop boot page, and MCP output pinned to Polish. Synthetic data."""

from __future__ import annotations

from types import SimpleNamespace

from cashu.core import account_types, i18n, institutions, modules, networth, profiles, runtime
from cashu.core.worker import connectors as worker_connectors
from cashu.core.worker import notifications
from cashu.desktop import shell
from cashu.modules.budget import imports as budget_imports
from cashu.modules.budget.categorize import taxonomy

EN = {"X-Cashu-Lang": "en"}


def test_labels_follow_the_language_and_polish_stays_for_mcp():
    modules.registry()
    assert account_types.bucket("money").label == "Pieniądze"  # MCP / CLI field stays Polish
    assert networth.component_labels()["property"] == "Nieruchomości"
    assert institutions.display_name("manual") == "Ręcznie"
    assert taxonomy.label("groceries") == "Spożywcze" and taxonomy.LABELS["groceries"] == "Spożywcze"
    with i18n.use_language("en"):
        labels = networth.component_labels()
        assert labels["money"] == "Money" and labels["mortgage"] == "Mortgage"
        assert (labels["property"], labels["vehicle"], labels["loan"]) == ("Property", "Car", "Loan")
        assert institutions.display_name("manual") == "Manual"
        assert institutions.display_name("mbank") == "mBank"
        assert taxonomy.label("cash_withdrawal") == "Cash withdrawal"
        assert taxonomy.label("unknown_key") == "unknown_key"
        assert set(taxonomy.LABELS_EN) == set(taxonomy.LABELS)
        assert budget_imports.format_name() == "cashU format"
        assert modules.get("loans").display_name() == "Loans"


def test_modules_and_setup_steps_in_english(api_empty):
    pl = {m["id"]: m for m in api_empty.get("/api/modules").json()}
    assert pl["budget"]["name"] == "Budżet domowy"
    en = {m["id"]: m for m in api_empty.get("/api/modules", headers=EN).json()}
    assert en["budget"]["name"] == "Home budget"
    assert en["assets"]["description"] == "Property, cars and other manually valued assets"
    assert en["loans"]["name"] == "Loans"

    slug = api_empty.post(
        "/api/profiles", json={"name": "Jan", "modules": ["budget", "assets", "loans"]}
    ).json()["slug"]

    def steps(module: str) -> list[dict]:
        r = api_empty.get(f"/api/p/{slug}/modules/{module}/setup", headers=EN)
        assert r.status_code == 200, r.text
        return r.json()["steps"]

    budget = steps("budget")
    assert budget[0]["title"] == "First bank statement"
    assert budget[0]["actions"][0]["label"] == "Copy command"
    assert budget[0]["actions"][0]["target"].endswith("import-csv STATEMENT.csv")
    assert budget[1]["actions"][0]["label"] == "Expenses"
    assets = steps("assets")
    assert [s["title"] for s in assets] == ["Position", "Car"]
    assert '"Flat"' in assets[0]["actions"][0]["target"]
    loans = steps("loans")
    assert loans[0]["title"] == "Loan" and '"Mortgage"' in loans[0]["actions"][0]["target"]
    assert loans[1]["title"] == "Recognizing installments"
    assert 'LOAN_ID --text "RATA KREDYTU"' in loans[1]["actions"][0]["target"]

    every = [t for m in (budget, assets, loans) for s in m for t in (s["title"], s["description"])]
    assert not any(ch in text for text in every for ch in "ąęółśżźćń—")


def test_investments_placeholder_setup_in_english():
    with i18n.use_language("en"):
        status = modules._investments_placeholder_setup(None, 0)
        spec = modules._PLACEHOLDERS["investments"]
        assert spec.display_name() == "Investments"
    assert status.steps[0].title == "Add a brokerage account"
    assert modules._investments_placeholder_setup(None, 0).steps[0].title == "Dodaj rachunek maklerski"


def test_categories_and_networth_labels_over_the_api(api):
    cats = {c["key"]: c["label"] for c in api.get("/api/categories", headers=EN).json()}
    assert cats["groceries"] == "Groceries" and cats["transfer"] == "Own transfer"
    assert api.get("/api/categories").json()[0]["label"] == "Spożywcze"
    spending = api.get("/api/spending", headers=EN).json()
    assert spending and all(r["label"] == taxonomy.LABELS_EN[r["category"]] for r in spending)
    series = api.get("/api/networth/series", headers=EN).json()
    labels = {c["key"]: c["label"] for c in series["components"]}
    assert labels["money"] == "Money"


def test_default_profile_name_is_shown_in_the_language(api_empty):
    with i18n.use_language("pl"):
        from cashu.core.db import get_session

        with get_session() as s:
            profiles.default_profile(s, create=True)
    pl = api_empty.get("/api/profiles").json()
    assert [p["name"] for p in pl if p["slug"] == "default"] == ["Domyślny"]
    en = api_empty.get("/api/profiles", headers=EN).json()
    assert [p["name"] for p in en if p["slug"] == "default"] == ["Default"]
    # A renamed default profile is user data: shown as stored.
    api_empty.patch("/api/profiles/default", json={"name": "Dom"})
    assert api_empty.get("/api/profiles/default", headers=EN).json()["name"] == "Dom"


def test_resync_errors_in_english(api, monkeypatch):
    from cashu import config

    monkeypatch.setattr(config.settings, "eb_app_id", None, raising=False)
    monkeypatch.setattr(type(config.settings), "eb_configured", property(lambda _self: False))
    r = api.post("/api/resync", headers=EN).json()
    assert r == {
        "ok": False,
        "error": "Enable Banking is not configured: CASHU_EB_APP_ID in the .env file in the cashU "
        "data folder.",
    }


def test_importer_choices_in_english(api_empty):
    with i18n.use_language("en"):
        choices = budget_imports.importer_choices()
    names = {c["id"]: c["name"] for c in choices}
    assert names["auto"] == "detect automatically"
    assert "cashU format" in names.values()


class _Recorder:
    name = "recorder"

    def __init__(self):
        self.sent = []

    def send(self, n):
        from cashu.core.worker.notifier import Delivery

        self.sent.append(n)
        return Delivery(True, self.name)


def test_worker_notification_texts_in_english():
    default = SimpleNamespace(slug="default", name="Domyślny", id=1)
    other = SimpleNamespace(slug="jan", name="Jan", id=2)
    assert notifications.title(default) == "cashU: Domyślny"
    assert notifications.digest_message(5) == "5 sygnałów do przeglądu"
    with i18n.use_language("en"):
        assert notifications.title(default) == "cashU: Default"
        assert notifications.title(other) == "cashU: Jan"
        assert notifications.severity_subtitle("action") == "Action signal"
        assert notifications.severity_subtitle("info") == "Info signal"
        assert notifications.severity_subtitle("other") == "Signal"
        assert notifications.signals_phrase(1) == "1 signal"
        assert notifications.digest_message(0) == "No signals to review"
        assert notifications.digest_message(3) == "3 signals to review"
        rec = _Recorder()
        result = SimpleNamespace(
            preview={"new": 2}, connector_name="Broker X", binding_id=7, module="budget"
        )
        assert worker_connectors.notify_proposal(rec, other, result)
    n = rec.sent[0]
    assert (n.title, n.subtitle, n.message) == (
        "cashU: Jan", "Import awaiting approval", "Broker X: 2 new records"
    )


def test_translocated_snippet_and_boot_page_in_english():
    assert runtime.translocated_snippet() == runtime.TRANSLOCATED_SNIPPET
    assert shell.loading_html() == shell.LOADING_HTML
    with i18n.use_language("en"):
        snippet = runtime.translocated_snippet()
        assert snippet.startswith("# ") and "Applications" in snippet
        page = shell.loading_html()
        assert '<html lang="en">' in page and "Starting cashU…" in page
        err = shell.error_html("boom", None)
        assert "cashU could not start" in err and "Szczeg" not in err


def test_mcp_output_stays_polish_with_an_english_app_language(db_engine, monkeypatch):
    from mcp_support import TODAY, seed_profile

    from cashu.core.mcp import labels as L
    from cashu.core.mcp.registry import ToolSpec
    from cashu.core.mcp.server import CashuMcp

    monkeypatch.setenv(i18n.LANG_ENV, "en")  # the stored app language is English
    assert i18n.lang() == "en"
    pid, _slug = seed_profile(run_daily=False)
    host = CashuMcp(pid, today=TODAY)

    def handler(_ctx):
        return {"label": L.category(i18n.tr(pl="Pieniądze", en="Money"))}

    host._tools["profile_overview"] = ToolSpec("profile_overview", "core", "x", handler)
    result = host.call("profile_overview", {})
    assert result.ok, result.error
    assert result.data == {"label": "Pieniądze"}
