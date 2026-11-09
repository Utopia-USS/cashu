import { lang } from "@cashu/i18n";
import { bankingSettings } from "@cashu/store/core/banking-settings";
import type { UiActionResult } from "@cashu/store/ui-actions";
import { useProfile, useUiAction } from "@cashu/store-react";
import { useLayoutEffect, useRef, useState } from "react";
import { z } from "zod";
import { BankingScreen } from "./BankingScreen.js";
import type { BankingAction, BankingReply, BankingUiPort } from "./useBankingScreen.js";

interface NativeBankingBridge {
  chooseKeyAndConfigure(vaultId: string, appId: string): Promise<unknown>;
  configureWithDroppedKey(vaultId: string, appId: string, file: File): Promise<unknown>;
  openBank(vaultId: string, url: string): Promise<void>;
}
const chooserReply = z.union([
  z.object({ cancelled: z.literal(true) }),
  z.object({ ok: z.literal(true), value: z.object({ configured: z.literal(true) }) }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
const dropReply = z.union([
  z.object({ ok: z.literal(true), value: z.object({ configured: z.literal(true) }) }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
function bridge(): NativeBankingBridge | null {
  return (window as Window & { readonly cashuBanking?: NativeBankingBridge }).cashuBanking ?? null;
}

/**
 * Actions whose outcome can be unknown (an import or a stored change may have happened). They go
 * through their own UI action instance, which blocks after an unknown outcome until it is renewed;
 * every other action (reads, starting, cancelling or feeding a consent) stays usable meanwhile.
 */
const WRITES: ReadonlySet<BankingAction["type"]> = new Set([
  "unconfigure",
  "completeConsent",
  "sync",
  "forgetSession",
]);

type Run = (input: BankingAction) => Promise<UiActionResult<unknown>>;

function reply(result: UiActionResult<unknown>): BankingReply {
  return result.status === "completed"
    ? { ok: true, value: result.value }
    : {
        ok: false,
        error:
          result.status === "refused" || result.status === "not_started"
            ? result.reason
            : "outcome_unknown",
      };
}

/**
 * The write channel. A UI action with an unknown outcome blocks every later call of its instance, so
 * writes get their own instance, remounted (by key) once the owner resolved every unknown attempt.
 */
function WriteChannel({ onRun }: { readonly onRun: (run: Run) => void }) {
  const action = useUiAction(bankingSettings);
  useLayoutEffect(() => {
    onRun(action.run);
  });
  return null;
}

/** Store UI actions and native main-process chooser, scoped to the currently selected vault. */
export function BankingSettingsPanel() {
  const vaultId = useProfile();
  const read = useUiAction(bankingSettings);
  const readRun = useRef(read.run);
  const writeRun = useRef<Run | null>(null);
  const vault = useRef(vaultId);
  const [writeEpoch, setWriteEpoch] = useState(0);
  useLayoutEffect(() => {
    readRun.current = read.run;
    vault.current = vaultId;
  });
  const [port] = useState<BankingUiPort>(() => ({
    async invoke(input: BankingAction): Promise<BankingReply> {
      const run = WRITES.has(input.type) ? writeRun.current : readRun.current;
      if (!run) return { ok: false, error: "unavailable" };
      return reply(await run(input));
    },
    async chooseKeyAndConfigure(appId: string) {
      const native = bridge();
      if (!native) return { ok: false, error: "unavailable" };
      const parsed = chooserReply.safeParse(
        await native.chooseKeyAndConfigure(vault.current, appId),
      );
      return parsed.success ? parsed.data : { ok: false, error: "unavailable" };
    },
    async configureWithDroppedKey(appId: string, file: File) {
      const native = bridge();
      if (!native) return { ok: false, error: "unavailable" };
      const parsed = dropReply.safeParse(
        await native.configureWithDroppedKey(vault.current, appId, file),
      );
      return parsed.success ? parsed.data : { ok: false, error: "unavailable" };
    },
    async openBank(url: string) {
      const native = bridge();
      if (!native) throw new Error("banking_unavailable");
      await native.openBank(vault.current, url);
    },
    settled() {
      setWriteEpoch((epoch) => epoch + 1);
    },
  }));
  return (
    <>
      <WriteChannel
        key={`${vaultId}:${writeEpoch}`}
        onRun={(run) => {
          writeRun.current = run;
        }}
      />
      <BankingScreen vaultId={vaultId} port={bridge() ? port : null} language={lang()} />
    </>
  );
}
