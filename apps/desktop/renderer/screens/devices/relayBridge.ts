import type {
  RelayActionParams,
  RelayActionResult,
  RelayStatusParams,
  RelayStatusResult,
} from "@cashu/host-protocol";

/** The preload's `cashuRelay`: main checks params and results against the host protocol. */
export interface RelayBridge {
  status(input: RelayStatusParams): Promise<RelayStatusResult>;
  enable(input: RelayActionParams): Promise<RelayActionResult>;
  disable(input: RelayActionParams): Promise<RelayActionResult>;
  purge(input: RelayActionParams): Promise<RelayActionResult>;
  reconnect(input: RelayActionParams): Promise<RelayActionResult>;
  /** G2 override while the bank fetch is paused (the host re-checks the pause). */
  keepFetching(input: RelayActionParams): Promise<RelayActionResult>;
  /** "Try now": a sync pass now, which retries failing membership removals. */
  syncNow(input: RelayActionParams): Promise<RelayActionResult>;
}

export function relayBridge(): RelayBridge | null {
  return (window as Window & { readonly cashuRelay?: RelayBridge }).cashuRelay ?? null;
}
