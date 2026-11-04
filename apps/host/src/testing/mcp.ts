type Json = Record<string, unknown>;
export function mcpClient(
  send: (line: string) => void,
  subscribe: (callback: (line: string) => void) => void,
) {
  let id = 0;
  const pending = new Map<number, (value: Json) => void>();
  subscribe((line) => {
    const msg = JSON.parse(line) as Json;
    if (typeof msg.id === "number") {
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    }
  });
  return {
    call(method: string, params: Json = {}): Promise<Json> {
      const rid = ++id;
      return new Promise((resolve) => {
        pending.set(rid, resolve);
        send(JSON.stringify({ jsonrpc: "2.0", id: rid, method, params }));
      });
    },
    notify(method: string) {
      send(JSON.stringify({ jsonrpc: "2.0", method }));
    },
  };
}
export async function initializeMcp(client: ReturnType<typeof mcpClient>) {
  await client.call("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "synthetic-test", version: "1" },
  });
  client.notify("notifications/initialized");
}
