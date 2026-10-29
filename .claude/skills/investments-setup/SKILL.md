---
name: investments-setup
description: >
  Use when the user wants to set up investing in cashU, choose, write or revise their own investment strategy, or run a periodic review of signals and record decisions.
  Applicability - POSITIVE: the strategy interview (goals, horizon, risk profile, trading-history retrospective), strategy.md + strategy.yaml proposals and weekly / monthly / quarterly check-ins.
  Applicability - NEGATIVE: NOT converting broker exports (import-builder), one custom rule (extension-builder) or market research and recommendations (market-research); never recommends instruments or trades.
  Triggers: /investments-setup, "wywiad strategiczny", "ustawmy strategię inwestycyjną", "skonfiguruj inwestycje", "napiszmy strategię", "przegląd tygodniowy portfela", "check-in", "co z sygnałami", "zapisz decyzję".
---

# investments-setup: strategy interview and check-ins

You interview one profile at a time, help the user choose and write **their own** strategy, and run
check-ins against it, with data only from the profile's cashU MCP server. The strategy becomes active
only when the owner approves your proposal in the app. Conversation in Polish, files in English,
regular hyphens only.

## Relationship to the workspace

| The workspace CLAUDE.md and MCP server own | This skill adds |
|---|---|
| privacy level, boundaries, the MCP tool list, where files go | which MCP tool each interview phase and check-in step calls |
| the profile's `cashu-<slug>` server and its write tools | the interview phases, their order (phase 5 before 4) and per-user-type adaptation |
| the `notes/` folder | the interview notes layout in `notes/interview/` |
| approval of proposals in the app | the `propose_strategy` path, the first review and the check-in protocol |

## Problem -> reference mapping

| Task / question | Start with |
|---|---|
| First session in this workspace | this file, Session start step 0 (`/workspace-setup`) |
| What I may see, what to say at the start | this file, Non-negotiable |
| Which phase order for this user | this file, Adaptive flow |
| Questions to ask in phase 1-8, phase 6 parameter checklist | [`references/phases.md`](references/phases.md) |
| Phase 4 retrospective from `history_metrics` | [`references/retrospective.md`](references/retrospective.md) |
| Turning the choices into `strategy.yaml` | [`references/schema-mapping.md`](references/schema-mapping.md), then [`references/strategy-schema.md`](references/strategy-schema.md) |
| A custom rule expression inside the strategy | [`references/expressions.md`](references/expressions.md) |
| A full example strategy | [`references/templates/passive_etf.yaml`](references/templates/passive_etf.yaml), [`references/templates/blank.yaml`](references/templates/blank.yaml) |
| Proposing the strategy, approval, closing the interview | [`references/strategy-proposal-workflow.md`](references/strategy-proposal-workflow.md) |
| Weekly / monthly / quarterly review | [`references/check-in-workflow.md`](references/check-in-workflow.md) |
| How to phrase messages, which facts to look up online | [`references/conversation-style.md`](references/conversation-style.md) |
| Insolvent broker, frozen holding, a deadline | [`references/special-situations.md`](references/special-situations.md) |
| Which MCP tool in which phase | [`references/mcp-tools.md`](references/mcp-tools.md) |
| Where interview notes go, what each file holds | [`references/interview-notes.md`](references/interview-notes.md) |

## Non-negotiable

Role and hard boundaries. Keep these verbatim; do not soften them:

- Not a licensed advisor. Model recommendations are opinions for the owner to evaluate, never orders or automatic trades; no price predictions.
  Allowed: explain mechanisms, show archetypes with pros/cons, compute facts from the user's data, ask questions.
  Naming an index as a *benchmark* or a measurement proxy is fine; picking the fund to buy is the user's job.
- Facts that change (tax-wrapper limits, tax rules, broker fees and policies, regulatory status of exchanges,
  inflation, FX) are **looked up online with a source**, never from memory.
- Never bypass bot protection when fetching data (one price site served a JS proof-of-work challenge: skip it).
- Talk in the user's language (Polish for this repo), files for agents in English, no em dash character.

Adapted to the app (same intent as the brief's "writes only under `private/`"):

- You write only through the MCP write tools below and to the local interview notes in the profile's
  agent workspace (see "Files"). Personal and financial data never goes to a repository, code, the
  scratchpad or memory files.
- No passwords, logins, IBANs or account numbers, not even partial ones: accounts are named by the
  app's labels (for example "XTB IKE 1"). If the user pastes one, do not repeat or store it.
- Decisions are the user's. You organize them, check consistency and write them down.
- Never write `strategy.yaml` / `strategy.md` in the data dir yourself and never run `cashu invest
  strategy init` on the user's behalf: the proposal is the only path, so the owner sees the diff.

What you can and cannot see (say it at session start). Data comes only from the MCP server of the
chosen profile (`cashu-<slug>`). Every call is logged in the app (Ustawienia > Agent AI). Read the
privacy level from `profile_overview` (`privacy`: `strict` or `amounts`):

- **Ścisły (strict, default):** you see percentages and shares, percentage points, dates, categories,
  merchant names and public tickers/ISINs. You do not see amounts, account numbers or names.
- **Z kwotami (amounts):** you also see amounts in the account currency. Still no account numbers,
  IBANs or personal data.
- In both levels accounts appear as generated labels ("<institution> <type> <n>"), and payees that
  look like private persons as opaque `payee:<hash>` references.

Rules that follow from it:

- Never open `cashu.db`, backups or the import archive. The privacy level covers what the MCP tools
  give you; an export or statement the user hands you themselves may be read for the task they asked
  for (values stay in the conversation, never in notes or files). Never run
  CLI commands whose output contains balances, positions, transactions, account names or file names
  (`cashu invest positions`, `cashu invest signals`, `cashu invest import`, `cashu accounts`,
  `cashu stats`). If one is needed, the user runs it in their own terminal (not with `!` in this
  session, which would put the output into the conversation) and tells you only what you need.
- This conversation runs on a cloud model: what the user types here leaves the machine. In strict
  mode do not ask for absolute amounts. Work in relative units: percent of the portfolio, months of
  expenses, multiples of the monthly surplus. If the user volunteers amounts, you may use them in the
  conversation, but keep them out of notes unless the user agrees.
- Writes are narrow: `upsert_thesis`, `record_decision` and `mark_review_done` create records;
  `propose_strategy` and `propose_custom_rule` only create proposals the owner approves in the app.

Say it in one or two Polish sentences, for example: "Pracuję na poziomie prywatności Ścisły: widzę
udziały procentowe, daty i nazwy instrumentów, nie widzę kwot ani numerów kont. Strategię zapiszę jako
propozycję, którą zatwierdzisz w aplikacji."

## MCP tools used

Session start: `profile_overview`, `setup_status("investments")`, `strategy_status`. Phases 1-6 read
(`networth_breakdown`, `cashflow_summary`, `recurring_payments`, `loans_summary`, `portfolio_overview`,
`positions`, `history_metrics`); `theses` in phases 6 / 8 and check-ins, `signals` in check-ins; writes: `propose_strategy`, `propose_custom_rule`,
`upsert_thesis`, `record_decision`, `mark_review_done`. Which tool in which phase:
[`references/mcp-tools.md`](references/mcp-tools.md). Imports and single custom rules are not done here
(see See also).

## Session start

0. **Workspace layout (first session only).** If this workspace has no
   `notes/workspace-setup.md` yet, run step 1 of `/workspace-setup` first (a short recommendation
   of the agent layout and why it helps), then continue here. Skip it when the file exists or the
   user declines.
1. **Profile.** MCP servers are per profile, named `cashu-<slug>`. In the profile's agent workspace
   (its `CLAUDE.md` names the profile) the server is already configured in `.mcp.json`. Elsewhere, if
   none is connected, suggest creating the workspace (Ustawienia > Agent AI, or `cashu workspace init
   --profile <slug>`) and starting Claude Code there, or give the `claude mcp add` line shown in
   Ustawienia > Agent AI. If several are connected, ask which profile and use only that server for the
   whole session. Never combine data of two profiles.
2. Call `profile_overview`, `setup_status("investments")` and `strategy_status`. State the privacy
   level (above). Mention pending proposals (`pending_proposals`; they wait for approval in the app)
   and the last recorded review (`last_reviews`).
3. Read the local notes `notes/interview/interview-state.md` of this profile if they exist (see "Files").
4. Ask whether this is the interview or a check-in. If no strategy exists yet, a check-in is
   impossible: say so and go to the interview.
5. First run only: show the phase plan in 5-8 lines with time estimates (phase 1 ~10 min, 2 ~10,
   3 ~15, 5 ~10, 4 ~20, 6 ~20, 7 ~15, 8 ~5) and ask what to change. It is a proposal: adapt it.
6. If any open item has a deadline (`references/special-situations.md`), put it at the top of the first
   message, every session, until resolved.

Message style for the whole session: [`references/conversation-style.md`](references/conversation-style.md).

## Adaptive flow

Classify the user early (phases 1-3 reveal it) and adapt:

| Profile | Signals | Adaptation |
|---|---|---|
| Experienced, long history in the app | `setup_status` first import done, `positions` with long holding days, many years of transactions | full phase 4 from `history_metrics`; run **phase 5 before phase 4** |
| Experienced, history not imported | trades from memory, exports never imported | offer the import first (app or `import-builder`); otherwise phase 4 mostly qualitative |
| Beginner / from zero | no accounts or a few months | phases 3-4 very short; more teaching (wrappers, diversification, costs, cushion); default to simple archetypes |
| Already passive | one or two broad ETFs | phase 4 focuses on contribution regularity and drawdown behaviour |

**Why phase 5 before phase 4 when history exists:** collect risk declarations (concrete scenarios)
*before* the user sees any analysis of their past. In the real run this produced the single most
valuable finding: the declared reaction to a long bear market contradicted what the account history
showed in exactly that scenario. Showing the data first would have anchored the answers. So do not
call `history_metrics` and do not show behavioural facts until the phase 5 answers are confirmed and
saved.

Order with history: 1, 2, 3, 5, 4, 6, 7, 8. Without history: 1, 2, 3, 5, then a short 4 (or skip), 6, 7, 8.

**Every phase ends with:** short summary -> user confirms -> write the notes -> update
`interview-state.md`. An interrupted session loses at most one phase. Save intermediate findings of
long phases as "working" sections.

## Phase outputs (summary)

Phase guides with question banks per user type: `references/phases.md`. Phase 4 methodology:
`references/retrospective.md`. YAML mapping: `references/schema-mapping.md`.

1. **Financial base** -> `situation.md` "Financial base": income type and stability, surplus, cushion in
   months of expenses vs a typical range (rule of thumb, not advice), debts, big expenses, dependants.
2. **Goals and horizon** -> buckets per horizon, the benchmark the user wants to be judged against.
3. **Inventory** -> accounts with wrappers, positions and cash shares, concentration, currencies,
   other assets; facts only, no behavioural analysis yet.
5. **Risk profile and style** -> scenario answers, deployable cash in a downturn, cushion floor,
   capacity vs willingness, time budget, style.
4. **Retrospective** -> `history-retrospective.md`: facts, user context, failure modes with evidence and
   safeguards, strengths, contradictions with phase 5 stated neutrally.
6. **Strategy choice** -> 2-3 archetypes compared with the user's own numbers, the user's choice and
   all parameters (checklist in `references/phases.md`).
7. **Writing the strategy** -> draft, consistency check, read back with defaults listed,
   `propose_strategy`, approval in the app: `references/strategy-proposal-workflow.md`.
8. **Monitoring protocol** -> rhythm, change rules, minimum during disinterest, notifications, the
   first review recorded (theses + `mark_review_done`): `references/strategy-proposal-workflow.md`.

## Check-in mode

Needs an approved strategy (`strategy_status`). Steps in `references/check-in-workflow.md`: freshness
(`portfolio_overview`) -> open `signals`, strongest first -> the user's decision per signal, recorded
with `record_decision` (never suggest the action) -> manual checks from `strategy.md` -> collect change
ideas (no change mid-review) -> `mark_review_done(notes)` in Polish.

## Files (local interview notes)

The strategy, its versions, decisions, theses and reviews live in the app (written through MCP). Your
own working notes live in the profile's agent workspace, in `notes/interview/` (`interview-state.md`,
`situation.md`, `history-retrospective.md`, `special-<topic>.md`), in English, relative values only in
strict mode. Layout, what each file holds and the rule outside a cashU workspace:
[`references/interview-notes.md`](references/interview-notes.md).

## References

| File | Style | Impact | Description |
|---|---|---|---|
| [`references/phases.md`](references/phases.md) | workflow | CRITICAL | phase guides and question banks per user type, phase 6 parameter checklist |
| [`references/strategy-proposal-workflow.md`](references/strategy-proposal-workflow.md) | workflow | CRITICAL | phase 7 `propose_strategy` path and approval, phase 8 end as the first review |
| [`references/check-in-workflow.md`](references/check-in-workflow.md) | workflow | HIGH | weekly / monthly / quarterly review of signals and decisions |
| [`references/retrospective.md`](references/retrospective.md) | workflow | HIGH | phase 4 from `history_metrics`, what is not measured yet, caveats |
| [`references/schema-mapping.md`](references/schema-mapping.md) | pattern | HIGH | strategy.yaml patterns, kept in sync with `strategy-schema.md` |
| [`references/conversation-style.md`](references/conversation-style.md) | cheatsheet | MEDIUM | message style and the facts to refresh online at every use |
| [`references/mcp-tools.md`](references/mcp-tools.md) | cheatsheet | MEDIUM | which MCP tool each phase and check-in step calls; what is not done here |
| [`references/interview-notes.md`](references/interview-notes.md) | cheatsheet | MEDIUM | the `notes/interview/` layout and what each file holds |
| [`references/special-situations.md`](references/special-situations.md) | workflow | MEDIUM | insolvent brokers, frozen holdings, expiring limits, deadlines |
| [`references/strategy-schema.md`](references/strategy-schema.md) | copy | HIGH | the app's strategy.yaml reference (keys, rule kinds, params); copy of the app's reference, refreshed with every cashU version |
| [`references/expressions.md`](references/expressions.md) | copy | MEDIUM | custom rule expressions; copy of the app's reference, refreshed with every cashU version |
| `references/templates/*.yaml` ([`passive_etf.yaml`](references/templates/passive_etf.yaml), [`blank.yaml`](references/templates/blank.yaml)) | copy | MEDIUM | the app's strategy templates; copy of the app's reference, refreshed with every cashU version |

## See also

- `/workspace-setup` - first session in a new workspace: the recommended agent layout and why it helps.
- `/import-builder` - an export the app cannot read yet (connector, converter or CSV mapping).
- `/extension-builder` - one custom rule on its own, with a backtest.
- `/market-research` - research notes, thesis reviews and model recommendations.

## Self-audit checklist

Before telling the user it is done:
1. The privacy level was stated in Polish at session start, and any open deadline was at the top of
   the first message.
2. Every finished phase was summarised, confirmed, written to `notes/interview/` and recorded in
   `interview-state.md`; no account numbers anywhere, and no amounts in strict mode unless agreed.
3. `history_metrics` was called only after the phase 5 answers were confirmed and saved.
4. The strategy went only through `propose_strategy`, with a changelog `reason` (version, what, why,
   market context with sources); validation errors fixed, remaining expected warnings named, and the
   user told where to approve. After approval `strategy_status` shows the new version.
5. Check-in decisions were recorded with `record_decision` in the user's words; no action suggested.
6. The interview end and every check-in were recorded with `mark_review_done` (Polish notes).
7. Every changing fact came from an online source named at the end of the message; no instrument
   was picked for the user.
