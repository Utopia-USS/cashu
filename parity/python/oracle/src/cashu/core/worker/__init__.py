"""The background worker: one job runner for every profile and its enabled modules.

``cashu worker run`` (scheduled daily by launchd on macOS, ``cashu worker install``):

1. investments: the daily check for every profile with investments enabled (prices, NBP rates,
   rules, the signal lifecycle);
2. budget: the Open Banking sync per profile, only when configured and not throttled;
3. immediate notifications for the profile's immediate severities (strategy ``notifications``),
   one per signal and severity (``inv_notification_log``);
4. on the profile's digest weekday one weekly digest notification.

Modules: ``runner`` (the run), ``schedule``, ``scheduler`` (launchd / Windows stub), ``notifier``
(terminal-notifier / osascript / log / Windows stub), ``notifications`` (immediate + digest),
``investments`` / ``budget`` (module glue), ``state`` (worker bookkeeping file), ``service``
(status / install / uninstall for the CLI and the API), ``cli``, ``api``.
"""
