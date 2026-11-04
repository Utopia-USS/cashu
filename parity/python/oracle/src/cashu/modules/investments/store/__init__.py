"""Investments persistence: repositories between the ``inv_`` tables and the pure domain.

- ``convert``: row <-> domain (``str`` domain ids, integer keys);
- ``instruments``: the DB ``InstrumentLookup``, inserting planned instruments, classification;
- ``transactions``: brokerage accounts, transactions, renames, manual valuations, broker snapshots;
- ``market``: the DB ``StoredMarketData``, applying a ``FetchReport``, ``MarketView`` / FX preload;
- ``signals``: open / closed signals, applying the lifecycle actions, rule runs, notifications;
- ``journal``: decisions and theses.

Every profile-scoped function takes the profile id; nothing here holds a session across network IO.
"""
