// The current profile is device-local state: ProfileProvider reads it with useQuery from the device
// store, and switching it (a device command) switches the store vault queries read. Synthetic data.
import { setCurrentVault } from "@cashu/store/device";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { createSyncClient } from "../local/sync.js";
import { ErrorBoundary, profileName } from "../testing/fixtures.js";
import { memoryStores, VAULT_A, VAULT_B } from "../testing/memory.js";
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

function Picker() {
  const { run } = useCommand(setCurrentVault);
  return (
    <>
      <button type="button" onClick={() => void run({ vault: VAULT_A })}>
        A
      </button>
      <button type="button" onClick={() => void run({ vault: VAULT_B })}>
        B
      </button>
      <button type="button" onClick={() => void run({ vault: "0123456789abcdef0123456789abcdef" })}>
        gone
      </button>
    </>
  );
}

function Profile() {
  return <p>{`${useProfile().slice(-1)}: ${useQuery(profileName)}`}</p>;
}

function setup(current: string | null) {
  const stores = memoryStores({ current });
  const client = createSyncClient(stores, { lingerMs: 0 });
  closers.push(() => {
    client.dispose();
    stores.close();
  });
  const app = (
    <StoreProvider client={client}>
      <Picker />
      <ProfileProvider fallback={<p>no profile</p>}>
        <Profile />
      </ProfileProvider>
    </StoreProvider>
  );
  return { app, client };
}

describe("ProfileProvider", () => {
  it("renders the fallback until a profile is current, then switches stores", async () => {
    const { app } = setup(null);
    render(app);
    expect(screen.getByText("no profile")).toBeDefined();
    await act(async () => screen.getByRole("button", { name: "B" }).click());
    expect(screen.getByText("2: Ola")).toBeDefined();
    await act(async () => screen.getByRole("button", { name: "A" }).click());
    expect(screen.getByText("1: Ala")).toBeDefined();
    // A vault that is not open on this device is no current profile.
    await act(async () => screen.getByRole("button", { name: "gone" }).click());
    expect(screen.getByText("no profile")).toBeDefined();
  });

  it("refuses vault reads outside a profile", () => {
    const { client } = setup(null);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <StoreProvider client={client}>
        <ErrorBoundary>{children}</ErrorBoundary>
      </StoreProvider>
    );
    render(<Profile />, { wrapper, onCaughtError: () => {} });
    expect(screen.getByRole("alert").textContent).toMatch(/ProfileProvider/);
  });
});
