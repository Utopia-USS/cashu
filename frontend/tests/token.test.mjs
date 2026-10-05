// PK1: the API token never comes with the page. A `#token=` fragment moves to sessionStorage and
// leaves the address bar; a reload in the same tab reads sessionStorage; the desktop window asks
// the pywebview bridge, waiting for it with a timeout. Run with `npm test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  captureFragmentToken, desktopToken, fragmentToken, storedToken, TOKEN_STORAGE_KEY,
} from "../src/core/token.ts";

function memoryStorage() {
  const data = new Map();
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { data.set(k, String(v)); },
    removeItem: (k) => { data.delete(k); },
  };
}

function fakeHistory() {
  const calls = [];
  return { calls, state: { idx: 3 }, replaceState(data, unused, url) { calls.push({ data, unused, url }); } };
}

test("the fragment token is parsed, other fragment parts are ignored", () => {
  assert.equal(fragmentToken("#token=abc-DEF_123"), "abc-DEF_123");
  assert.equal(fragmentToken("#x=1&token=abc"), "abc");
  assert.equal(fragmentToken("#token=a%2Bb"), "a+b");
  assert.equal(fragmentToken("#/jan/overview"), null);
  assert.equal(fragmentToken("#token="), null);
  assert.equal(fragmentToken(""), null);
});

test("fragment -> sessionStorage -> stripped from the address bar", () => {
  const storage = memoryStorage();
  const history = fakeHistory();
  const loc = { hash: "#token=secret-1", pathname: "/", search: "" };
  assert.equal(captureFragmentToken(loc, history, storage), "secret-1");
  assert.equal(storage.getItem(TOKEN_STORAGE_KEY), "secret-1");
  assert.deepEqual(history.calls, [{ data: { idx: 3 }, unused: "", url: "/" }]); // no fragment left
});

test("a reload in the same tab keeps working from sessionStorage", () => {
  const storage = memoryStorage();
  captureFragmentToken({ hash: "#token=secret-2", pathname: "/", search: "?a=1" }, fakeHistory(), storage);
  // the reloaded page has no fragment any more
  const history = fakeHistory();
  assert.equal(captureFragmentToken({ hash: "", pathname: "/", search: "?a=1" }, history, storage), null);
  assert.equal(history.calls.length, 0); // nothing to strip, the route stays
  assert.equal(storedToken(storage), "secret-2");
});

test("a page without a fragment keeps its hash route", () => {
  const history = fakeHistory();
  assert.equal(captureFragmentToken({ hash: "#/jan/budget", pathname: "/", search: "" }, history, memoryStorage()), null);
  assert.equal(history.calls.length, 0);
});

test("unavailable storage: the token still comes back, nothing throws", () => {
  const broken = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); }, removeItem() {} };
  const history = fakeHistory();
  assert.equal(captureFragmentToken({ hash: "#token=t", pathname: "/", search: "" }, history, broken), "t");
  assert.equal(history.calls.length, 1);
  assert.equal(storedToken(broken), null);
  assert.equal(storedToken(null), null);
});

function fakeWindow() {
  const listeners = new Map();
  let timers = [];
  return {
    listeners,
    addEventListener(type, cb) { listeners.set(type, cb); },
    removeEventListener(type, cb) { if (listeners.get(type) === cb) listeners.delete(type); },
    setTimeout(cb, ms) { const t = { cb, ms }; timers.push(t); return t; },
    clearTimeout(t) { timers = timers.filter((x) => x !== t); },
    fireTimers() { const due = timers; timers = []; due.forEach((t) => t.cb()); },
  };
}

test("desktop: the bridge already injected answers at once", async () => {
  const win = fakeWindow();
  win.pywebview = { api: { token: async () => "desk-1" } };
  assert.equal(await desktopToken(win), "desk-1");
});

test("desktop: waits for pywebviewready, then asks the bridge", async () => {
  const win = fakeWindow();
  const result = desktopToken(win, 5000);
  assert.ok(win.listeners.has("pywebviewready"));
  win.pywebview = { api: { token: async () => "desk-2" } };
  win.listeners.get("pywebviewready")();
  assert.equal(await result, "desk-2");
  assert.equal(win.listeners.size, 0);
});

test("no bridge within the timeout (a browser without a token): null", async () => {
  const win = fakeWindow();
  const result = desktopToken(win, 5000);
  win.fireTimers();
  assert.equal(await result, null);
  assert.equal(win.listeners.size, 0);
});

test("a refusing or failing bridge gives null", async () => {
  const refusing = fakeWindow();
  refusing.pywebview = { api: { token: async () => null } };
  assert.equal(await desktopToken(refusing), null);
  const failing = fakeWindow();
  failing.pywebview = { api: { token: async () => { throw new Error("x"); } } };
  assert.equal(await desktopToken(failing), null);
});
