import type { OpenVault } from "../stores.js";
import type { BudgetSyncPort } from "../worker/contracts.js";
import { reportSuccessfulFetch } from "../worker/leaseReport.js";
import type { BankingRuntime } from "./runtime.js";

/** Real budget worker adapter. Fetch leadership and durable scheduling stay in the worker. */
export function bankingWorkerPort(runtime: BankingRuntime): BudgetSyncPort {
  const serviceFor = (vault: OpenVault) =>
    vault.mode === "native" ? runtime.service(vault.id) : null;
  return {
    async configured(vault) {
      return (await serviceFor(vault)?.status())?.configured === true;
    },
    async hasSavedSessions(vault) {
      return ((await serviceFor(vault)?.status())?.sessions.length ?? 0) > 0;
    },
    async sync(vault, days, guard) {
      guard();
      const service = serviceFor(vault);
      if (!service) return { ok: false, errors: ["unavailable"] };
      const endFetch = vault.native?.beginFetch();
      if (!endFetch) return { ok: false, errors: ["fetch_authority_unavailable"] };
      let result: Awaited<ReturnType<typeof service.sync>>;
      try {
        result = await service.sync({ days, reason: "daily", guard });
      } finally {
        endFetch();
      }
      guard();
      if (result.banks > 0 && result.attempts.length === 0)
        await reportSuccessfulFetch(vault, guard);
      return {
        ok: result.attempts.length === 0,
        inserted: result.inserted,
        banks: result.banks,
        errors: result.errors,
      };
    },
  };
}
