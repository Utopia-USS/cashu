// The host's Enable Banking status for the budget shell: whether the key is set up (the import drawer's Open
// Banking radio) and how many bank sessions there are (what `↻ Synchronizuj` can sync), plus the sync itself.
import { bankingSettings } from "@cashu/store/core/banking-settings";
import { useUiAction } from "@cashu/store-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { z } from "zod";

const statusSchema = z.object({
  configured: z.boolean(),
  sessions: z.array(z.object({ handle: z.string() })).max(32),
});
const syncSchema = z.object({ errors: z.array(z.string()).optional() });

export type SyncOutcome = { ok: true } | { ok: false; error: string | null };

export function useBankingStatus() {
  const action = useUiAction(bankingSettings);
  const run = useRef(action.run);
  useLayoutEffect(() => {
    run.current = action.run;
  });
  const [status, setStatus] = useState({ configured: false, sessions: 0 });
  const read = async () => {
    const r = await run.current({ type: "status" });
    const parsed = r.status === "completed" ? statusSchema.safeParse(r.value) : null;
    if (parsed?.success)
      setStatus({ configured: parsed.data.configured, sessions: parsed.data.sessions.length });
  };
  useEffect(() => {
    let live = true;
    void run.current({ type: "status" }).then((r) => {
      const parsed = r.status === "completed" ? statusSchema.safeParse(r.value) : null;
      if (live && parsed?.success)
        setStatus({ configured: parsed.data.configured, sessions: parsed.data.sessions.length });
    });
    return () => {
      live = false;
    };
  }, []);
  return {
    ...status,
    /** `↻ Synchronizuj`: the host's bank sync; the first error text when it failed. */
    sync: async (): Promise<SyncOutcome> => {
      const r = await run.current({ type: "sync" });
      if (r.status !== "completed") return { ok: false, error: r.reason };
      const parsed = syncSchema.safeParse(r.value);
      await read();
      return parsed.success && !parsed.data.errors?.length
        ? { ok: true }
        : { ok: false, error: parsed.success ? (parsed.data.errors?.[0] ?? null) : null };
    },
  };
}
