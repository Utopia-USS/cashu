// @cashu/store/investments/commands: the investments commands the phone runs, without the root barrel
// or the whole commands barrel (Metro bundles whole files, the phone does not tree-shake): seeding the
// companion demo (accounts, instruments, trades, theses, alerts, research runs and notes) and the
// journal / review writes of the screens. Leader-only commands live in `./investments/demo-commands`.
export { addBrokerageAccount } from "./commands/accounts.js";
export { createAlert } from "./commands/alertWrites.js";
export { classifyInstrument, createInstrument } from "./commands/instruments.js";
export { createThesis, recordDecision } from "./commands/journal.js";
export { addManualTransaction } from "./commands/manual.js";
export { markReviewDone } from "./commands/reviews.js";
export { addToWatchlist } from "./commands/watchlist.js";
export { addResearchNote, finishResearchRun, startResearchRun } from "./research/commands.js";
