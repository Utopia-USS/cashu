# Alert proposals after research (dynamic kinds)

Static price levels miss the moment an instrument leaves a sideways range because of news or a changed
situation. After a research run (the weekly routine or a thesis review) you may propose a few alerts
of the two dynamic kinds, so the app's daily run watches for that moment on hard data. An alert is a
condition the app checks on stored daily bars; it is never a forecast, a target or a trade.

## How a proposal reaches the owner

`add_alert` creates the alert at once as **active with source `agent`**: the app badges it (`A agent`)
in every alert list, shows your `note` as the reason, and the owner keeps it, mutes it or removes it.
There is no pending state, so the proposal is the alert plus its reason:

- **Interactive session:** list the proposals in the chat (symbol, kind, parameters, reason) and call
  `add_alert` only for those the owner accepts. No answer means none.
- **Unattended run** (scheduled, `claude -p`): create them directly within the limits below and list
  them in the final summary; the owner reviews them in the app.

## Kinds

| kind | params (`window_days` counts sessions; fractions like every threshold) | fires when | app name |
|---|---|---|---|
| `range_breakout` | `window_days` 10-260 (default 30), `max_range_pct` 0.01-0.30 (default 0.08 = 8 %), `direction` `up` / `down` / `any` (default `any`) | the closes of the `window_days` sessions before the last one stayed within a range of at most `max_range_pct` ((high - low) / low), and the last close left it in the given direction | `Wybicie z konsolidacji` |
| `volume_spike` | `window_days` 5-260 (default 20), `multiple` 1.5-20 (default 2.5) | the last session's volume is at least `multiple` times the average of the `window_days` sessions before it | `Skok wolumenu` |

- Start from the defaults; change them only for a stated reason (a shorter window before a near event,
  `direction` only when the owner's thesis names one side). Never send `max_range_pct` as a percent
  (`8` is refused; `0.08` is 8 %).
- `volume_spike` needs volume data: the app skips the alert for instruments without volumes (some
  funds and indices), so propose it for exchange-traded stocks, ETFs and crypto only.
- The `add_alert` answer carries `state`: for `range_breakout` the range of the last window
  (`range_low`, `range_high`, `range_pct`), for `volume_spike` the last volume's `ratio` to its average
  (raw volumes are never sent). If `range_pct` is already wider than `max_range_pct`, the alert stays
  silent until the range narrows: say so in the summary instead of loosening the parameter. `state` is
  `null` while fewer than `window_days + 1` sessions are stored (a freshly watched instrument): then say
  nothing about the range or the volume.

Use only these two kinds here. Price levels, drawdowns, SMA crosses and weights are the owner's own
alerts (Alerty in the app) or rules (`/extension-builder`); you do not propose them.

## When a proposal is worth it

All of these hold:

1. The instrument is held or watched (`add_alert` refuses others; never call `add_to_watchlist` just to
   set an alert) and is a single stock, a sector or thematic ETF, or crypto. Never for owner-named
   (private) instruments, cash, bonds or broad index ETFs.
2. This run wrote a note about it (or the thesis review found a field in play) that points to a dated
   catalyst or a changed situation that can move the instrument out of its recent range: results, a
   ruling, a tender offer deadline, a premiere, a regulatory decision, an index change. The alert
   watches for the move; it says nothing about its direction or size.
3. `alerts(status="all")` shows no live alert of the same kind on the instrument (any source) and no
   muted agent alert of that kind on it (the owner said no once; never re-propose it).
4. `limits` in the `alerts` answer leaves room: propose nothing when fewer than 10 agent alerts are left
   below `agent_max`.

## Limits

- At most **3 proposals per run** (weekly routine, thesis review), at most **1 per instrument**; an
  on-demand run for one instrument at most 1, and only in an interactive session.
- None when the run found nothing new about the instrument. Fewer is better: a proposal needs a reason
  from this run's notes.

## The call

```json
{
  "kind": "range_breakout",
  "instrument": "XYZ.WA",
  "params": {"window_days": 30, "max_range_pct": 0.08, "direction": "any"},
  "polarity": "neutral",
  "severity": "info",
  "title": "XYZ: wybicie z konsolidacji 30 sesji",
  "note": "Po notatce z 4.10: wyniki III kwartału 12.11, termin wezwania 20.11. Alert z researchu.",
  "expires_in_days": 45
}
```

- `params`: e.g. `{"window_days": 30, "max_range_pct": 0.08, "direction": "any"}` or
  `{"window_days": 20, "multiple": 2.5}`.
- `polarity`: `neutral`; for `range_breakout` with `direction` `up` `positive`, `down` `negative`.
  `severity`: always `info` (the owner raises it to `action` if they want a notification).
- `title` (at most 120 characters, Polish), as the app names them:
  `{SYMBOL}: wybicie z konsolidacji {N} sesji`, `{SYMBOL}: wolumen {m}x średniej`.
- `note` (keep it under 300 characters, Polish): the reason, the dated fact or event from this run's
  note (`Po notatce z <d.m>: ...`). Facts and dates only.
- `expires_in_days`: until about two weeks after the catalyst's date; without a dated catalyst 60.
  Leave `cooldown_days` to the default.
- If the tool refuses the call (`limit`, validation), do not retry with other parameters; name it in
  the summary.

## Never

- A reason or title that predicts: no `spodziewane wybicie`, `może wybić`, `szykuje się ruch`,
  `kierunek na`, targets, support or resistance levels, `breakout` as a trading idea. The alert
  reports a move after it happened; the reason names only the dated fact or event.
- Buy or sell wording of any kind, or an alert framed as an entry or exit trigger.
- Portfolio data in the title or note (amounts, weights, cost, gains, account labels).
- Muting or changing the owner's alerts (`mute_alert`) unless the owner asks for it in the chat.

## In the summary

One line per alert created (or proposed and accepted): `XYZ.WA · wybicie z konsolidacji 30 sesji
(zakres do 8 %) · powód: wyniki 12.11 · wygasa 26.11`, then: proposals declined or refused, and where
they are in the app (Inwestycje > Alerty, badge `A agent`).
