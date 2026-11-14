// Investments account settings (S25 spec 4.2). Synthetic data only.
import { describe, expect, it } from "vitest";
import { openTestStore } from "../testing/store.js";
import { account, converge, DEV_B, det, Events, rows } from "./testing/kit.js";

const ACC = "01JE0000000000000000000A01";

describe("inv_account_settings", () => {
  it("creates the row with the default wrapper and patches present fields", () => {
    const store = openTestStore();
    const ev = new Events();
    const g = det("inv_account_settings", ACC);
    store.applyEnvelopes([account(ev, ACC)]);
    const first = store.applyEnvelopes([
      ev.make("invAccount.settingsSet", g, { account: ACC, importer: "cashu" }, { wall: 10 }),
    ]);
    expect([...first.touchedTables]).toEqual(["inv_account_settings"]);
    expect(rows(store, "inv_account_settings")).toEqual([
      {
        gid: g,
        account_id: ACC,
        wrapper: "regular",
        importer: "cashu",
        mapping_yaml: null,
        created_at: "2026-10-31 12:00:00.010000",
        updated_at: "2026-10-31 12:00:00.010000",
      },
    ]);
    store.applyEnvelopes([
      ev.make(
        "invAccount.settingsSet",
        g,
        { account: ACC, wrapper: "ike", importer: null },
        { wall: 20 },
      ),
    ]);
    expect(rows(store, "inv_account_settings")[0]).toMatchObject({
      wrapper: "ike",
      importer: null,
      created_at: "2026-10-31 12:00:00.010000",
      updated_at: "2026-10-31 12:00:00.020000",
    });
  });

  it("collapses the settings of two account gids that merge into one row (anchor = first)", () => {
    const a = new Events();
    const b = new Events(DEV_B, "01JB");
    const A2 = "01JE0000000000000000000A02";
    const events = [
      account(a, ACC, ["ext:xtb:1"], { wall: 1 }),
      account(b, A2, ["ext:xtb:1"], { wall: 2 }),
      a.make(
        "invAccount.settingsSet",
        det("inv_account_settings", ACC),
        {
          account: ACC,
          wrapper: "ike",
        },
        { wall: 10 },
      ),
      b.make(
        "invAccount.settingsSet",
        det("inv_account_settings", A2),
        {
          account: A2,
          mappingYaml: "kolumny: {}",
        },
        { wall: 20 },
      ),
    ];
    converge(events, (store) => {
      expect(rows(store, "inv_account_settings")).toEqual([
        expect.objectContaining({
          gid: det("inv_account_settings", ACC),
          account_id: ACC, // the root: the earlier holder of the shared key
          wrapper: "ike",
          mapping_yaml: "kolumny: {}",
        }),
      ]);
    });
  });
});
