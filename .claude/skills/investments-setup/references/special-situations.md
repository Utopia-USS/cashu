# Special situations

The inventory (phase 3) or a check-in may reveal individual, time-sensitive issues. Examples of the
category: an exchange or broker in insolvency (claims with a filing deadline), frozen or delisted
holdings, a platform exiting the user's jurisdiction (withdraw-only), wrapper limits expiring at year
end, tax-form changes after a change of legal form.

Handle every one the same way:

1. **Research current facts online with sources**: court, trustee, deadline, what counts as evidence,
   official statements, current limits. No legal or tax advice; name professional help or collective
   initiatives only as information. Never bypass bot protection to reach a source; use another one.
2. **Deadline on top.** Put the deadline at the top of the current and every following message and
   session until resolved (`interview-state.md` keeps the list, SKILL.md session start step 6 reads it).
3. **Local note** `notes/interview/special-<topic>.md` (English) with: facts and sources, an evidence checklist,
   known vs unknown values (e.g. provable deposits vs the user's estimate of the balance; in strict mode
   as relative values unless the user agrees to note amounts), next step and its date.
4. **Representation in the app** (what exists today):
   - a claim against an insolvent platform: instrument asset class `claim` (valued manually, by default
     at 0 until the user sets a value in the app);
   - frozen or sanctioned holdings: a `delisting` record with `frozen: true` in the cashU import format
     (the holding is then valued manually), or the instrument's valuation mode set to manual where the
     app offers it;
   - an ordinary delisting with a cash-out: a `delisting` record with `frozen: false` plus a normal
     `sell`;
   - wrapper limits and deadlines: a manual check in `strategy.md` and a dated item in the start-up
     checklist of `mark_review_done`.
   If the app cannot represent something, tell the user it stays a manual note and write it among the
   manual checks in `strategy.md`.
5. **Reminder**: offer a one-off reminder (a scheduled task) for the deadline; create it only after the
   user's explicit yes.

Never ask for account numbers, case numbers tied to the user's identity, or login data for the
platform. Evidence (statements, screenshots) stays on the user's disk; you only keep the checklist of
what exists.
