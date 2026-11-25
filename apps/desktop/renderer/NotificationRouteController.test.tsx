// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const selectedListeners = new Set<() => void>();
  const state = {
    selected: "d".repeat(32),
    vaults: ["b".repeat(32)],
    online: true,
    profile: { slug: "target", name: "Synthetic" },
    profileReady: Promise.resolve() as Promise<void>,
    run: vi.fn(async (_target: unknown, _command: unknown, input: { vault: string }) => {
      state.selected = input.vault;
      for (const listener of selectedListeners) listener();
      return { kind: "completed" as const, value: null };
    }),
    pending: null as null | (() => void),
    target: null as null | ((value: unknown) => void),
    visits: [] as string[],
    router: {
      state: {
        location: { href: "/start", pathname: "/start", search: {} as Record<string, unknown> },
      },
      subscribe: (_event: string, listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      navigate: vi.fn(
        async (options: {
          to: string;
          params?: { slug: string };
          search?: Record<string, unknown>;
        }) => {
          const path = options.to.replace("$slug", options.params?.slug ?? "");
          state.router.state.location = {
            href: `${path}?vault=${options.search?.vault ?? ""}`,
            pathname: path,
            search: options.search ?? {},
          };
          state.visits.push(path);
          for (const listener of listeners) listener();
        },
      ),
    },
    listeners,
    selectedListeners,
  };
  return state;
});

vi.mock("@cashu/store-react", () => {
  const client = {
    get vaults() {
      return harness.vaults;
    },
    connection: { getSnapshot: () => (harness.online ? "online" : "unavailable") },
    entry: (target: { kind: string }) =>
      target.kind === "device"
        ? {
            getSnapshot: () => ({ status: "value", value: harness.selected }),
            subscribe: (listener: () => void) => {
              harness.selectedListeners.add(listener);
              return () => harness.selectedListeners.delete(listener);
            },
          }
        : {
            ready: harness.profileReady,
            getSnapshot: () => ({ status: "value", value: harness.profile }),
          },
    run: harness.run,
  };
  return {
    isStale: (status: string) => status !== "online",
    useQuery: () => harness.selected,
    useStoreClient: () => client,
  };
});
vi.mock("./notificationBridge.js", () => ({
  onNotificationPending: (handler: () => void) => {
    harness.pending = handler;
    return () => {
      harness.pending = null;
    };
  },
  onNotificationTarget: (handler: (value: unknown) => void) => {
    harness.target = handler;
    return () => {
      harness.target = null;
    };
  },
}));
vi.mock("./routes.js", () => ({ router: harness.router }));

import { NotificationRouteController } from "./NotificationRouteController.js";

beforeEach(() => {
  harness.selected = "d".repeat(32);
  harness.vaults = ["b".repeat(32)];
  harness.online = true;
  harness.profile = { slug: "target", name: "Synthetic" };
  harness.profileReady = Promise.resolve();
  harness.run.mockClear();
  harness.run.mockImplementation(async (_target, _command, input) => {
    harness.selected = input.vault;
    for (const listener of harness.selectedListeners) listener();
    return { kind: "completed", value: null };
  });
  harness.router.navigate.mockClear();
  harness.visits.length = 0;
  harness.router.state.location = { href: "/start", pathname: "/start", search: {} };
  harness.listeners.clear();
  harness.selectedListeners.clear();
});

async function mounted() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(<NotificationRouteController>Ready</NotificationRouteController>),
  );
  return async () => {
    await act(async () => root.unmount());
    container.remove();
  };
}

function click(vaultId = "b".repeat(32)) {
  harness.pending?.();
  harness.target?.({ kind: "target", vaultId, target: "generic" });
}

it("selects an exact admitted target once when the previous vault cannot mount routes", async () => {
  const unmount = await mounted();
  try {
    await act(async () => click());
    expect(harness.run).toHaveBeenCalledTimes(1);
    expect(harness.run.mock.calls[0]?.[2]).toEqual({ vault: "b".repeat(32) });
    expect(harness.visits).toEqual(["/target/overview"]);
  } finally {
    await unmount();
  }
});

it("takes a missing target to neutral home, then accepts it after a new online inventory", async () => {
  harness.vaults = [];
  const unmount = await mounted();
  try {
    await act(async () => click());
    expect(harness.run).not.toHaveBeenCalled();
    expect(harness.visits).toEqual(["/"]);
    harness.vaults = ["b".repeat(32)];
    await act(async () => click());
    expect(harness.run).toHaveBeenCalledTimes(1);
    expect(harness.visits.at(-1)).toBe("/target/overview");
  } finally {
    await unmount();
  }
});

it("drops a delayed cross-vault reply after manual third-vault navigation", async () => {
  let resolveProfile: (() => void) | undefined;
  harness.profileReady = new Promise<void>((resolve) => {
    resolveProfile = resolve;
  });
  const unmount = await mounted();
  try {
    await act(async () => click());
    await act(async () => {
      await harness.router.navigate({ to: "/third/overview", search: { vault: "c".repeat(32) } });
      harness.selected = "c".repeat(32);
      resolveProfile?.();
    });
    expect(harness.run).not.toHaveBeenCalled();
    expect(harness.visits).toEqual(["/third/overview"]);
  } finally {
    await unmount();
  }
});

it("keeps a third-vault choice made during fallback selection even when the click command completes", async () => {
  let completeSwitch: ((value: { kind: "completed"; value: null }) => void) | undefined;
  harness.run.mockImplementation(
    () =>
      new Promise((resolve) => {
        completeSwitch = resolve;
      }),
  );
  const unmount = await mounted();
  try {
    await act(async () => click());
    expect(harness.run).toHaveBeenCalledTimes(1);
    await act(async () => {
      harness.selected = "c".repeat(32);
      for (const listener of harness.selectedListeners) listener();
      completeSwitch?.({ kind: "completed", value: null });
    });
    expect(harness.visits).toEqual([]);
  } finally {
    await unmount();
  }
});

it("does not overwrite manual navigation when a delayed fallback command is unknown", async () => {
  let fail: ((error: Error) => void) | undefined;
  harness.run.mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
  );
  const unmount = await mounted();
  try {
    await act(async () => click());
    await act(async () => {
      await harness.router.navigate({ to: "/third/overview", search: { vault: "c".repeat(32) } });
      fail?.(new Error("result_unknown"));
    });
    expect(harness.visits).toEqual(["/third/overview"]);
  } finally {
    await unmount();
  }
});

it("does not navigate after the controller unmounts during target resolution", async () => {
  let resolveProfile: (() => void) | undefined;
  harness.profileReady = new Promise<void>((resolve) => {
    resolveProfile = resolve;
  });
  const unmount = await mounted();
  await act(async () => click());
  await unmount();
  await act(async () => resolveProfile?.());
  expect(harness.run).not.toHaveBeenCalled();
  expect(harness.visits).toEqual([]);
});
