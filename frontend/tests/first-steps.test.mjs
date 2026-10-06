// First steps in the app (design/v3/first-steps): the setup-steps helpers, the `setup/<module>/cli` route, the
// shared "stop reminding me" store and the new error labels. Run with `npm test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { nextStep, partialLine, stepById, stepCounts, lowerFirst } from "../src/core/setupSteps.ts";
import { pathToView, viewToPath } from "../src/core/context.ts";
import { hideCard, hiddenCards, isHidden, HIDDEN_KEY } from "../src/core/hidden.ts";
import { label } from "../src/core/messages.ts";
import { createReloadHold } from "../src/core/hold.ts";

const steps = [
  { id: "statement", title: "Pierwszy wyciąg z banku", status: "done" },
  { id: "categories", title: "Kategorie wydatków", status: "on" },
  { id: "transfers", title: "Przelewy między kontami", status: "todo" },
  { id: "extra", title: "Coś opcjonalnego", status: "todo", optional: true },
];

test("step counts and the next step ignore optional steps", () => {
  assert.deepEqual(stepCounts(steps), { done: 1, n: 3 });
  assert.deepEqual(stepCounts(null), { done: 0, n: 0 });
  assert.equal(nextStep(steps).id, "categories");
  assert.equal(nextStep([{ title: "A", status: "done" }, { title: "B", status: "todo", optional: true }]), null);
  assert.equal(nextStep([{ title: "A", status: "done" }, { title: "B", status: "todo" }]).title, "B");
  assert.equal(partialLine(steps), "1 z 3 kroków · następny: kategorie wydatków");
  assert.equal(partialLine([{ title: "Kredyt", status: "done" }]), "1 z 1 kroku");
  assert.equal(lowerFirst("Rozpoznawanie rat"), "rozpoznawanie rat");
});

test("a step by id falls back to an older server's id", () => {
  const old = [{ id: "first_import", title: "Pierwszy import", status: "on" }];
  assert.equal(stepById(old, "statement", "first_import").id, "first_import");
  assert.equal(stepById(steps, "statement", "first_import").id, "statement");
  assert.equal(stepById(steps, "nope"), null);
  assert.equal(stepById(null, "statement"), null);
});

test("setup/<module>/cli is the CLI page, setup/<module> the in-app first steps", () => {
  assert.deepEqual(pathToView("setup/budget/cli"), { kind: "setup", module: "budget", cli: true });
  assert.deepEqual(pathToView("setup/budget"), { kind: "setup", module: "budget" });
  assert.equal(viewToPath({ kind: "setup", module: "budget", cli: true }), "setup/budget/cli");
  assert.equal(viewToPath({ kind: "setup", module: "loans" }), "setup/loans");
  assert.equal(viewToPath(pathToView("setup/assets/cli")), "setup/assets/cli");
});

test("hidden reminders: per profile, module and setup state; a new state shows it again", () => {
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  try {
    assert.equal(isHidden("jan", "budget", "partial"), false);
    hideCard("jan", "budget", "partial");
    assert.equal(isHidden("jan", "budget", "partial"), true);
    assert.equal(isHidden("jan", "budget", "empty"), false);
    assert.equal(isHidden("ola", "budget", "partial"), false);
    assert.deepEqual(JSON.parse(store.get(HIDDEN_KEY)), { "jan.budget": "partial" });
    hideCard("jan", "loans", "partial");
    assert.deepEqual(Object.keys(hiddenCards()).sort(), ["jan.budget", "jan.loans"]);
  } finally {
    delete globalThis.localStorage;
  }
  // storage gone: this window's hides still hold
  assert.equal(isHidden("jan", "budget", "partial"), true);
});

test("every new error code has a Polish label", () => {
  for (const k of [
    "error.loan_name_taken", "error.import_bank_unknown", "error.import_header_missing", "error.import_empty", "error.import_file_format",
    "error.file_too_large", "error.import_invalid", "error.import_connector_unavailable", "error.import_account_mismatch",
    "error.import_account_type", "error.loan_invalid", "error.depreciation_invalid", "error.name_taken", "error.not_found",
    "import.currency_mismatch", "import.unknown_institution", "import.empty", "import.duplicate_id",
  ]) {
    assert.ok(label(k), k);
  }
  assert.equal(label("error.import_bank_unknown"), "Nie rozpoznano banku: wybierz go z listy.");
});

test("FE-2 reload hold: held while any holder is active, release is idempotent", () => {
  const h = createReloadHold();
  assert.equal(h.held(), false);
  const a = h.acquire();
  const b = h.acquire();
  assert.equal(h.held(), true);
  a();
  a(); // a second release of the same holder does not free the other one
  assert.equal(h.held(), true);
  b();
  assert.equal(h.held(), false);
});
