"""Extra demo facts for the strategy-hint / recommendation-freshness e2e spec (16-strategy-hints), written
through the service layer into the running e2e database (CASHU_DATA_DIR = the global setup's temp dir).
Idempotent: a second call finds the DMTC thesis and does nothing.

- demo-piotr GLBA (held, model recommendation `hold`): a thesis + a note that invalidates it, stored after
  the recommendation -> recommendation `outdated` (red card, red coin rim), hint `recommendation_outdated`.
- demo-piotr DMTC (held, no recommendation): a thesis, a note that fulfils it, then a core thesis edit ->
  hint `thesis_fulfilled`, the note tagged `predates_thesis`, the summary row `health_predates_thesis`.
- demo-anna DMSE (watched, no recommendation): a triggered alert -> hint `alert_triggered`.

    CASHU_DATA_DIR=<tmp> .venv/bin/python frontend/e2e/seed_hints.py
"""

from __future__ import annotations

import datetime as dt
import os

from sqlmodel import select

from cashu.core import profiles
from cashu.core.db import get_session
from cashu.core.models import utcnow
from cashu.modules.investments.models import InvAlert, InvInstrument
from cashu.modules.investments.research import service as research
from cashu.modules.investments.research.validation import validate_note, validate_scope
from cashu.modules.investments.service import alerts as alert_service
from cashu.modules.investments.store import journal

def _profile(s, slug: str):
    return next(p for p in profiles.list_profiles(s) if p.slug == slug)


def _iid(s, symbol: str) -> int:
    return s.exec(select(InvInstrument.id).where(InvInstrument.symbol == symbol)).first()


def _note(title: str, relation: str, field: str = "thesis") -> dict:
    return {
        "kind": "news",
        "polarity": "negative" if relation == "invalidates" else "positive",
        "strength": 3,
        "thesis_relation": relation,
        "thesis_field": field,
        "title": title,
        "summary": "Przykładowe źródło (dane testowe e2e).",
        "sources": [{"url": f"https://example.com/e2e/{abs(hash(title))}", "publisher": "Example News", "published_at": dt.date.today().isoformat()}],
    }


def _thesis(text: str) -> dict:
    return {
        "entry_type": "trend",
        "thesis": text,
        "invalidation": "Spadek napływów przez dwa kwartały.",
        "exit_plan": "Sprzedaż przy unieważnieniu tezy.",
        "size_plan": "Do 10% portfela.",
    }


def main() -> None:
    if not os.environ.get("CASHU_DATA_DIR"):
        raise SystemExit("CASHU_DATA_DIR must point at the e2e data dir")
    with get_session() as s:
        piotr = _profile(s, "demo-piotr")
        anna = _profile(s, "demo-anna")
        glba, dmtc, dmse = _iid(s, "GLBA"), _iid(s, "DMTC"), _iid(s, "DMSE")
        if any(t.instrument_id == dmtc for t in journal.theses(s, piotr.id)):
            print("exists")
            return
        glba_thesis = journal.create_thesis(s, piotr.id, glba, _thesis("Napływy do funduszu rosną."))
        dmtc_thesis = journal.create_thesis(s, piotr.id, dmtc, _thesis("Popyt na półprzewodniki rośnie."))
        s.commit()
        now = utcnow()  # after the theses: the notes are judged against them
        run = research.start_run(s, piotr, validate_scope({"held": True, "watchlist": True}), now=now)
        for iid, raw in (
            (glba, _note("GLBA: napływy spadają drugi kwartał", "invalidates")),
            (dmtc, _note("DMTC: popyt na półprzewodniki osiągnął cel", "fulfills")),
        ):
            research.add_note(s, piotr, validate_note(raw, now=now), instrument_id=iid, run_id=run.id, now=now)
        research.finish_run(s, piotr, run.id, status="done", now=now + dt.timedelta(minutes=1))
        s.commit()
        # A core edit after the note: the fulfilling note now predates the thesis.
        journal.update_thesis(s, s.get(type(dmtc_thesis), dmtc_thesis.id), {"thesis": "Popyt na półprzewodniki rośnie dalej."})
        assert glba_thesis.id is not None
        added = alert_service.create(
            s,
            anna,
            alert_service.AlertInput(kind="price_below", title="poniżej 9 999,00 zł", params={"level": 9999.0}, instrument_id=dmse),
            created_by="app",
        )
        row = s.get(InvAlert, added.id if hasattr(added, "id") else added.alert.id)
        row.status = "triggered"
        row.last_triggered_at = now
        s.add(row)
        s.commit()
    print("seeded")


if __name__ == "__main__":
    main()
