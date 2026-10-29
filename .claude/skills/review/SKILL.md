---
name: review
description: >
  Use when the owner wants their periodic investments review in chat (the cards of the app's review deck),
  on demand or when due, or wants to change how often it comes, its name or cards.
  Applicability - POSITIVE: the review deck in chat from review_context and the read tools, the owner's
  decisions recorded, the review closed with mark_review_done and an agenda for the next research run;
  the strategy.yaml review: section (every, day, name, cards) proposed with propose_strategy.
  Applicability - NEGATIVE: NOT the strategy or its goals (investments-setup), the research run
  (market-research), new rules or alerts (extension-builder) or imports (import-builder); never
  recommends instruments or trades.
  Triggers: /review, "przegląd", "zróbmy przegląd", "przegląd tygodnia", "przegląd miesiąca", "co się
  zmieniło", "czy świat się wali", "co mnie ominęło", "ustaw przegląd co dwa tygodnie", "zmień karty
  przeglądu".
---

# review: the periodic review in chat

The owner's review is a short, calm look at whether anything needs them, card by card, from the general
to the specific. The app shows it as a deck of cards; this skill runs the same deck in chat. 5-15
minutes. Conversation in Polish, regular hyphens only.

## Relationship to the workspace

| The workspace CLAUDE.md and MCP server own | This skill adds |
|---|---|
| privacy level, boundaries, the MCP tool list | which tool feeds each card and how to say it in one sentence |
| which profile the workspace serves | the order of the cards, skipping the empty ones, the agenda |
| approval of proposals in the app | the `review:` section of strategy.yaml and its proposal |

## Problem -> reference mapping

| Task / question | Start with |
|---|---|
| Run the review now (due or on demand) | this file, Flow |
| What each card shows and where its facts come from | this file, Cards |
| Close the review, send cards to the research agent | this file, Flow step 4 |
| Change how often the review comes, its name or cards | this file, Changing the review |

## Non-negotiable

- Data comes only from the profile's MCP server `cashu-<slug>`. Read the privacy level from
  `profile_overview`: in `strict` you have percentages and shares only, never amounts; say moves in %
  and pp.
- Facts, not advice. Never recommend buying or selling, never name a price target. A decision is the
  owner's answer, recorded only when they give it.
- One context per card: a one-sentence verdict, at most 3 facts, then ask. Longer explanations only
  when the owner asks for more ("więcej"), with the source of each fact.
- A card with nothing to say this period is skipped; list the skipped ones in one line at the end.
- The review counts only when recorded with `mark_review_done`, and only after the owner agrees.

## MCP tools used

`profile_overview`, `review_context` (the review's name, rhythm, cards, period, last review, calendar),
`research_context` (segments, macro, candidates, positions with thesis health), `research_notes`,
`signals`, `theses`, `portfolio_overview`; writes: `record_decision`, `mark_review_done`,
`propose_strategy` (only for Changing the review).

## Flow

1. **Start.** `profile_overview` (privacy level), then `review_context`. Say in one line: the review's
   name, the period (`since` to today) and whether it is due. If the last review has an agenda, mention
   that the research run should have answered it.
2. **Cards** in `review.cards` order (see Cards). For each card: the verdict sentence and up to 3 facts,
   then one question with options: `Jasne, dalej` / `Wróć do tego (dla agenta)` / `Więcej`. With
   `Więcej`, give the longer view (research notes with sources), then ask again. `Wróć do tego` puts
   the card on the agenda; ask for an optional note for the agent in the owner's words.
3. **Decisions** (the decide card): for each open signal ask what the owner does and why, never
   suggest it. Record with `record_decision(signal_id, action, reason)` only for an explicit answer
   (`bought`, `sold`, `held`, `ignored`, `other`). A weakened thesis or a pending proposal is pointed
   to the app (theses and proposals are approved there).
4. **Close.** Summary in at most 6 lines: cards seen, decisions, the agenda, skipped cards. Ask whether
   to close the review; on yes `mark_review_done(notes, agenda)`, `agenda` = the flagged cards with the
   owner's notes. Say when the next one comes (`review.next_on` after closing, from `review_context`).

## Cards

| Card | Verdict | Facts from |
|---|---|---|
| `world` - Czy świat się wali | the period's move vs the market, calm or unusual | `research_context.segments` (sum of `contribution_1w` incl. currency) and `macro` (risk card: the market, its brief) |
| `sectors` - Sektory | which segments made the move | `research_context.segments`: `contribution_1w` in pp, `return_1w`, the first brief |
| `positions` - Pozycje | the biggest fall and rise | `research_context.segments[].instruments`: `return_1w`; skip when no move is 3 % or more |
| `events` - Wydarzenia | what moved the portfolio | `research_notes` since `since`: strength 2+ or a thesis relation; macro state changes |
| `decide` - Do decyzji | how many things wait | `signals` (open, no decision, not snoozed), `research_context.positions[].research.health` weakened / invalidated, pending proposals in `profile_overview` |
| `ideas` - Okazje | candidates outside the portfolio | `research_context.candidates.open` (the app accepts or dismisses them) |
| `calendar` - Kalendarz 14 dni | what is coming | `review_context.calendar.events`; say when `stale` |

## Changing the review

The review is configured in strategy.yaml (owner's file, changed by a proposal the owner approves in
the app):

```yaml
review:
  every: week        # week | 2weeks | month (month: the first `day` of the month)
  day: sunday        # default notifications.digest_weekday
  name: Przegląd tygodnia
  cards: [world, sectors, positions, events, decide, ideas, calendar]
```

Ask what the owner wants (how often, which day, which cards, a name), read the current strategy
(`strategy_status`), change only the `review:` section, validate with `propose_strategy(dry_run: true)`
and then propose it with a `reason` naming the change. The app applies it after approval.

## References

None: this skill is single-file; the whole procedure is above.

## See also

- `/investments-setup` - the strategy itself and the deeper monthly / quarterly check-in against goals.
- `/market-research` - the research run that reads the review's agenda (`owner_review`).
- `/extension-builder` - a new rule or alert when a card shows something the rules miss.

## Self-audit checklist

Before telling the owner the review is done:
1. The privacy level was read and no amount was said in `strict` mode.
2. Every card in `review.cards` was shown or named as skipped with the reason.
3. No buy or sell suggestion, no price target; every recorded decision is the owner's own answer.
4. `mark_review_done` was called only after the owner agreed, with the flagged cards as the agenda.
5. A change of the rhythm, name or cards went through `propose_strategy`, not a direct file edit.
