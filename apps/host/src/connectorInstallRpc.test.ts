import type { HostSession } from "@cashu/node-host";
import { expect, it } from "vitest";
import { connectorInstallRpc } from "./connectorInstallRpc.js";
import type { ConnectorCatalog } from "./connectors/catalog.js";

it("consumes one install token on its exact UI session", () => {
  const sent: unknown[] = [];
  let close: (() => void) | undefined;
  const session = {
    role: "ui",
    send: (frame: unknown) => {
      sent.push(frame);
    },
    onClose: (callback: () => void) => {
      close = callback;
    },
  } as unknown as HostSession;
  const sources: string[] = [];
  const catalog = {
    installPending(source: string) {
      sources.push(source);
      return { manifest: { id: "synthetic", name: "Synthetic" }, contentSha256: "a".repeat(64) };
    },
  } as ConnectorCatalog;
  const request = connectorInstallRpc(session, () => catalog);
  request({ t: "req", id: 1, method: "native.connectors.prepareInstall", params: {} });
  const token = (sent[0] as { outcome: { result: { token: string } } }).outcome.result.token;
  request({
    t: "req",
    id: 2,
    method: "native.connectors.commitInstall",
    params: { token, source: "/synthetic/connector" },
  });
  request({
    t: "req",
    id: 3,
    method: "native.connectors.commitInstall",
    params: { token, source: "/synthetic/other" },
  });
  expect(sources).toEqual(["/synthetic/connector"]);
  expect((sent[1] as { outcome: { ok: boolean } }).outcome.ok).toBe(true);
  expect((sent[2] as { outcome: { ok: boolean } }).outcome.ok).toBe(false);
  close?.();
});
