// R-03: the Vite dev proxy adds the API token only to same-origin requests.
import assert from "node:assert/strict";
import { test } from "node:test";
import { proxyAllowed } from "../devProxyGuard.ts";

const HOST = "localhost:5173";

test("same-origin requests from the dev page are allowed", () => {
  assert.equal(proxyAllowed({ host: HOST, origin: "http://localhost:5173", "sec-fetch-site": "same-origin" }), true);
  assert.equal(proxyAllowed({ host: "127.0.0.1:5173", origin: "http://127.0.0.1:5173" }), true);
  assert.equal(proxyAllowed({ host: HOST, referer: "http://localhost:5173/#/jan/overview" }), true);
  assert.equal(proxyAllowed({ host: HOST, "sec-fetch-site": "same-origin" }), true);
  // the user opening /api/... in the address bar, curl, scripts: no browser cross-site context
  assert.equal(proxyAllowed({ host: HOST, "sec-fetch-site": "none" }), true);
  assert.equal(proxyAllowed({ host: HOST }), true);
});

test("cross-site requests are refused", () => {
  assert.equal(proxyAllowed({ host: HOST, origin: "https://evil.example" }), false);
  assert.equal(proxyAllowed({ host: HOST, origin: "null" }), false);
  assert.equal(proxyAllowed({ host: HOST, "sec-fetch-site": "cross-site" }), false);
  assert.equal(proxyAllowed({ host: HOST, "sec-fetch-site": "same-site" }), false);
  assert.equal(proxyAllowed({ host: HOST, referer: "https://evil.example/page" }), false);
  // another local port is another origin (some other dev server on this machine)
  assert.equal(proxyAllowed({ host: HOST, origin: "http://localhost:3000" }), false);
  // a matching Origin does not excuse a cross-site fetch-metadata header
  assert.equal(proxyAllowed({ host: HOST, origin: "http://localhost:5173", "sec-fetch-site": "cross-site" }), false);
});

test("only loopback dev hosts count as the dev origin (DNS rebinding)", () => {
  assert.equal(proxyAllowed({ host: "evil.example:5173", origin: "http://evil.example:5173" }), false);
  assert.equal(proxyAllowed({ origin: "http://localhost:5173" }), false); // no Host header
});
