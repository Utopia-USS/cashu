/// <reference types="node" />
// Entry of the store process (Electron utility process, layers.md "Which process runs what"): it
// owns SQLite and the store engine; each renderer gets its own MessagePort, served by `serveStore`.
// The main process forks it, hands it ports and asks it to stop; it never sees store data.
//
// TRANSITIONAL(S55a): started only behind CASHU_DESKTOP_STORE=1 while the window still
// shows the legacy SPA over the Python sidecar; the flag goes when the first TS screen uses the store.
import type { Channel } from "@cashu/store-react/client";
import { serveStore } from "@cashu/store-react/host";
import { type FromStoreProcess, isToStoreProcess, parseStoreProcessArgv } from "../storeControl.js";
import { SERVED_COMMANDS, SERVED_QUERIES } from "./registry.js";
import { openDemoStores } from "./stores.js";

const parent = process.parentPort;
const tell = (message: FromStoreProcess) => parent.postMessage(message);

function portChannel(port: Electron.MessagePortMain): Channel {
  return {
    post: (message) => port.postMessage(message),
    listen(handler) {
      const listener = (event: Electron.MessageEvent) => handler(event.data);
      port.on("message", listener);
      return () => port.off("message", listener);
    },
  };
}

const args = parseStoreProcessArgv(process.argv);
if (args === null || !args.demo) {
  tell({ t: "log", line: "store process: no vault source (start with --store-dir and --demo)" });
  process.exit(2);
}

const stores = openDemoStores(args.storeDir);
const hosts = new Set<() => void>();

parent.on("message", (event) => {
  const message: unknown = event.data;
  if (!isToStoreProcess(message)) {
    tell({ t: "log", line: "store process: ignored an unknown control message" });
    return;
  }
  if (message.t === "connect") {
    const port = event.ports[0];
    if (port === undefined) return;
    const stop = serveStore(portChannel(port), {
      ...stores,
      queries: SERVED_QUERIES,
      commands: SERVED_COMMANDS,
      onError: (error, context) =>
        tell({
          t: "log",
          line: `store process: ${context} failed (${error instanceof Error ? error.name : "error"})`,
        }),
    });
    hosts.add(stop);
    port.on("close", () => {
      stop();
      hosts.delete(stop);
    });
    port.start();
    return;
  }
  for (const stop of hosts) stop();
  hosts.clear();
  stores.close();
  tell({ t: "stopped" });
  process.exit(0);
});

tell({ t: "ready", vaults: stores.vaults.size });
