import { describe, expect, it } from "vitest";
import { parseAnthropicReply, parseOllamaMerchantReply, parseOllamaTxnReply } from "./replies.js";

const KEYS = ["groceries", "fuel"];
const ids = new Map([
  ["m0", "ZABKA"],
  ["m1", "ORLEN"],
]);
const json = (v: unknown) => JSON.stringify(v);

describe("Ollama replies", () => {
  it("unknown ids ignored, invalid categories become other, confidence defaults and clamps (Q18)", () => {
    const res = parseOllamaMerchantReply(
      json({
        results: [
          { id: "m0", category: "groceries", confidence: 1.5 },
          { id: "m1", category: "nonsense", confidence: "x" },
          { id: "m9", category: "fuel" },
        ],
      }),
      ids,
      KEYS,
    );
    expect(res).toEqual({
      ok: true,
      answers: new Map([
        ["ZABKA", { category: "groceries", confidence: 1 }],
        ["ORLEN", { category: "other", confidence: 0.5 }],
      ]),
    });
  });

  it("missing confidence is 0.5; booleans and numeric strings follow float()", () => {
    const res = parseOllamaMerchantReply(
      json({
        results: [
          { id: "m0", category: "fuel" },
          { id: "m1", category: "fuel", confidence: " 0.25 " },
        ],
      }),
      ids,
      KEYS,
    );
    expect(res.ok && [...res.answers.values()].map((a) => a.confidence)).toEqual([0.5, 0.25]);
    const t = parseOllamaMerchantReply(
      json({ results: [{ id: "m0", category: "fuel", confidence: true }] }),
      ids,
      KEYS,
    );
    expect(t.ok && t.answers.get("ZABKA")?.confidence).toBe(1);
  });

  // FIX(Q11): Python raised AttributeError outside the try and aborted the run.
  it.each([
    ["invalid JSON", "{nope"],
    ["a list", "[1, 2]"],
    ["non-object items", json({ results: ["x"] })],
    ["results not iterable", json({ results: 5 })],
    ["unhashable category", json({ results: [{ id: "t0", category: ["x"] }] })],
  ])("a malformed reply (%s) fails the batch only (FIX Q11)", (_name, content) => {
    expect(parseOllamaTxnReply(content, ["t0"], KEYS)).toEqual({ ok: false, reason: "malformed" });
  });

  // FIX(Q10): Python accepted any id, so a hallucinated t<n> could recategorize another group.
  it("transaction replies accept only the batch's own ids (FIX Q10)", () => {
    const res = parseOllamaTxnReply(
      json({
        results: [
          { id: "t0", category: "fuel" },
          { id: "t7", category: "groceries" },
        ],
      }),
      ["t0", "t1"],
      KEYS,
    );
    expect(res.ok && [...res.answers.keys()]).toEqual(["t0"]);
  });
});

describe("Anthropic replies", () => {
  const data = (text: string, lead: unknown[] = []) => ({
    content: [...lead, { type: "text", text }],
  });

  it("first text block; UNKNOWN and invalid categories become other; bad confidence is 0.0", () => {
    const res = parseAnthropicReply(
      data(
        json({
          results: [
            { id: "m0", category: "UNKNOWN", confidence: 0.7 },
            { id: "m1", category: "fuel" },
          ],
        }),
        [{ type: "thinking", text: "{}" }],
      ),
      ids,
      KEYS,
    );
    expect(res).toEqual({
      ok: true,
      answers: new Map([
        ["ZABKA", { category: "other", confidence: 0.7 }],
        ["ORLEN", { category: "fuel", confidence: 0 }],
      ]),
    });
  });

  it("any exception Python raises fails the whole batch", () => {
    expect(parseAnthropicReply({ content: [] }, ids, KEYS)).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(parseAnthropicReply(data("[]"), ids, KEYS)).toEqual({ ok: false, reason: "malformed" });
    expect(parseAnthropicReply(data(json({ results: [{ id: ["m0"] }] })), ids, KEYS)).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(parseAnthropicReply("x", ids, KEYS)).toEqual({ ok: false, reason: "malformed" });
  });

  it("NaN confidence clamps like Python's min/max (1.0)", () => {
    const res = parseAnthropicReply(
      data(json({ results: [{ id: "m0", category: "fuel", confidence: "nan" }] })),
      ids,
      KEYS,
    );
    expect(res.ok && res.answers.get("ZABKA")?.confidence).toBe(1);
  });
});
