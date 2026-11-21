/**
 * Vitest setup of `@cashu/market` (wired in `vitest.config.ts`): no test may reach the network. The
 * global `fetch`, `WebSocket` and `XMLHttpRequest`, every socket connect (`net`, `tls`, so `http`,
 * `https` and undici too) and DNS lookups throw before any byte leaves the machine. Sources get a fake
 * `fetch` from `testing/support.ts`; `noNetwork.test.ts` proves the guard holds.
 */

import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

export const NETWORK_BLOCKED = "network access in a test: pass a fake fetch (testing/support.ts)";

function blocked(what: string): never {
  throw new Error(`${NETWORK_BLOCKED} [${what}]`);
}

const g = globalThis as Record<string, unknown>;
g.fetch = () => blocked("fetch");
g.WebSocket = class {
  constructor() {
    blocked("WebSocket");
  }
};
g.XMLHttpRequest = class {
  constructor() {
    blocked("XMLHttpRequest");
  }
};

net.Socket.prototype.connect = function connect() {
  return blocked("net.Socket.connect");
};
net.connect = () => blocked("net.connect");
net.createConnection = () => blocked("net.createConnection");
tls.connect = () => blocked("tls.connect");
http.request = () => blocked("http.request");
http.get = () => blocked("http.get");
https.request = () => blocked("https.request");
https.get = () => blocked("https.get");
dns.lookup = (() => blocked("dns.lookup")) as unknown as typeof dns.lookup;
dns.promises.lookup = () => blocked("dns.promises.lookup");
