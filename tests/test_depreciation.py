"""Vehicle depreciation: declining-balance value + net-worth integration."""

from datetime import date
from decimal import Decimal

from finanse.core.accounts import get_or_create_account, upsert_balance
from finanse.core.networth import net_worth, net_worth_series
from finanse.models import AccountType, Bank, Source
from finanse.modules.assets import depreciation as dep
from finanse.modules.assets.service import set_vehicle


def test_value_declining_balance_and_floor():
    buy = date(2025, 6, 16)
    # Day of purchase: full price.
    assert dep.value(62500, buy, 15, buy) == Decimal("62500.00")
    # Before purchase: not owned yet.
    assert dep.value(62500, buy, 15, date(2025, 1, 1)) == Decimal("0.00")
    # ~1 year later at 15%/yr ≈ price * 0.85.
    v1 = dep.value(62500, buy, 15, date(2026, 6, 16))
    assert Decimal("53000") < v1 < Decimal("53200")  # 62500*0.85 = 53125
    # Floor is respected far in the future.
    v_far = dep.value(62500, buy, 15, date(2045, 6, 16), floor=8000)
    assert v_far == Decimal("8000.00")


def test_vehicle_counts_as_illiquid_asset(session):
    # A bank account with a balance, plus the car.
    acc = get_or_create_account(session, bank=Bank.MBANK, name="mBank", iban="PL10 1140 0000 0000 0000 1234")
    session.flush()
    upsert_balance(session, acc, date(2026, 1, 1), Decimal("10000.00"), source=Source.CSV)
    car = set_vehicle(session, name="Hyundai i30", purchase_price=62500,
                      purchase_date=date(2025, 6, 16), annual_rate=15, floor=8000)
    session.flush()
    assert car.type == AccountType.VEHICLE

    # Total net worth includes the depreciated car value.
    totals, lines = net_worth(session)
    car_line = next(ln for ln in lines if ln.account.id == car.id)
    assert car_line.contribution and car_line.contribution > Decimal("40000")  # ~50k now
    assert totals["PLN"] == Decimal("10000.00") + car_line.contribution

    # Liquid scope excludes the car; total includes it.
    liquid = net_worth_series(session, scope="liquid")
    total = net_worth_series(session, scope="total")
    assert liquid and total
    assert total[-1][1] > liquid[-1][1]  # car adds to total but not liquid
    assert liquid[-1][1] == Decimal("10000.00")


def test_series_declines_over_time(session):
    acc = get_or_create_account(session, bank=Bank.MBANK, name="mBank", iban="PL10 1140 0000 0000 0000 1234")
    session.flush()
    # two balance points so the series spans purchase -> now
    upsert_balance(session, acc, date(2025, 1, 1), Decimal("10000.00"), source=Source.CSV)
    upsert_balance(session, acc, date(2027, 1, 1), Decimal("10000.00"), source=Source.CSV)
    set_vehicle(session, name="Car", purchase_price=62500, purchase_date=date(2025, 6, 16),
                annual_rate=15, floor=None)
    session.flush()

    total = net_worth_series(session, scope="total", granularity="daily")
    vals = dict(total)
    # Before purchase: only the 10k bank balance (car not owned).
    assert vals[date(2025, 1, 1)] == Decimal("10000.00")
    # After purchase: bank + car, and the car value declines toward later dates.
    assert vals[date(2027, 1, 1)] > Decimal("10000.00")
    assert vals[date(2027, 1, 1)] < Decimal("10000.00") + Decimal("62500.00")
