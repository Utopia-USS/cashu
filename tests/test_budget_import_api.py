"""In-app statement import (F10 first steps B2-B4, B6): preview (read-only, staged file) -> commit (one
write: statement, transfers, categories), importer choice, error codes, transfer matching. Synthetic."""

from __future__ import annotations

import json

import pytest
from sqlmodel import func, select

from cashu.core import institutions
from cashu.core.db import get_session
from cashu.core.models import Account, Source
from cashu.modules.budget import imports
from cashu.modules.budget.models import ImportBatch, Transaction

MBANK_CSV = """mBank S.A.
#Numer rachunku
99 1140 0000 0000 0000 0000 0101
#Waluta
PLN
#Data operacji;#Opis operacji;#Tytuł;#Nadawca/Odbiorca;#Numer konta;#Kwota;#Saldo po operacji
2026-09-01;PRZELEW PRZYCHODZACY;WYNAGRODZENIE 08/2026;PRACODAWCA TEST;99102000000000000000000777;9 000,00;9 500,00
2026-09-03;ZAKUP PRZY UZYCIU KARTY;BIEDRONKA 123 TEST;BIEDRONKA TEST;;-120,50;9 379,50
2026-09-05;PRZELEW WYCHODZACY;RATA KREDYTU HIPOTECZNEGO;BANK HIPOTECZNY TEST;99160000000000000000000555;-3 000,00;6 379,50
2026-09-11;PRZELEW WYCHODZACY;OSZCZEDNOSCI;JAN TEST;99109000000000000000000303;-1 000,00;5 379,50
Suma;;;;;;
""".encode("cp1250")

# The savings side of the 2026-09-11 transfer, in the cashU format (another bank, own account).
SAVINGS_DOC = {
    "format": "cashu-budget-import",
    "format_version": 1,
    "source": "erste_api",
    "account": {"iban": "PL99109000000000000000000303", "name": "Oszczędności Test", "currency": "PLN",
                "institution": "erste"},
    "balances": [{"date": "2026-09-30", "amount": "21000.00"}],
    "transactions": [
        {"booking_date": "2026-09-11", "amount": "1000.00", "currency": "PLN",
         "counterparty_name": "JAN TEST", "counterparty_iban": "99114000000000000000000101",
         "reference": "OSZCZEDNOSCI", "transaction_id": "E1"},
    ],
}


@pytest.fixture
def jan(api_empty):
    api_empty.post("/api/profiles", json={"name": "Jan", "modules": ["budget", "loans", "assets"]})
    return api_empty


def preview(client, content: bytes, name="wyciag.csv", slug="jan", **fields):
    return client.post(
        f"/api/p/{slug}/budget/import/preview",
        files={"file": (name, content, "text/csv")},
        data={k: str(v) for k, v in fields.items()},
    )


def commit(client, body: dict, slug="jan"):
    return client.post(f"/api/p/{slug}/budget/import/commit", json=body)


def code(resp) -> str | None:
    return resp.headers.get("x-cashu-error-code")


def counts() -> tuple[int, int, int]:
    with get_session() as s:
        return (
            s.exec(select(func.count(Account.id))).one(),
            s.exec(select(func.count(Transaction.id))).one(),
            s.exec(select(func.count(ImportBatch.id))).one(),
        )


def staged_files(tmp_path) -> list:
    folder = tmp_path / "data" / "imports" / "jan" / ".staging"
    return sorted(p.name for p in folder.glob("budget-*")) if folder.is_dir() else []


def test_importer_choices_match_the_registry(jan):
    """B6: the drawer's bank list comes from the server (no FE constant to keep in sync)."""
    body = jan.get("/api/p/jan/budget/import/importers").json()
    ids = [c["id"] for c in body["importers"]]
    assert ids == ["auto", *institutions.csv_ids(), "cashu-budget"]
    names = {c["id"]: c["name"] for c in body["importers"]}
    assert names["mbank"] == institutions.display_name("mbank")
    assert {c["kind"] for c in body["importers"]} == {"auto", "bank", "format"}
    assert body["max_bytes"] == imports.MAX_FILE_BYTES


def test_preview_is_read_only_and_commit_writes_once(jan, tmp_path):
    before = counts()
    r = preview(jan, MBANK_CSV, account_type="checking", account_name="mKonto Test")
    assert r.status_code == 200, r.text
    p = r.json()
    assert counts() == before  # nothing written
    assert set(p) == {
        "file_id", "file_name", "bank", "account", "counts", "range", "balances", "rows",
        "previous_imports", "warnings",
    }
    assert len(p["file_id"]) == 64 and p["file_name"] == "wyciag.csv"
    assert p["bank"] == {"id": "mbank", "name": "mBank", "detected": True}
    assert p["account"] == {
        "existing": False, "id": None, "name": "mKonto Test", "currency": "PLN", "iban_tail": "0101",
        "transactions": 0, "institution": {"id": "mbank", "name": "mBank"},
        "remembered_importer": None,
    }
    assert p["counts"] == {"rows": 5, "new": 4, "duplicates": 0, "overlap": 0, "skipped": 1}
    assert p["range"] == {"from": "2026-09-01", "to": "2026-09-11"}
    assert p["balances"] == 4 and p["previous_imports"] == [] and p["warnings"] == []
    assert p["rows"][1] == {
        "row": 2, "date": "2026-09-03", "amount": -120.5, "currency": "PLN",
        "title": "BIEDRONKA 123 TEST", "counterparty": "BIEDRONKA TEST", "status": "new",
        "overlap": False,
    }
    assert staged_files(tmp_path) == [f"budget-{p['file_id']}.csv"]

    c = commit(jan, {"file_id": p["file_id"], "file_name": p["file_name"], "bank": p["bank"]["id"],
                     "account_type": "checking", "account_name": "mKonto Test"})
    assert c.status_code == 201, c.text
    done = c.json()
    assert set(done) == {
        "batch_id", "account", "inserted", "duplicates", "skipped", "balances", "categorized",
        "transfer_pairs",
    }
    assert done["account"]["created"] is True and done["account"]["name"] == "mKonto Test"
    assert done["account"]["iban_tail"] == "0101" and done["account"]["currency"] == "PLN"
    assert (done["inserted"], done["duplicates"], done["skipped"]) == (4, 0, 1)
    assert done["categorized"] >= 1  # at least the installment, by its phrase
    assert done["transfer_pairs"] == 0
    assert staged_files(tmp_path) == []  # dropped after the commit
    with get_session() as s:
        acc = s.get(Account, done["account"]["id"])
        assert acc.bank == "mbank" and acc.type == "checking"
        batch = s.get(ImportBatch, done["batch_id"])
        assert batch.filename == "wyciag.csv" and batch.notes == f"sha256:{p['file_id']} importer:mbank"
        cats = {t.reference: t.category for t in s.exec(
            select(Transaction).where(Transaction.account_id == acc.id)).all()}
    assert cats["RATA KREDYTU HIPOTECZNEGO"] == "loans"  # categorized in the same write

    # The same file again: everything duplicate, the earlier import listed, commit inserts nothing.
    again = preview(jan, MBANK_CSV, name="inna-nazwa.csv").json()
    assert again["account"]["existing"] is True and again["account"]["transactions"] == 4
    assert again["counts"]["new"] == 0 and again["counts"]["duplicates"] == 4
    assert {r["status"] for r in again["rows"]} == {"duplicate"}
    (prev,) = again["previous_imports"]
    assert prev["same_file"] is True and prev["file_name"] == "wyciag.csv" and prev["inserted"] == 4
    c2 = commit(jan, {"file_id": again["file_id"], "file_name": "inna-nazwa.csv"}).json()
    assert c2["inserted"] == 0 and c2["duplicates"] == 4 and c2["account"]["created"] is False


def test_a_cashu_document_matches_by_number_and_pairs_the_transfer(jan):
    first = preview(jan, MBANK_CSV).json()
    commit(jan, {"file_id": first["file_id"], "file_name": first["file_name"]})
    content = json.dumps(SAVINGS_DOC).encode()
    for importer in ("auto", "cashu-budget"):
        p = preview(jan, content, name="oszczednosci.json", bank=importer)
        assert p.status_code == 200, p.text
        body = p.json()
        assert body["bank"] == {
            "id": "cashu-budget", "name": "Format cashU", "detected": importer == "auto",
        }
    assert body["account"]["existing"] is False and body["account"]["institution"]["id"] == "erste"
    assert body["account"]["name"] == "Oszczędności Test" and body["balances"] == 1
    done = commit(jan, {"file_id": body["file_id"], "file_name": "oszczednosci.json",
                        "bank": "cashu-budget", "account_type": "savings"}).json()
    assert done["inserted"] == 1 and done["transfer_pairs"] == 1 and done["balances"] == 1
    with get_session() as s:
        acc = s.get(Account, done["account"]["id"])
        assert (acc.bank, acc.type) == ("erste", "savings")
        t = s.exec(select(Transaction).where(Transaction.account_id == acc.id)).one()
        assert t.source == Source.CSV and t.is_internal_transfer and t.category == "transfer"
    # Re-importing the document by number: the existing account, a duplicate.
    again = preview(jan, content, name="oszczednosci.json").json()
    assert again["account"]["existing"] is True and again["counts"]["duplicates"] == 1


def test_document_without_a_number_goes_to_one_account_by_name(jan):
    d = {**SAVINGS_DOC, "account": {"currency": "PLN", "name": "Skarbonka"}}
    content = json.dumps(d).encode()
    p = preview(jan, content, name="s.json").json()
    assert p["account"]["existing"] is False and p["account"]["name"] == "Skarbonka"
    done = commit(jan, {"file_id": p["file_id"], "file_name": "s.json"}).json()
    again = preview(jan, content, name="s.json").json()
    assert again["account"] == {**again["account"], "existing": True, "id": done["account"]["id"]}


def test_preview_into_a_chosen_account(jan):
    first = preview(jan, MBANK_CSV).json()
    acc_id = commit(jan, {"file_id": first["file_id"], "file_name": first["file_name"]}).json()["account"]["id"]
    d = {**SAVINGS_DOC, "account": {"currency": "PLN"}}
    p = preview(jan, json.dumps(d).encode(), name="s.json", account_id=acc_id).json()
    assert p["account"]["existing"] is True and p["account"]["id"] == acc_id
    # an account number that is not the chosen account's
    r = preview(jan, json.dumps(SAVINGS_DOC).encode(), name="s.json", account_id=acc_id)
    assert r.status_code == 422 and code(r) == "import_account_mismatch"
    r = preview(jan, MBANK_CSV, account_id=999999)
    assert r.status_code == 404 and code(r) == "not_found"


@pytest.mark.parametrize(
    ("content", "fields", "status", "error"),
    [
        (b"zupelnie;nie;wyciag\n1;2;3\n", {}, 422, "import_bank_unknown"),
        (b"zupelnie;nie;wyciag\n1;2;3\n", {"bank": "pekao"}, 422, "import_header_missing"),
        (b"x", {"bank": "nobank"}, 422, "import_bank_unknown"),
        # F10: an unknown / unapproved connector is the owner's 422 connector_<kind>
        (b"x", {"bank": "connector:xtb-csv"}, 422, "connector_not_approved"),
        (b"x", {"importer": "connector:xtb-csv"}, 422, "connector_not_approved"),
        (b'{"format": "cashu-budget-import", "format_version": 2}', {}, 422, "import_invalid"),
        (b"mBank S.A.\n#Data operacji;#Opis operacji;#Kwota\n", {}, 422, "import_empty"),
        (b"", {}, 422, "import_empty"),
        (b"x", {"account_type": "mortgage"}, 422, "import_account_type"),
    ],
)
def test_preview_refusals(jan, tmp_path, content, fields, status, error):
    r = preview(jan, content, **fields)
    assert r.status_code == status and code(r) == error, (r.status_code, r.text)
    assert staged_files(tmp_path) == []  # a refused file is not kept
    assert "zupelnie" not in r.text


def test_invalid_document_detail_is_value_free(jan):
    d = json.loads(json.dumps(SAVINGS_DOC))
    d["transactions"][0]["amount"] = "SEKRET123"
    r = preview(jan, json.dumps(d).encode(), name="s.json")
    assert r.status_code == 422 and code(r) == "import_invalid"
    assert "row 1: amount:" in r.json()["detail"] and "SEKRET123" not in r.text


def test_too_large_upload(jan, monkeypatch):
    monkeypatch.setattr(imports, "MAX_FILE_BYTES", 10)
    r = preview(jan, MBANK_CSV)
    assert r.status_code == 413 and code(r) == "file_too_large"


def test_raw_body_preview(jan):
    r = jan.post(
        "/api/p/jan/budget/import/preview?filename=w.csv&bank=mbank", content=MBANK_CSV,
        headers={"content-type": "text/csv"},
    )
    assert r.status_code == 200 and r.json()["bank"]["detected"] is False


def test_commit_refusals(jan):
    r = commit(jan, {"file_id": "0" * 64, "file_name": "x.csv"})
    assert r.status_code == 404 and code(r) == "not_found"
    r = commit(jan, {"file_id": "../../etc", "file_name": "x.csv"})
    assert r.status_code == 404
    p = preview(jan, MBANK_CSV).json()
    r = commit(jan, {"file_id": p["file_id"], "file_name": p["file_name"], "bank": "connector:x"})
    # a connector commit reads the staged file as the converted document (nothing runs): refused
    assert r.status_code == 422 and code(r) == "import_invalid"


def test_import_is_per_profile(jan):
    jan.post("/api/profiles", json={"name": "Ola", "modules": ["budget"]})
    p = preview(jan, MBANK_CSV).json()
    # Ola cannot commit Jan's staged file (another staging dir) nor import into Jan's account.
    assert commit(jan, {"file_id": p["file_id"], "file_name": p["file_name"]}, slug="ola").status_code == 404
    done = commit(jan, {"file_id": p["file_id"], "file_name": p["file_name"]}).json()
    r = preview(jan, MBANK_CSV, slug="ola", account_id=done["account"]["id"])
    assert r.status_code == 404
    ola = preview(jan, MBANK_CSV, slug="ola").json()
    assert ola["account"]["existing"] is False and ola["previous_imports"] == []


def test_abandoned_uploads_are_pruned(jan, tmp_path):
    import os

    p = preview(jan, MBANK_CSV).json()
    old = tmp_path / "data" / "imports" / "jan" / ".staging" / f"budget-{p['file_id']}.csv"
    os.utime(old, (1, 1))
    preview(jan, MBANK_CSV.replace(b"9 000,00", b"9 001,00"))
    assert not old.exists()


def test_match_transfers_endpoint(jan):
    assert jan.post("/api/p/jan/budget/match-transfers", json={}).json() == {"pairs": 0}
    with get_session() as s:
        from datetime import date
        from decimal import Decimal

        from cashu.core import profiles
        from cashu.core.accounts import get_or_create_account
        from cashu.modules.budget import service
        from cashu.modules.budget.ingestion.normalize import RawTransaction

        pid = profiles.get_by_slug(s, "jan").id
        a = get_or_create_account(s, bank="mbank", iban="99114000000000000000000101", profile_id=pid)
        b = get_or_create_account(s, bank="erste", iban="99109000000000000000000303", profile_id=pid)

        def raw(amount, iban):
            return RawTransaction(booking_date=date(2026, 9, 11), amount=Decimal(amount),
                                  counterparty_iban=iban, reference="OSZCZEDNOSCI", source=Source.CSV)

        service.ingest_transactions(s, a, [raw("-1000", b.iban)], source=Source.CSV)
        service.ingest_transactions(s, b, [raw("1000", a.iban)], source=Source.CSV)
    assert jan.post("/api/p/jan/budget/match-transfers", json={"max_days": 3}).json() == {"pairs": 1}
    assert jan.post("/api/p/jan/budget/match-transfers").json() == {"pairs": 0}
    assert jan.post("/api/p/jan/budget/match-transfers", json={"max_days": 99}).status_code == 422
    with get_session() as s:
        cats = {t.category for t in s.exec(select(Transaction)).all()}
    assert cats == {"transfer"}


def _doc(currency: str = "PLN", iban: str | None = None, **extra) -> bytes:
    account = {"currency": currency, "name": "Konto TEST"}
    if iban:
        account["iban"] = iban
    return json.dumps({
        "format": "cashu-budget-import", "format_version": 1, "source": "demo_api",
        "account": account, "balances": [{"date": "2026-09-30", "amount": "100.00"}],
        "transactions": [{"booking_date": "2026-09-20", "amount": "-5.00", "currency": currency,
                          "description": "Zakupy TEST"}],
        **extra,
    }).encode()


def _bank_account(currency: str = "PLN", iban: str | None = None) -> int:
    from cashu.core import profiles
    from cashu.core.accounts import get_or_create_account

    with get_session() as s:
        pid = profiles.get_by_slug(s, "jan").id
        return get_or_create_account(
            s, bank="mbank", iban=iban, name="Konto TEST", currency=currency, profile_id=pid
        ).id


def test_document_in_another_currency_than_the_account_is_refused(jan):
    """BE-3: the chosen (or number-matched) account's currency must be the document's; balances
    included. Nothing is written."""
    pln = _bank_account("PLN")
    _bank_account("PLN", iban="99114000000000000000000909")
    before = counts()
    r = preview(jan, _doc("EUR"), name="doc.json", account_id=pln)
    assert r.status_code == 422 and code(r) == "import_currency_mismatch"
    assert "EUR" in r.json()["detail"] and "PLN" in r.json()["detail"]
    r = preview(jan, _doc("EUR", iban="PL99114000000000000000000909"), name="doc.json")
    assert r.status_code == 422 and code(r) == "import_currency_mismatch"
    ok = preview(jan, _doc("PLN"), name="doc.json", account_id=pln)
    assert ok.status_code == 200, ok.text
    assert counts() == before
    r = commit(jan, {"file_id": ok.json()["file_id"], "file_name": "doc.json", "account_id": pln,
                     "bank": "cashu-budget"})
    assert r.status_code == 201


def test_account_id_of_a_brokerage_account_is_not_found(api_empty):
    """BE-9: the budget import only goes into bank accounts (checking, savings, credit)."""
    api_empty.post("/api/profiles", json={"name": "Jan", "modules": ["budget", "investments"]})
    broker = api_empty.post("/api/p/jan/investments/accounts",
                            json={"name": "Broker TEST", "broker": "dif", "wrapper": "regular"})
    assert broker.status_code == 201, broker.text
    r = preview(api_empty, _doc(), name="doc.json", account_id=broker.json()["id"])
    assert r.status_code == 404 and code(r) == "not_found"
    r = preview(api_empty, MBANK_CSV, account_id=broker.json()["id"])
    assert r.status_code == 404 and code(r) == "not_found"
