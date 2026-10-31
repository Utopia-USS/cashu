import { currentVault } from "@cashu/store/device";
import type { ReactNode } from "react";
import { ProfileContext, useStoreClient } from "./context.js";
import { useQuery } from "./useQuery.js";

/**
 * Makes the current profile (a device-local setting, `device.currentVault`) the store that vault
 * queries and commands use. Switching profile is the `setCurrentVault` device command: it switches
 * the store, never a filter. Without a current profile that is open on this device, `fallback` renders
 * (the profile picker or onboarding).
 */
export function ProfileProvider({
  children,
  fallback = null,
}: {
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const client = useStoreClient();
  const current = useQuery(currentVault);
  const vault = current !== null && client.vaults.includes(current) ? current : null;
  if (vault === null) return fallback;
  return <ProfileContext value={vault}>{children}</ProfileContext>;
}
