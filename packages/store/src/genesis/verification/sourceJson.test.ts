import { describe, expect, it } from "vitest";
import { projectSourceJson, SourceJsonError, sourceRuleKey } from "./sourceJson.js";

const ids = new Map([
  ["inv_instruments\u00001", "instrument-gid"],
  ["accounts\u00002", "account-gid"],
  ["alerts\u00003", "alert-gid"],
  ["research_notes\u00004", "note-gid"],
]);

describe("independent source JSON projection", () => {
  it("maps source references in payloads and signal keys", () => {
    expect(
      projectSourceJson(
        "inv_signals",
        "payload",
        '{"instrument_id":1,"accounts":[2],"note_ids":[4]}',
        ids,
      ),
    ).toEqual({
      instrument_id: "instrument-gid",
      accounts: ["account-gid"],
      note_ids: ["note-gid"],
    });
    expect(sourceRuleKey("i:1|a:2", ids, false)).toBe("i:instrument-gid|a:account-gid");
    expect(sourceRuleKey("alert:3", ids, true)).toBe("alert:alert-gid");
  });

  it("refuses missing mappings, uncovered id fields and staged proposal blobs", () => {
    expect(() =>
      projectSourceJson("research_runs", "scope", '{"instrument_ids":[9]}', ids),
    ).toThrowError(new SourceJsonError());
    expect(() =>
      projectSourceJson("reviews", "stats", '{"unmapped_account_id":2}', ids),
    ).toThrowError(new SourceJsonError());
    expect(() => projectSourceJson("proposals", "payload", '{"staged":"x"}', ids)).toThrowError(
      new SourceJsonError(),
    );
  });

  it("independently hashes a sealed staged proposal before comparing its blob reference", () => {
    const bytes = new TextEncoder().encode("synthetic staged import\n");
    const digest = bytesToHex(sha256(bytes));
    const path = `imports/alpha/.proposals/${digest}-0123456789ab.csv`;
    const payload = JSON.stringify({ account_id: 2, staged: path, file_name: "synthetic.csv" });
    const files = { read: (relative: string) => (relative === path ? bytes : undefined) };
    expect(projectSourceJson("proposals", "payload", payload, ids, files)).toEqual({
      account: "account-gid",
      blob: { sha256: digest, ext: "csv" },
      file_name: "synthetic.csv",
    });
    expect(() =>
      projectSourceJson("proposals", "payload", payload, ids, { read: () => new Uint8Array([1]) }),
    ).toThrowError(new SourceJsonError());
    expect(() =>
      projectSourceJson("proposals", "payload", payload, ids, { read: () => undefined }),
    ).toThrowError(new SourceJsonError());
    expect(() =>
      projectSourceJson(
        "proposals",
        "payload",
        JSON.stringify({ staged: `../${digest}.csv` }),
        ids,
        files,
      ),
    ).toThrowError(new SourceJsonError());
  });
});

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
