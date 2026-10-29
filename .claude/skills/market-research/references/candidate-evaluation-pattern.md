# Candidate evaluation: hyper-growth, entry triggers, SPAC / de-SPAC

What this is: the rules for evaluating early-stage and hyper-growth instruments and SPAC / de-SPAC
deals, for ranking them and for turning "watch" into concrete entry conditions, within the owner's
strategy.

## When this applies

- Evaluating a candidate or a watched / held instrument whose business is early, pre-revenue or
  growing very fast (hyper-growth).
- Any SPAC, announced business combination or recently closed de-SPAC.
- Ranking several candidates, or writing a recommendation that would otherwise end at "obserwuj" /
  `hold` (czekam).

## Rules

1. **Early business and low revenue are not an automatic rejection.** Why: in hyper-growth the
   current revenue says little about the reachable scale; rejecting on it filters out exactly the
   cases the owner accepts. Score two things separately:
   - **scale potential**: addressable market (TAM, with source), the product (shipping, not a
     roadmap), real deployments, contracted demand (signed contracts, backlog, binding orders, not
     MoUs alone), capital to scale (cash, committed financing, runway against the plan);
   - **execution risk**: delivery track record, dependence on one customer, contract or approval,
     financing need and dilution, management, technology risk.
   A weak score on one never hides the other.
2. **Show two rankings.** Why: one blended score hides whether an idea is attractive because of
   upside or despite its risk. Give a ranking by **potential / upside** and a **risk-adjusted**
   ranking, each with a one-line reason per position, and say where they disagree.
3. **Never stop at "obserwuj".** Why: "watch" without conditions gives the owner nothing to act on
   or check. For every instrument still under consideration state:
   - whether a **small first tranche makes sense now**, and why or why not;
   - **what must happen before each next tranche** (dated, checkable facts: a signed contract, a
     revenue milestone, financing closed, the merger vote, the first post-merger report);
   - **which facts block entry** (stop conditions: dilution above a threshold the owner set,
     a lost key contract, redemptions draining the trust, a missed milestone).
   Tranches are fractions of the **planned position** (for example "1/3 of the planned position"),
   never a share of the portfolio or an amount. The planned position is the owner's: "Wielkość i
   dokupienia" (`size_plan`) of the instrument's thesis (rule 7). Thresholds in a
   blocker (dilution, redemptions) are the owner's, from the strategy or the conversation; never
   invent one. These are conditions for the owner to evaluate, not orders and not price targets.
4. **SPAC / de-SPAC: separate the shell from the pro forma company.** Why: the shell's market cap
   and the post-merger company are different numbers, and the protection changes at closing.
   - Report the **shell market cap** (current shares x price) and the **pro forma post-money equity
     value** from the deal documents (announcement, investor deck, S-4 / F-4 / proxy), each with its
     source and date.
   - Count the **new shares and dilution**: shares issued to the target's holders, PIPE, sponsor
     promote and earn-outs, warrants and rights, and the expected redemptions; state the assumption
     (redemption level) behind every pro forma number.
   - **Trust / redemption protection works only before closing**: until the vote a holder can
     redeem at about the trust value per share; after the merger closes that floor is gone and the
     share trades on the operating business alone. Say which side of closing the instrument is on.
5. **Read the strategy's hard filters deliberately.** Why: a filter like a minimum market cap was
   written for operating companies; applied blindly to a shell it rejects or admits the wrong
   thing. With an **announced merger** you may test the filter on the **pro forma equity value**,
   but write explicitly which value you used and the gap to the current shell (for example "shell
   0.3 bn, pro forma 2.1 bn at 50 % redemptions; the filter is met only pro forma"). Without an
   announced merger the shell value applies.
6. **The owner's profile still rules.** Why: accepting early hyper-growth widens what may be
   considered, it does not loosen risk control. The limits live in `research_context.strategy`
   (`sections`: the strategy.md text on beliefs, entry / exit and what the owner avoids;
   `candidate_criteria`; `buckets`) and in each thesis's `size_plan`; `strategy_status` only shows
   buckets, targets and rule ids. Position size limits for small / speculative positions and the
   requirement of hard catalysts keep applying. A candidate without a dated, hard catalyst does not
   get a "first tranche now"; a tranche plan never exceeds the strategy's limit for that kind of
   position. When the strategy states no such limit or catalyst rule, say so; never invent one.
7. **Keep facts, assessment, outlook and entry conditions apart.** Why: the owner must see what is
   sourced and what is judgement.
   - **Facts** go to cashU with sources: `add_research_note` (instrument or candidate; facts and
     sentiment only, including the SPAC numbers of rule 4 and dated catalysts in `details.event` +
     `event_date`). An instrument the profile neither holds nor watches that does not fully match
     the candidate criteria gets no note (`references/candidates.md`): offer `add_to_watchlist` and
     write the notes only after an explicit yes; otherwise say its facts are not in cashU.
   - **Assessment** (the two scores, the two rankings) and **outlook** (explicit horizon, main risks)
     are labelled sections of your answer; for a topic they go to `set_topic_market_view`.
   - **Entry conditions** (rule 3): for a held or watched instrument summarise them in the
     recommendation `reason` (`set_recommendation(s)`, at most 280 characters, no amounts). The value
     follows the advice: a first tranche now -> `buy` (only with a dated hard catalyst and within the
     strategy's limit); not yet -> `hold` (czekam) with the conditions in the reason; `buy_asap` only
     for a time-sensitive reason. Example reason: "Pierwsza transza 1/3 planowanej pozycji teraz;
     kolejna po podpisaniu kontraktu X; wstrzymuje: odkupy powyżej progu z Twojej strategii".
     Event triggers (a contract, the vote, a report, redemptions) go into the note's `details.event`
     + `event_date`. Alerts follow `references/alerts.md` only: the dynamic kinds `range_breakout` /
     `volume_spike`, never a price level as an entry trigger.
   - **The entry plan is the owner's.** It lives in the thesis of the held or watched instrument,
     which the owner sets in the app (asset page > "Teza" > "Dodaj" / "Edytuj"): "Wejście" (the
     entry triggers), "Unieważnienie" (the facts that block or end it), "Wielkość i dokupienia"
     (the tranches of the planned position), "Plan wyjścia". You propose the wording in the
     answer; you never write it on your own. In an interactive session, after an explicit yes to
     the exact wording, `upsert_thesis` may save it for the owner. On every later run, check the
     fresh facts against the owner's plan: a trigger met or a blocker hit is a note with
     `thesis_relation` (`supports` / `weakens` / `invalidates`, `references/rubrics.md`).
   - No thesis yet: say so ("brak planu wejścia: ustaw w aplikacji, Teza > Dodaj") and give the
     proposed wording. A candidate the profile does not watch gets one only after
     `add_to_watchlist` (explicit yes). Never hide a plan in a note's summary or in a file
     presented as done.
   - The two rankings are analysis: they belong in the answer and the run summary, not in a stored
     field.

## How to apply

1. Read `research_context` (`strategy.sections`, `candidate_criteria`, `buckets`, the owner's
   theses with their entry plan): limits, hard filters, catalyst rules, triggers and blockers.
2. Collect facts with sources; for a SPAC, both values of rule 4 and the dilution table.
3. Score scale potential and execution risk separately (rule 1).
4. Rank twice (rule 2).
5. Check the hard filters, naming the value used (rule 5) and the profile limits (rule 6).
6. Write the entry conditions per instrument (rule 3): checked against the owner's plan, or
   proposed when there is none.
7. Save facts and recommendations (rule 7), alerts only as `references/alerts.md` allows; leave
   the entry plan to the owner.

## Anti-patterns

- "Zbyt wczesny etap, brak przychodów -> odrzucam" with no scale assessment.
- One blended ranking.
- "Obserwuj" with no trigger, tranche or blocker.
- Quoting the deal's pro forma valuation as the market cap, or the shell's cap as the company's.
- Treating the trust value as a floor after the merger closed.
- A first tranche on a candidate with no hard catalyst, or above the strategy's limit.
- Writing the entry plan yourself (into a note, a file or the thesis without the owner's yes).
