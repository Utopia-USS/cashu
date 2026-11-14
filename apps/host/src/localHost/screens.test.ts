// The Signals capability of an open vault: local actions (watchlist, snooze, offline add) stay
// current while the vault is open, whoever holds the market lease; only the public-market ports
// follow the lease. Synthetic objects only.
import type { NotificationQueue } from "@cashu/store/investments/local";
import { describe, expect, it } from "vitest";
import type { SignalsMarketPorts } from "../signalsScreen.js";
import type { HostStores, OpenVault } from "../stores.js";
import { localSignalsBinder } from "./screens.js";

const ID = "a".repeat(32);

function setup() {
  const vaults = new Map<string, OpenVault>([[ID, { id: ID } as OpenVault]]);
  let leader = true;
  const searchSources = () => ({}) as never;
  const ports: SignalsMarketPorts = { isCurrent: () => leader, searchSources };
  const bind = localSignalsBinder({
    stores: { vaults } as unknown as HostStores,
    queue: {} as NotificationQueue,
    prices: null,
    signals: { bind: (vault) => (vault === ID ? ports : null) },
  });
  return { vaults, bind, searchSources, loseLease: () => (leader = false) };
}

describe("local Signals capability", () => {
  it("stays current and the same when the market lease moves; only the online ports go", () => {
    const s = setup();
    const cap = s.bind(ID);
    expect(cap?.isCurrent()).toBe(true);
    expect(cap?.searchSources).toBe(s.searchSources);
    s.loseLease();
    expect(cap?.isCurrent()).toBe(true);
    expect(s.bind(ID)).toBe(cap);
    expect(cap?.searchSources).toBeUndefined();
    expect(cap?.watchMarket).toBeUndefined();
  });

  it("ends with its vault: a closed vault binds nothing, a reopened one gets a new capability", () => {
    const s = setup();
    const cap = s.bind(ID);
    s.vaults.delete(ID);
    expect(cap?.isCurrent()).toBe(false);
    expect(s.bind(ID)).toBeNull();
    s.vaults.set(ID, { id: ID } as OpenVault);
    const reopened = s.bind(ID);
    expect(reopened).not.toBe(cap);
    expect(reopened?.isCurrent()).toBe(true);
  });
});
