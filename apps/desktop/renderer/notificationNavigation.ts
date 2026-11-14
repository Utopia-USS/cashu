import type { NotificationResolveResult } from "@cashu/host-protocol";
import type { OpenProfileIdentity } from "./shell/profileRoute.js";

export type NotificationDestination =
  | { readonly kind: "unavailable" }
  | {
      readonly kind: "target";
      readonly vault: string;
      readonly slug: string;
      readonly page: "overview" | "signals" | "review";
      readonly signalId?: string;
    };

/** A user's route or vault choice after intake wins over the delayed host reply. */
export class PendingNotificationNavigation {
  #pending: { route: string; vault: string; cancelled: boolean } | null = null;

  begin(route: string, vault: string): void {
    this.#pending = { route, vault, cancelled: false };
  }

  observe(route: string, vault: string): void {
    if (this.#pending !== null && (route !== this.#pending.route || vault !== this.#pending.vault))
      this.#pending.cancelled = true;
  }

  consume(): boolean {
    const accepted = this.#pending !== null && !this.#pending.cancelled;
    this.#pending = null;
    return accepted;
  }
}

/** A host result can only address one currently open vault with a current profile identity. */
export function notificationDestination(
  result: NotificationResolveResult,
  profiles: readonly OpenProfileIdentity[],
  openVaults: readonly string[],
): NotificationDestination {
  if (result.kind === "unavailable" || !openVaults.includes(result.vaultId))
    return { kind: "unavailable" };
  const matches = profiles.filter((profile) => profile.vault === result.vaultId);
  if (matches.length !== 1 || !matches[0]?.slug) return { kind: "unavailable" };
  const profile = matches[0];
  if (result.target === "signal")
    return {
      kind: "target",
      vault: profile.vault,
      slug: profile.slug,
      page: "signals",
      signalId: result.signalId,
    };
  return {
    kind: "target",
    vault: profile.vault,
    slug: profile.slug,
    page:
      result.target === "signalsSummary"
        ? "signals"
        : result.target === "reviewDigest"
          ? "review"
          : "overview",
  };
}
