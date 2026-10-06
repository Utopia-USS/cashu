// Modal behaviour (src/modal.ts) shared by the drawer and the signals dialog (signals-rail.md 3), run with
// `npm test` against a fake document: focus moves in and returns to the opener, Esc inside an open decision
// form ([data-esc-local]) is left to the form, another modal on top owns the keyboard, Tab cycles inside,
// the browser back button closes, a plain close drops the modal's history entry.
import assert from "node:assert/strict";
import { test } from "node:test";
import { attachModal, handlePopState } from "../src/modal.ts";

// Three 0 ms timers in a row: each queues behind the timers the previous step created (FIFO), so the teardown's
// deferred check, the own back and its popstate have all run, whatever the load.
const tick = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0)); };

function setup() {
  const listeners = [];
  const doc = {
    activeElement: null,
    body: { style: { overflow: "auto" } },
    dialogs: [],
    addEventListener: (type, fn) => { if (type === "keydown") listeners.push(fn); },
    removeEventListener: (type, fn) => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
    querySelectorAll: (sel) => (sel.includes('role="dialog"') ? doc.dialogs : []),
  };
  const node = (name, parent = null, local = false) => {
    const n = {
      name, parent, local, offsetParent: {},
      focus: () => { doc.activeElement = n; },
      closest: (sel) => { for (let x = n; x; x = x.parent) if (sel === "[data-esc-local]" && x.local) return x; return null; },
      contains: (o) => { for (let x = o; x; x = x.parent) if (x === n) return true; return false; },
    };
    return n;
  };
  const page = node("page");
  const opener = node("Wszystkie (10)", page);
  const panel = node("dialog", page);
  const b1 = node("Wszystkie", panel), b2 = node("Zanotuj decyzję", panel), form = node("decide", panel, true), input = node("Powód decyzji", form), b3 = node("dziennik", panel);
  const items = [b1, b2, input, b3];
  panel.querySelectorAll = () => items;
  panel.querySelector = (sel) => (sel === "[data-autofocus]" ? null : items[0]);
  doc.dialogs = [panel];
  const history = {
    state: { route: "home" }, stack: [], backs: 0,
    pushState(s) { this.stack.push(this.state); this.state = s; },
    // like a browser: the traversal and its popstate come a task later
    back() { this.backs++; this.state = this.stack.pop() ?? null; setTimeout(handlePopState, 0); },
    userBack() { this.state = this.stack.pop() ?? null; handlePopState(); },
  };
  const env = { doc, win: { addEventListener: () => {} }, history };
  const key = (k, target, shiftKey = false) => {
    const e = { key: k, shiftKey, target, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
    for (const fn of [...listeners]) fn(e);
    return e;
  };
  opener.focus();
  return { doc, env, history, page, opener, panel, b1, b2, b3, input, key, listeners };
}

test("modal: focus moves to the first control (or the panel), Esc closes, focus returns to the opener, scroll lock released", async () => {
  const t = setup();
  let closed = 0;
  const detach = attachModal(t.panel, { onClose: () => closed++, env: t.env });
  assert.equal(t.doc.activeElement, t.b1);
  assert.equal(t.doc.body.style.overflow, "hidden");
  const e = t.key("Escape", t.b1);
  assert.equal(closed, 1);
  assert.ok(e.prevented && e.stopped);
  detach();
  assert.equal(t.doc.activeElement, t.opener);
  assert.equal(t.doc.body.style.overflow, "auto");
  assert.equal(t.listeners.length, 0);

  const u = setup();
  const off = attachModal(u.panel, { onClose: () => {}, focus: "panel", env: u.env });
  assert.equal(u.doc.activeElement, u.panel); // j / k / Enter reach the page shortcuts
  off();
  assert.equal(u.doc.activeElement, u.opener);
  await tick();
});

test("modal: Esc inside an open decision form is left to the form (collapse first), the next Esc closes", async () => {
  const t = setup();
  let closed = 0;
  const detach = attachModal(t.panel, { onClose: () => closed++, env: t.env });
  t.input.focus();
  const first = t.key("Escape", t.input);
  assert.equal(closed, 0);
  assert.ok(!first.prevented && !first.stopped); // the form's own handler gets it
  // the form collapsed: focus back on the row's first action, Esc again closes the dialog
  t.b2.focus();
  t.key("Escape", t.b2);
  assert.equal(closed, 1);
  detach();
  await tick();
});

test("modal: another modal on top owns Esc and Tab", async () => {
  const t = setup();
  let closed = 0;
  const detach = attachModal(t.panel, { onClose: () => closed++, env: t.env });
  t.doc.dialogs = [t.panel, { name: "drawer" }];
  const e = t.key("Escape", t.b1);
  assert.equal(closed, 0);
  assert.ok(!e.prevented);
  t.doc.dialogs = [t.panel];
  t.key("Escape", t.b1);
  assert.equal(closed, 1);
  detach();
  await tick();
});

test("modal: Tab cycles inside the panel, also from the panel itself or from outside", async () => {
  const t = setup();
  const detach = attachModal(t.panel, { onClose: () => {}, env: t.env });
  t.b3.focus();
  assert.ok(t.key("Tab", t.b3).prevented);
  assert.equal(t.doc.activeElement, t.b1);
  t.key("Tab", t.b1, true);
  assert.equal(t.doc.activeElement, t.b3);
  t.panel.focus();
  t.key("Tab", t.panel, true);
  assert.equal(t.doc.activeElement, t.b3);
  t.opener.focus();
  t.key("Tab", t.opener);
  assert.equal(t.doc.activeElement, t.b1);
  t.b2.focus();
  assert.ok(!t.key("Tab", t.b2).prevented); // inside: the browser moves on
  detach();
  await tick();
});

test("modal: browser back closes without another back; a plain close drops its entry; a close that navigated keeps the history", async () => {
  // back button
  const t = setup();
  let closed = 0;
  const detach = attachModal(t.panel, { onClose: () => closed++, env: t.env });
  assert.equal(t.history.state.cashuDrawer, true);
  assert.equal(t.history.state.route, "home");
  t.history.userBack();
  assert.equal(closed, 1);
  detach();
  await tick();
  assert.equal(t.history.backs, 0);

  // plain close (Esc, ✕, scrim) while another modal stays open: one own back, whose popstate closes nothing
  const v = setup();
  let vClosed = 0;
  const offV = attachModal(v.panel, { onClose: () => vClosed++, env: v.env });
  const u = setup();
  const offU = attachModal(u.panel, { onClose: () => {}, env: u.env });
  offU();
  await tick();
  assert.equal(u.history.backs, 1);
  assert.deepEqual(u.history.state, { route: "home" });
  assert.equal(vClosed, 0);
  v.history.userBack(); // a real back press
  assert.equal(vClosed, 1);
  offV();
  await tick();

  // close that navigated (asset, journal): the shell replaced the modal's entry, nothing to drop
  const w = setup();
  const offW = attachModal(w.panel, { onClose: () => {}, env: w.env });
  offW();
  w.history.state = null; // Shell: history.replaceState(null, "", "#/demo/investments.portfolio/journal")
  await tick();
  assert.equal(w.history.backs, 0);
});
