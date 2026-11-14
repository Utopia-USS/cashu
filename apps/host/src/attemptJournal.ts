// The host's binding of the portable private SQL command attempt journal (table `host_attempts`).
import type { JsonValue } from "@cashu/host-protocol/store";
import { SqlCommandAttemptJournal, type SqlDriver } from "@cashu/store";

export type SqlAttemptJournal = SqlCommandAttemptJournal<JsonValue>;
export const SqlAttemptJournal = {
  open(
    driver: SqlDriver,
    mode: "existing" | "new",
    now: () => number = Date.now,
  ): SqlAttemptJournal {
    return SqlCommandAttemptJournal.open<JsonValue>(driver, mode, "host_attempts", now);
  },
};
