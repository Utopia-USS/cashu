"""Portfolio performance vs a benchmark (pure core + a service over the store, no network outside
``backfill``).

- ``series``: daily value and external-flow series per account in the base currency (exact lots,
  the overview's valuation rules, split-adjusted closes, implied funding of cash gaps);
- ``returns``: contributions-neutral TWR, XIRR, drawdowns, annualizing;
- ``benchmark``: the strategy's ``benchmark.proxy`` in the base currency and the same-cash-flow
  simulation (the same deposits on the same days into the proxy, with and without account fees);
- ``attribution``: P/L by instrument and bucket, profit concentration (top-N share, result without
  the top 2);
- ``report``: range metrics (``1m 3m ytd 1y 3y max``), rolling 12/24/36-month relative performance,
  calendar years;
- ``service``: loading, in-memory cache, the JSON of ``GET /investments/performance`` and
  ``.../performance/attribution`` and the values behind the MCP ``history_metrics`` extension;
- ``backfill``: full price history for held, sold and benchmark instruments from the first transaction
  date, incremental afterwards (one short write transaction per batch, none across the network);
- ``cli``: ``finanse invest backfill`` and ``finanse invest performance``.

Endpoint shapes: the CONTRACT section of ``stock/docs/fork/progress/F5-PF.md``.
"""
