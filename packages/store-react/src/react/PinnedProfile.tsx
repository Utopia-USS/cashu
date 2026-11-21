// A subtree pinned to one vault: the sheet or modal opened over profile A keeps READING and writing A
// after the current profile switched to B (`useQuery`, `useProfile` and an unpinned `useCommand` all
// see the pinned vault). A vault that is no longer open on this device renders `fallback` instead, so
// nothing reads a closed store.
import type { ReactNode } from "react";
import { ProfileContext, useStoreClient } from "./context.js";

export function PinnedProfile({
  vault,
  children,
  fallback = null,
}: {
  vault: string;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const client = useStoreClient();
  if (!client.vaults.includes(vault)) return fallback;
  return <ProfileContext value={vault}>{children}</ProfileContext>;
}
