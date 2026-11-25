// The port client when the host goes away while the window is open (killed, crashed, replaced): the
// relay stand-in is cut and restored like Electron main does (testing/host.ts). Snapshots stay
// (stale), waiting commands are neither lost nor applied twice, live queries come back. Synthetic data.
import { createProfile, renameProfile } from "@cashu/store";
import { currentVault, setCurrentVault } from "@cashu/store/device";
import type { Query, QueryArgs } from "@cashu/store/query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { type ReactNode, Suspense } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProfileProvider } from "../react/ProfileProvider.js";
import { StoreProvider } from "../react/StoreProvider.js";
import { useConnection } from "../react/useConnection.js";
import { useQuery } from "../react/useQuery.js";
import { Fallback, profileName } from "../testing/fixtures.js";
import { TestHost, testRelay } from "../testing/host.js";
import { memoryStores, VAULT_A } from "../testing/memory.js";
import { type ConnectionStatus, isStale } from "./connection.js";
import { createPortClient } from "./port.js";
import type { StoreClient, Target } from "./types.js";

const QUERIES: Query<QueryArgs, unknown>[] = [currentVault, profileName];
const COMMANDS = [createProfile, renameProfile, setCurrentVault];
const VAULT: Target = { kind: "vault", vault: VAULT_A };

const closers: (() => void)[] = [];
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  for (const close of closers.splice(0)) close();
});

async function setup(options: { recoveredMs?: number } = {}) {
  const stores = memoryStores();
  const host = new TestHost({ stores, queries: QUERIES, commands: COMMANDS });
  const relay = testRelay(host);
  const client = await createPortClient(relay.client, { lingerMs: 0, ...options });
  const statuses: ConnectionStatus[] = [];
  client.connection.subscribe(() => statuses.push(client.connection.getSnapshot()));
  closers.push(() => {
    client.dispose();
    relay.close();
    stores.close();
  });
  return { stores, host, relay, client, statuses };
}

/** The live value of the profile's name through the client (the entry stays subscribed). */
function watchName(client: StoreClient) {
  const entry = client.entry(VAULT, profileName, undefined);
  const seen: (string | null)[] = [];
  const off = entry.subscribe(() => {
    const s = entry.getSnapshot();
    if (s.status === "value") seen.push(s.value);
  });
  closers.push(off);
  return {
    seen,
    current: () => {
      const s = entry.getSnapshot();
      return s.status === "value" ? s.value : undefined;
    },
  };
}

const runsOf = (sent: unknown[]) =>
  sent.filter((m): m is { t: "run"; key: string } => (m as { t: string }).t === "run");

describe("port client across a host restart", () => {
  it("keeps snapshots while the host is gone and refreshes them when it is back", async () => {
    const { client, relay, stores, statuses } = await setup({ recoveredMs: 50 });
    const name = watchName(client);
    await waitFor(() => expect(name.current()).toBe("Ala"));

    relay.cut();
    await waitFor(() => expect(client.connection.getSnapshot()).toBe("connecting"));
    relay.link("starting");
    await waitFor(() => expect(client.connection.getSnapshot()).toBe("starting"));
    expect(isStale(client.connection.getSnapshot())).toBe(true);
    // The snapshot is still there (stale), not reset to pending.
    expect(name.current()).toBe("Ala");

    // Another process changed the store while this window was cut off.
    const other = testRelay(new TestHost({ stores, queries: QUERIES, commands: COMMANDS }));
    const renamer = await createPortClient(other.client);
    expect((await renamer.run(VAULT, renameProfile, { name: "Ola" })).kind).toBe("completed");
    renamer.dispose();
    other.close();
    expect(name.current()).toBe("Ala");

    relay.restore();
    await waitFor(() => expect(name.current()).toBe("Ola"));
    await waitFor(() => expect(client.connection.getSnapshot()).toBe("online"));
    expect(statuses).toEqual(["connecting", "starting", "recovered", "online"]);
  });

  it("does not queue a command made while the host is gone", async () => {
    const { client, relay, host } = await setup();
    const name = watchName(client);
    await waitFor(() => expect(name.current()).toBe("Ala"));
    relay.cut();
    await waitFor(() => expect(client.connection.getSnapshot()).toBe("connecting"));

    const result = client.run(VAULT, renameProfile, { name: "Ela" });
    // Nothing went out while the link was down.
    expect(runsOf(relay.sent)).toHaveLength(0);
    expect(await result).toEqual({ kind: "not_started", reason: "disconnected" });
    relay.restore();
    expect(host.applied).toBe(0);
    expect(runsOf(relay.sent)).toHaveLength(0);
    expect(name.current()).toBe("Ala");
  });

  it("settles a lost reply unknown and reconciles with a read-only lookup", async () => {
    const { client, relay, host } = await setup();
    host.dieAfterNextCommit = () => relay.cut();
    const result = client.run(VAULT, renameProfile, { name: "Ela" });
    await waitFor(() => expect(client.connection.getSnapshot()).toBe("connecting"));
    expect(host.applied).toBe(1);

    const uncertain = await result;
    expect(uncertain.kind).toBe("outcome_unknown");
    if (uncertain.kind !== "outcome_unknown") throw new Error("missing attempt");
    relay.restore();
    await waitFor(() => expect(client.connection.getSnapshot()).not.toBe("connecting"));
    expect(await client.reconcile(uncertain.attempt)).toEqual({ kind: "completed", value: null });
    expect(host.applied).toBe(1);
    const sent = runsOf(relay.sent);
    expect(sent).toHaveLength(1);
    expect(relay.sent.filter((m) => (m as { t: string }).t === "lookup")).toHaveLength(1);
    // A refusal is recovered without resending its mutation.
    host.dieAfterNextCommit = () => relay.cut();
    const refused = client.run(VAULT, createProfile, { slug: "x", name: "X" });
    await waitFor(() => expect(client.connection.getSnapshot()).toBe("connecting"));
    const refusedUnknown = await refused;
    if (refusedUnknown.kind !== "outcome_unknown") throw new Error("missing refused attempt");
    relay.restore();
    await waitFor(() => expect(client.connection.getSnapshot()).not.toBe("connecting"));
    expect(await client.reconcile(refusedUnknown.attempt)).toEqual({
      kind: "refused",
      reason: "exists",
    });
    expect(host.applied).toBe(2);
  });

  it("does not resubscribe a query nobody reads any more", async () => {
    const { client, relay } = await setup();
    const entry = client.entry(VAULT, profileName, undefined);
    const off = entry.subscribe(() => {});
    await waitFor(() => expect(entry.getSnapshot().status).toBe("value"));
    relay.cut();
    off();
    await waitFor(() => expect(client.size).toBe(0));
    const before = relay.sent.length;
    relay.restore();
    await waitFor(() => expect(client.connection.getSnapshot()).not.toBe("connecting"));
    expect(relay.sent.slice(before).filter((m) => (m as { t: string }).t === "sub")).toEqual([]);
  });
});

function Status() {
  const status = useConnection();
  return <p data-testid="status">{`${status}${isStale(status) ? " (stale)" : ""}`}</p>;
}

function Name() {
  return <p data-testid="name">{useQuery(profileName)}</p>;
}

describe("useConnection", () => {
  it("shows the link while the rendered snapshot stays", async () => {
    const { client, relay } = await setup({ recoveredMs: 20 });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <StoreProvider client={client}>
        <Suspense fallback={<Fallback />}>
          <ProfileProvider fallback={<p>no profile</p>}>{children}</ProfileProvider>
        </Suspense>
      </StoreProvider>
    );
    await act(async () => {
      render(
        <>
          <Status />
          <Name />
        </>,
        { wrapper },
      );
    });
    expect((await screen.findByTestId("name")).textContent).toBe("Ala");
    expect(screen.getByTestId("status").textContent).toBe("online");
    act(() => relay.cut("starting"));
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("starting (stale)"));
    expect(screen.getByTestId("name").textContent).toBe("Ala");
    act(() => relay.restore());
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("recovered"));
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("online"));
  });
});
