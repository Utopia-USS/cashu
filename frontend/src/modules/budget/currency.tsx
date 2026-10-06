// The budget's currency choice, shared by the budget tabs of one profile and remembered per profile
// (browser storage is only a convenience: it may be unavailable, the server default applies then).
import { useEffect, useState } from "react";
import { ApiError } from "../../core/api";
import { useSlug } from "../../core/context";
import { useAsync } from "../../hooks";
import { ck } from "../../swr";
import { Seg } from "../../ui";
import type { BudgetCurrencies } from "./api";
import { getBudgetCurrencies } from "./api";
import { pickCurrency } from "./logic";
import { readStored } from "../../core/storage.ts";

const KEY = (slug: string) => `cashu.budget.currency.${slug}`;
const chosen = new Map<string, string>(); // this session, per profile
const listeners = new Set<() => void>();

function remembered(slug: string): string | null {
  if (chosen.has(slug)) return chosen.get(slug)!;
  try { return readStored(localStorage, KEY(slug)); } catch { return null; }
}

function remember(slug: string, currency: string) {
  chosen.set(slug, currency);
  try { localStorage.setItem(KEY(slug), currency); } catch { /* storage unavailable */ }
  listeners.forEach((l) => l());
}

export interface BudgetCurrency {
  /** null while the list loads, or when the server has no currency list (then the views ask
   * without a currency and get the profile's base currency). */
  currency: string | null;
  info: BudgetCurrencies | null;
  /** The list arrived (or failed): views can fetch now. */
  ready: boolean;
  setCurrency: (c: string) => void;
}

export function useBudgetCurrency(): BudgetCurrency {
  const slug = useSlug();
  // An older server (or the dev mock) without the list answers 404: "no list" is an answer too, so a revisit
  // does not wait for it again (F7 PX2).
  const { data, error } = useAsync(
    () => getBudgetCurrencies(slug).catch((e) => {
      if (e instanceof ApiError && e.status === 404) return "none" as const;
      throw e;
    }),
    [slug],
    { key: ck(slug, "budget", "currencies") },
  );
  const info = data && data !== "none" && data.base ? data : null;
  const [, bump] = useState(0);
  useEffect(() => {
    const l = () => bump((n) => n + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  return {
    currency: pickCurrency(remembered(slug), info),
    info,
    ready: data != null || error != null,
    setCurrency: (c) => remember(slug, c),
  };
}

/** Segmented currency switch, shown only when the profile has data in more than one currency. */
export function CurrencySwitch({ bc }: { bc: BudgetCurrency }) {
  const list = bc.info?.currencies ?? [];
  if (list.length < 2 || !bc.currency) return null;
  return <Seg<string> items={list.map((c) => [c.currency, c.currency])} value={bc.currency} onChange={bc.setCurrency} />;
}
