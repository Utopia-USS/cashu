// The tab header's data for a tab root: who the profile is, incognito and the freshness line. The route
// passes `openProfile` (navigation stays in the route) and adds the title and any action.
import { dataFreshness } from "@cashu/store/budget/freshness";
import { profileIdentity } from "@cashu/store/core/profile";
import { useQuery } from "@cashu/store-react";
import { useUiEnv } from "@cashu/ui/native";
import { bankFresh } from "./fresh";
import { S } from "./Shell.strings";
import type { TabFresh, TabHeaderProps } from "./TabHeader";
import { initialOf } from "./tabs";
import { useIncognito } from "./useAppEnv";
import { useNow } from "./useNow";

export function useTabChrome(args: {
  fresh: "bank" | "prices" | "none";
  openProfile(): void;
}): Omit<TabHeaderProps, "title" | "right"> {
  const { locale } = useUiEnv();
  const identity = useQuery(profileIdentity);
  const freshness = useQuery(dataFreshness);
  const incognito = useIncognito();
  const { now } = useNow();
  const name = identity?.name ?? "";
  const fresh: TabFresh | null =
    args.fresh === "bank"
      ? bankFresh(freshness.bankDataAt, new Date(now), locale)
      : args.fresh === "prices"
        ? { tone: "muted", text: S.pricesLater }
        : null;
  return {
    profile: { initial: initialOf(name), name },
    fresh,
    // Pending local writes arrive with the sync engine (S43).
    offline: null,
    incognito: incognito.on,
    onProfilePress: args.openProfile,
    onIncognitoToggle: incognito.toggle,
  };
}
