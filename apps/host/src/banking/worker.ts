import type { BankingRuntime } from "./runtime.js";
import type { BankingAttempt } from "./service.js";

/** Daily worker calls this only for an enabled budget vault on the current fetch holder. */
export async function runDailyBankingSync(
  runtime: BankingRuntime,
  profileId: string,
): Promise<{
  readonly outcome: "ok" | "unavailable" | "failed";
  readonly accounts?: number;
  readonly inserted?: number;
  readonly attempts?: readonly BankingAttempt[];
}> {
  const service = runtime.service(profileId);
  if (!service) return { outcome: "unavailable" };
  try {
    const status = await service.status();
    if (!status.configured || status.sessions.length === 0) return { outcome: "unavailable" };
    const result = await service.sync({ reason: "daily" });
    return {
      outcome: "ok",
      accounts: result.accounts,
      inserted: result.inserted,
      attempts: result.attempts,
    };
  } catch {
    return { outcome: "failed" };
  }
}
