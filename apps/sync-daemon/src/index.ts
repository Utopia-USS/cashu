// TRANSITIONAL(S49): the lab / dev host of the outbox bridge (S31a). The CLI is `main.ts`; nothing
// else imports this app (apps are leaves).
export const PACKAGE_NAME = "@cashu/sync-daemon";
export { main } from "./main.js";
