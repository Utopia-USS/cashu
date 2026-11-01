import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parsePyJson } from "../../pyJson.js";
import { alertMessage } from "./messages.js";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/signal-read-vectors.json", import.meta.url), "utf8"),
) as {
  messages: readonly {
    kind: string;
    payload?: Record<string, unknown> | null;
    payload_json?: string;
    message: string;
    label: string | null;
    expected: unknown;
  }[];
};

function fixtureValue(value: unknown): unknown {
  if (typeof value === "bigint") return Number(value);
  if (Array.isArray(value)) return value.map(fixtureValue);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fixtureValue(v)]));
  return value;
}

describe("Python alerts/messages.py differential", () => {
  it.each(fixture.messages)(
    "maps stored facts for $kind",
    ({ kind, payload, payload_json, message, label, expected }) => {
      const data =
        payload_json === undefined
          ? (payload ?? null)
          : (parsePyJson(payload_json, (s, integer) => (integer ? BigInt(s) : Number(s))) as Record<
              string,
              unknown
            >);
      const actual = alertMessage(kind, data, message, label);
      // The public params preserve exact facts; normalize bigint only for the JSON fixture assertion.
      expect(fixtureValue(actual)).toEqual(expected);
    },
  );
  it("retains null and empty facts and strips only an exact custom-title prefix", () => {
    expect(alertMessage("alert:custom", { title: "A", symbol: "" }, "A: detail")).toEqual([
      "alert.custom",
      { title: "A", label: "", detail: "detail" },
    ]);
    expect(alertMessage("alert:custom", { title: "A" }, "Other: detail")[1]?.detail).toBe(
      "Other: detail",
    );
  });
});
