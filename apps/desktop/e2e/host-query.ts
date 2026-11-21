/// <reference types="node" />
// One value of a vault query, read from the synthetic demo's host through its own UI channel (the
// channel the renderer reads through), so a spec can check what an owner action stored.
import { decodeValue, type StoreToClient } from "@cashu/host-protocol/store";
import { connectHost } from "@cashu/node-host";

export async function readHostQuery<T>(
  dataDir: string,
  vault: string,
  query: string,
  args: unknown = null,
): Promise<T> {
  if (dataDir !== process.env.E2E_NATIVE_DATA_DIR || !process.env.E2E_ROOT)
    throw new Error("synthetic_query_root_required");
  const connection = await connectHost({ dataDir, role: "ui", build: "e2e" });
  try {
    return await new Promise<T>((resolve, reject) => {
      connection.onFrame((frame) => {
        if (frame.t !== "store") return;
        const message = frame.m as StoreToClient;
        if (message.t === "ready") {
          if (!message.vaults.includes(vault)) reject(new Error("synthetic_query_vault_absent"));
          connection.send({ t: "store", m: { t: "uiPolicy", generation: 0, privacy: false } });
          connection.send({
            t: "store",
            m: {
              t: "sub",
              sid: 1,
              generation: 0,
              resume: false,
              target: { kind: "vault", vault },
              query,
              args,
            } as never,
          });
        } else if (message.t === "value" && message.sid === 1)
          resolve(decodeValue(message.value) as T);
        else if (message.t === "error")
          reject(new Error(`synthetic_query_failed:${query}:${message.error.name}`));
      });
      connection.onClose(() => reject(new Error("synthetic_query_connection_closed")));
    });
  } finally {
    connection.close();
  }
}
