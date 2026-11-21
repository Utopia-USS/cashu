// @cashu/host: the local host process (one per data dir). Its entry is `cli.ts` (`cashu-host`); nothing
// else imports this app (apps are leaves). See host.ts for the composition and the
// cashu-ts-architecture skill (layers.md, "Which process runs what").
export { type LocalHost, type LocalHostOptions, startLocalHost } from "./host.js";
export { main } from "./main.js";
