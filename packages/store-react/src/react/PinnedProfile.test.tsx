// A pinned subtree reads and writes the vault it was opened with while the current profile switches
// under it, and renders its fallback once that vault is not open any more. Synthetic data.
import { setCurrentVault } from "@cashu/store/device";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createSyncClient } from "../local/sync.js";
import { profileName } from "../testing/fixtures.js";
import { memoryStores, VAULT_A, VAULT_B } from "../testing/memory.js";
import { PinnedProfile } from "./PinnedProfile.js";
import { ProfileProvider } from "./ProfileProvider.js";
import { StoreProvider } from "./StoreProvider.js";
import { useCommand } from "./useCommand.js";
import { useProfile } from "./useProfile.js";
import { useQuery } from "./useQuery.js";

const closers: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const close of closers.splice(0)) close();
});

function SwitchToB() {
  const { run } = useCommand(setCurrentVault);
  return (
    <button type="button" onClick={() => void run({ vault: VAULT_B })}>
      B
    </button>
  );
}

function Shown({ label }: { label: string }) {
  return <p>{`${label} ${useProfile().slice(-1)}: ${useQuery(profileName)}`}</p>;
}

describe("PinnedProfile", () => {
  it("keeps reading the pinned vault after the current profile switched", async () => {
    const stores = memoryStores({ current: VAULT_A });
    const client = createSyncClient(stores, { lingerMs: 0 });
    closers.push(() => {
      client.dispose();
      stores.close();
    });
    render(
      <StoreProvider client={client}>
        <SwitchToB />
        <ProfileProvider>
          <Shown label="current" />
          <PinnedProfile vault={VAULT_A}>
            <Shown label="sheet" />
          </PinnedProfile>
        </ProfileProvider>
      </StoreProvider>,
    );
    expect(screen.getByText("current 1: Ala")).toBeDefined();
    expect(screen.getByText("sheet 1: Ala")).toBeDefined();
    await act(async () => screen.getByRole("button", { name: "B" }).click());
    expect(screen.getByText("current 2: Ola")).toBeDefined();
    expect(screen.getByText("sheet 1: Ala")).toBeDefined();
  });

  it("renders the fallback for a vault that is not open on this device", () => {
    const stores = memoryStores({ current: VAULT_A });
    const client = createSyncClient(stores, { lingerMs: 0 });
    closers.push(() => {
      client.dispose();
      stores.close();
    });
    render(
      <StoreProvider client={client}>
        <PinnedProfile vault="0123456789abcdef0123456789abcdef" fallback={<p>gone</p>}>
          <Shown label="sheet" />
        </PinnedProfile>
      </StoreProvider>,
    );
    expect(screen.getByText("gone")).toBeDefined();
  });
});
