// Bank sync (Enable Banking) at the end of the tabbar while a budget tab is open. A sync belongs to the
// profile it was started for: the set lives at module scope so a remount (refresh, tab switch) keeps it.
import { useEffect, useRef, useState } from "react";
import { postResync } from "../../core/api";
import { errorText } from "../../core/messages";
import type { TabActionProps } from "../../core/types";
import { useToast } from "../../ui";

const running = new Set<string>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export function BankSync({ slug, profileName, networth, refresh }: TabActionProps) {
  const toast = useToast();
  const [, rerender] = useState(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const l = () => rerender((n) => n + 1);
    listeners.add(l);
    return () => { alive.current = false; listeners.delete(l); };
  }, []);

  const banks = (networth?.accounts ?? []).filter((a) => a.bank !== "manual" && a.type !== "cash");
  const busy = running.has(slug);

  const sync = async () => {
    running.add(slug); notify();
    let ok = false;
    try {
      const res = await postResync(slug);
      ok = res.ok;
      let msg = res.error || "Synchronizacja nieudana";
      if (res.ok) {
        msg = `Wgrano ${res.inserted ?? 0} nowych transakcji`;
        if (res.pairs) msg += `, ${res.pairs} przelewów wewn.`;
        if (res.errors?.length) msg += ` · ${res.errors.length} konto/a pominięte (limit banku)`;
      }
      toast(`${profileName}: ${msg}`, 5000);
    } catch (e) {
      toast(`${profileName}: ${errorText(e)}`, 5000);
    } finally {
      running.delete(slug); notify();
    }
    if (ok && alive.current) refresh();
  };

  return (
    <button className="btn" onClick={sync} disabled={busy || !banks.length}
      title={banks.length ? "Pobierz nowe transakcje z banków (Enable Banking)" : "Brak kont bankowych do synchronizacji"}>
      {busy ? "Synchronizuję…" : "↻ Synchronizuj"}
    </button>
  );
}
