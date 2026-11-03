import { describe, expect, it } from "vitest";
import type { NativeVaultSession } from "../nativeVault.js";
import type { HostStores } from "../stores.js";
import { createDeviceService } from "./service.js";

const vault = "a".repeat(32);
const target = "b".repeat(32);

function fixture() {
  let wall = 1_000;
  let current = true;
  let commits = 0;
  let wordsSeen = 0;
  const session = {
    epoch: {},
    isCurrent: () => current,
    sync: async () => ({}),
    devicePreview: async () => ({
      kind: "prepared",
      fingerprint: "fixed",
      targets: [{ device: target, cut: { seg: 1, offset: 0 }, head: "local_start" }],
      affected: [],
      localStartConfirmationRequired: true,
    }),
    deviceCommit: async (_draft: unknown, input: { recoveryPhrase: string }) => {
      commits++;
      wordsSeen += input.recoveryPhrase.length;
      return { kind: "completed", operationId: "0".repeat(26) };
    },
    deviceList: async () => ({
      kind: "ready",
      vault,
      ownDevice: "c".repeat(32),
      operations: [],
      evidence: {
        historyPending: false,
        overflow: false,
        authorityUncertain: false,
        writeAdmission: "ready",
      },
      devices: [],
    }),
    deviceInspect: async (operationId: string) => ({ kind: "not_found", operationId }),
  } as unknown as NativeVaultSession;
  const stores = { vaults: new Map([[vault, { native: session }]]) } as unknown as HostStores;
  const service = createDeviceService(stores, () => wall);
  return {
    service,
    session,
    setWall: (next: number) => {
      wall = next;
    },
    invalidate: () => {
      current = false;
    },
    get commits() {
      return commits;
    },
    get wordsSeen() {
      return wordsSeen;
    },
  };
}

describe("host device token", () => {
  it("binds a one-use preview to the vault and keeps phrase out of preview and status", async () => {
    const f = fixture();
    const preview = await f.service.preview({ vault, targets: [target], recertify: [] });
    expect(preview.kind).toBe("prepared");
    if (preview.kind !== "prepared") return;
    const phrase = "synthetic ".repeat(24).trim();
    expect(JSON.stringify(preview).includes(phrase)).toBe(false);
    expect(
      (
        await f.service.commit({
          vault: "d".repeat(32),
          token: preview.token,
          warningAcknowledgement: "revoke_risk_acknowledged",
          recoveryPhrase: phrase,
        })
      ).kind,
    ).toBe("refused");
    expect(f.commits).toBe(0);
    const second = await f.service.preview({ vault, targets: [target], recertify: [] });
    if (second.kind !== "prepared") throw new Error("expected preview");
    const result = await f.service.commit({
      vault,
      token: second.token,
      warningAcknowledgement: "revoke_risk_acknowledged",
      localStartAcknowledgement: "local_target_stream_never_seen",
      recoveryPhrase: phrase,
    });
    expect(result.kind).toBe("completed");
    expect(JSON.stringify(result).includes(phrase)).toBe(false);
    expect(f.commits).toBe(1);
    expect(f.wordsSeen).toBe(phrase.length);
    expect(
      (
        await f.service.commit({
          vault,
          token: second.token,
          warningAcknowledgement: "revoke_risk_acknowledged",
          recoveryPhrase: phrase,
        })
      ).kind,
    ).toBe("refused");
    expect(f.commits).toBe(1);
  });

  it("expires and invalidates tokens on native session loss or host shutdown", async () => {
    const f = fixture();
    const first = await f.service.preview({ vault, targets: [target], recertify: [] });
    if (first.kind !== "prepared") throw new Error("expected preview");
    f.setWall(first.expiresAt + 1);
    expect(
      await f.service.commit({
        vault,
        token: first.token,
        warningAcknowledgement: "revoke_risk_acknowledged",
        recoveryPhrase: "synthetic ".repeat(24),
      }),
    ).toEqual({ kind: "refused", code: "preview_expired" });
    f.setWall(2_000);
    const second = await f.service.preview({ vault, targets: [target], recertify: [] });
    if (second.kind !== "prepared") throw new Error("expected preview");
    f.invalidate();
    expect(
      (
        await f.service.commit({
          vault,
          token: second.token,
          warningAcknowledgement: "revoke_risk_acknowledged",
          recoveryPhrase: "synthetic ".repeat(24),
        })
      ).kind,
    ).toBe("refused");
    expect(f.commits).toBe(0);
    f.service.close();
    expect((await f.service.list({ vault })).kind).toBe("refused");
  });

  it("does not mint a preview after shutdown and bounds outstanding challenges", async () => {
    const f = fixture();
    for (let i = 0; i < 4; i++) {
      expect((await f.service.preview({ vault, targets: [target], recertify: [] })).kind).toBe(
        "prepared",
      );
    }
    expect((await f.service.preview({ vault, targets: [target], recertify: [] })).kind).toBe(
      "refused",
    );
    const late = fixture();
    let finish:
      | ((value: Awaited<ReturnType<NativeVaultSession["devicePreview"]>>) => void)
      | undefined;
    (
      late.session as unknown as { devicePreview: NativeVaultSession["devicePreview"] }
    ).devicePreview = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const pending = late.service.preview({ vault, targets: [target], recertify: [] });
    late.service.close();
    finish?.({
      kind: "prepared",
      fingerprint: "fixed",
      targets: [{ device: target, cut: { seg: 1, offset: 0 }, head: "local_start" }],
      affected: [],
      localStartConfirmationRequired: true,
    });
    expect((await pending).kind).toBe("refused");
    expect(late.service.pending()).toBe(0);
  });
});
