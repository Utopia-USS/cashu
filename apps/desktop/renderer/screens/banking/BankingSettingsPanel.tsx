import { lang } from "@cashu/i18n";
import { bankingSettings } from "@cashu/store/core/banking-settings";
import { useProfile, useUiAction } from "@cashu/store-react";
import { useLayoutEffect, useRef, useState } from "react";
import { z } from "zod";
import { BankingScreen } from "./BankingScreen.js";
import type { BankingAction, BankingReply, BankingUiPort } from "./useBankingScreen.js";

interface NativeBankingBridge {
  chooseKeyAndConfigure(vaultId: string, appId: string): Promise<unknown>;
  openBank(vaultId: string, url: string): Promise<void>;
}
const chooserReply = z.union([
  z.object({ cancelled: z.literal(true) }),
  z.object({ ok: z.literal(true), value: z.object({ configured: z.literal(true) }) }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
function bridge(): NativeBankingBridge | null {
  return (window as Window & { readonly cashuBanking?: NativeBankingBridge }).cashuBanking ?? null;
}

/** Store UI actions and native main-process chooser, scoped to the currently selected vault. */
export function BankingSettingsPanel() {
  const vaultId = useProfile();
  const action = useUiAction(bankingSettings);
  const run = useRef(action.run);
  const vault = useRef(vaultId);
  useLayoutEffect(() => {
    run.current = action.run;
    vault.current = vaultId;
  });
  const [port] = useState<BankingUiPort>(() => ({
    async invoke(input: BankingAction): Promise<BankingReply> {
      const result = await run.current(input);
      return result.status === "completed"
        ? { ok: true, value: result.value }
        : {
            ok: false,
            error:
              result.status === "refused" || result.status === "not_started"
                ? result.reason
                : "outcome_unknown",
          };
    },
    async chooseKeyAndConfigure(appId: string) {
      const native = bridge();
      if (!native) return { ok: false, error: "unavailable" };
      const parsed = chooserReply.safeParse(
        await native.chooseKeyAndConfigure(vault.current, appId),
      );
      return parsed.success ? parsed.data : { ok: false, error: "unavailable" };
    },
    async openBank(url: string) {
      const native = bridge();
      if (!native) throw new Error("banking_unavailable");
      await native.openBank(vault.current, url);
    },
  }));
  return <BankingScreen vaultId={vaultId} port={bridge() ? port : null} language={lang()} />;
}
