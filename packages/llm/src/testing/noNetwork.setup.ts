/** No LLM test may use the real network. All transport replies come from injected fakes. */
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

const blocked = (what: string): never => {
  throw new Error(`network access in an LLM test: pass an injected fake fetch [${what}]`);
};

const globals = globalThis as Record<string, unknown>;
globals.fetch = () => blocked("fetch");
globals.WebSocket = class {
  constructor() {
    blocked("WebSocket");
  }
};
globals.XMLHttpRequest = class {
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
