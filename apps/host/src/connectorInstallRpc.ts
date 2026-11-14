/** One-use host install capability. Electron main supplies the path from its native folder picker. */
import { randomBytes } from "node:crypto";
import type { ClientFrame } from "@cashu/host-protocol";
import type { HostSession } from "@cashu/node-host";
import { z } from "zod";
import type { ConnectorCatalog } from "./connectors/catalog.js";

const commit = z.strictObject({
  token: z.string().length(64),
  source: z.string().min(1).max(4096),
});

export function connectorInstallRpc(
  session: HostSession,
  catalog: () => ConnectorCatalog | undefined,
) {
  let pending: { token: string; expires: number } | null = null;
  let closed = false;
  session.onClose(() => {
    closed = true;
    pending = null;
  });
  return (frame: Extract<ClientFrame, { t: "req" }>) => {
    if (session.role !== "ui" || closed || catalog() === undefined) {
      session.send({
        t: "res",
        id: frame.id,
        outcome: {
          ok: false,
          error: { code: "unavailable", message: "connector install unavailable" },
        },
      });
      return;
    }
    if (frame.method === "native.connectors.prepareInstall") {
      const token = randomBytes(32).toString("hex");
      pending = { token, expires: Date.now() + 15 * 60_000 };
      session.send({ t: "res", id: frame.id, outcome: { ok: true, result: { token } } });
      return;
    }
    if (frame.method !== "native.connectors.commitInstall") {
      session.send({
        t: "res",
        id: frame.id,
        outcome: { ok: false, error: { code: "unknown-method", message: "method unavailable" } },
      });
      return;
    }
    const value = commit.safeParse(frame.params);
    const capability = pending;
    pending = null;
    if (
      !value.success ||
      !capability ||
      capability.expires < Date.now() ||
      capability.token !== value.data.token
    ) {
      session.send({
        t: "res",
        id: frame.id,
        outcome: {
          ok: false,
          error: { code: "invalid-input", message: "install capability expired" },
        },
      });
      return;
    }
    try {
      const loaded = catalog()?.installPending(value.data.source);
      if (!loaded || closed) throw new Error("stale_install");
      session.send({
        t: "res",
        id: frame.id,
        outcome: {
          ok: true,
          result: {
            id: loaded.manifest.id,
            name: loaded.manifest.name,
            digest: loaded.contentSha256,
          },
        },
      });
    } catch {
      session.send({
        t: "res",
        id: frame.id,
        outcome: { ok: false, error: { code: "failed", message: "connector installation failed" } },
      });
    }
  };
}
