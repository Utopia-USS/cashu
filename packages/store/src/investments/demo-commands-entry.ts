// @cashu/store/investments/demo-commands: TRANSITIONAL(S44): the companion demo fixture's leader-only
// commands (the daily evaluation that writes alert, rule-run and signal events, and the signal
// lifecycle writes) until pairing makes the Mac the leader for the phone's vaults. Only the fixture
// imports this entry; the phone's screens never write leader events.
export { dailyEvaluation } from "./commands/daily.js";
export { applySignalActions, snoozeSignalCommand } from "./commands/signals.js";
