// The Konta widget's removal: which rows offer it, the confirmation and the undo line. Synthetic rows.
import { D } from "@cashu/domain";
import { lang, setLanguageForTests } from "@cashu/i18n";
import { afterEach, expect, it, vi } from "vitest";
import { R } from "./AccountRemoval.strings.js";
import { type AccountRemovalState, accountsModel } from "./overviewModel.js";

const row = (gid: string, bank: string, type: string) => ({
  gid,
  name: `Synthetic ${gid}`,
  bank,
  type,
  currency: "PLN",
  ibanTail: null,
  amount: D("100"),
});
const accounts = [
  row("a", "mbank", "checking"),
  row("b", "manual", "checking"),
  row("c", "mbank", "investment"),
];
const removal = (over: Partial<AccountRemovalState> = {}): AccountRemovalState => ({
  asked: null,
  undone: null,
  error: null,
  ask: vi.fn(),
  cancel: vi.fn(),
  confirm: vi.fn(async () => {}),
  undo: vi.fn(async () => {}),
  ...over,
});
const model = (state: AccountRemovalState) =>
  accountsModel({
    accounts,
    wallet: { exists: false, balance: D("0"), currency: "PLN" },
    showEmpty: true,
    removal: state,
    onToggle: () => {},
    onCash: () => {},
  });

const initial = lang();
afterEach(() => setLanguageForTests(initial));

it("offers removal on bank accounts only", () => {
  setLanguageForTests("en");
  const state = removal();
  const m = model(state);
  const byKey = new Map(m.rows.map((r) => [r.key, r]));
  expect(byKey.get("a")?.remove?.title).toBe(R.removeTitle("Synthetic a"));
  expect(byKey.get("b")?.remove).toBeNull();
  expect(byKey.get("c")?.remove).toBeNull();
  byKey.get("a")?.remove?.onPress();
  expect(state.ask).toHaveBeenCalledWith({ gid: "a", name: "Synthetic a" });
  expect(m.confirm).toBeNull();
  expect(m.undone).toBeNull();
});

it("asks before removing and offers the undo afterwards", () => {
  setLanguageForTests("en");
  const asked = removal({ asked: { gid: "a", name: "Synthetic a" }, error: "Could not." });
  const m = model(asked);
  expect(m.confirm).toMatchObject({
    title: R.confirmTitle,
    text: R.confirmText("Synthetic a"),
    error: "Could not.",
  });
  m.confirm?.confirm.onPress();
  expect(asked.confirm).toHaveBeenCalled();
  const done = removal({ undone: { gid: "a", name: "Synthetic a" } });
  const after = model(done);
  expect(after.undone).toMatchObject({ text: R.removed("Synthetic a"), error: null });
  after.undone?.undo.onPress();
  expect(done.undo).toHaveBeenCalled();
});
