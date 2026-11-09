# cashU privacy

cashU is a personal-finance app that runs on your own computer. There is no cashU server and no cashU
account: nobody behind cashU receives, stores or can see your data.

## Where your data is

- Everything cashU imports or computes (accounts, transactions, balances, categories, assets, loans,
  investments) is stored on your computer, in an encrypted store per profile. The keys are in your
  operating system's keychain.
- cashU collects no telemetry, analytics or crash reports.

## What leaves your computer, and only when you set it up

| Service | When | What is sent |
| --- | --- | --- |
| Your bank, through Enable Banking (Open Banking) | only if you connect a bank | the requests needed to read your own accounts; you log in at your bank, cashU never sees your bank password |
| Market data sources (e.g. stooq, Yahoo Finance, Nasdaq, OpenFIGI, the NBP exchange rate API) | investments module | instrument symbols and currencies, never your holdings or amounts |
| Anthropic | only if you choose it for categorization and agree in the app | merchant names only, never account numbers, balances or names |
| GitHub | update check of the desktop app | a request for the latest release |

An AI agent you connect yourself (over cashU's local MCP server) sees only what the privacy level you
chose for that profile allows, and every call is logged in the app.

## Open Banking with Enable Banking

When you register your own Enable Banking application for cashU, you are both the application's owner
and its only user. Account data goes from your bank to cashU on your computer and nowhere else. The
consent ends on its own when it expires, and you can revoke it earlier at your bank.

## Contact

cashU is open source: <https://github.com/Utopia-USS/cashu>. Questions go to the repository's issues.
