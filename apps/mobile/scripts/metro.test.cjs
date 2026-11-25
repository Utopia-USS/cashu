const assert = require("node:assert/strict");
const { dirname, join } = require("node:path");
const { test } = require("node:test");
const { z } = require("zod");
const config = require("../metro.config.js");

const locales = dirname(require.resolve("zod/v4/locales"));
const mobile = join(__dirname, "../src/platform/zodLocales.ts");
const resolve = config.resolver.resolveRequest;

test("both Zod locale barrels resolve to the English-only mobile namespace", () => {
  for (const platform of ["ios", "android"]) {
    for (const suffix of ["js", "cjs"]) {
      const filePath = join(locales, `index.${suffix}`);
      const context = {
        originModulePath: join(locales, `../core/index.${suffix}`),
        resolveRequest: () => ({ type: "sourceFile", filePath }),
      };
      assert.deepEqual(resolve(context, "../locales/index.js", platform), {
        type: "sourceFile",
        filePath: mobile,
      });
    }
  }
});

test("direct English imports and unrelated modules retain their resolution", () => {
  for (const filePath of [join(locales, "en.js"), "/other/library/locales/index.js"]) {
    const result = { type: "sourceFile", filePath };
    const context = { originModulePath: "/entry.js", resolveRequest: () => result };
    assert.equal(resolve(context, "a-module", "ios"), result);
  }
});

test("the existing TypeScript sibling resolution still works", () => {
  const calls = [];
  const result = { type: "sourceFile", filePath: "/app/helper.ts" };
  const context = {
    originModulePath: "/app/entry.ts",
    resolveRequest: (_context, name) => {
      calls.push(name);
      return result;
    },
  };
  assert.equal(resolve(context, "./helper.js", "android"), result);
  assert.deepEqual(calls, ["./helper"]);
});

test("the mobile locale map preserves English issues and error precedence", async () => {
  const englishOnly = await import("../src/platform/zodLocales.ts");
  assert.deepEqual(Object.keys(englishOnly), ["en"]);
  const schema = z
    .object({
      name: z.string().min(2),
      count: z.number().int().positive(),
      kind: z.enum(["a", "b"]),
      email: z.email(),
    })
    .strict();
  const inputs = [null, {}, { name: "x", count: -1.5, kind: "bad", email: "bad", extra: true }];
  const issues = () => inputs.map((value) => schema.safeParse(value).error.issues);
  const before = issues();
  const original = { ...z.config() };
  try {
    z.config(englishOnly.en());
    assert.deepEqual(issues(), before);
    assert.equal(
      z.string().safeParse(1).error.issues[0].message,
      "Invalid input: expected string, received number",
    );
    assert.equal(
      z.string({ error: "synthetic custom message" }).safeParse(1).error.issues[0].message,
      "synthetic custom message",
    );
    assert.equal(
      z.string().safeParse(1, { error: () => "synthetic per-parse message" }).error.issues[0]
        .message,
      "synthetic per-parse message",
    );
    z.config({ customError: () => "synthetic global message" });
    assert.equal(z.string().safeParse(1).error.issues[0].message, "synthetic global message");
    assert.equal(
      z.string().safeParse(1, { error: () => "synthetic per-parse message" }).error.issues[0]
        .message,
      "synthetic per-parse message",
    );
  } finally {
    z.config({ ...original, customError: original.customError });
  }
});
