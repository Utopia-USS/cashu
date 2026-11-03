import { describe, expect, it } from "vitest";
import {
  errorInfo,
  STORE_PROTOCOL_VERSION,
  storeToClientSchema,
  storeToHostSchema,
} from "./messages.js";

const VAULT = "0123456789abcdef0123456789abcdef";
const KEY = "01JBQX8Z5W3N4R6T7V8Y9A0BCD";

describe("store channel v4 messages", () => {
  it("requires an idempotency key on every run", () => {
    const run = {
      t: "run",
      rid: 1,
      target: { kind: "vault", vault: VAULT },
      command: "c",
      input: {},
    };
    expect(storeToHostSchema.safeParse(run).success).toBe(false);
    expect(storeToHostSchema.parse({ ...run, key: KEY })).toMatchObject({ key: KEY });
    for (const key of [
      "01jbqx8z5w3n4r6t7v8y9a0bcd",
      "81JBQX8Z5W3N4R6T7V8Y9A0BCD",
      "01JBQX8Z5W3N4R6T7V8Y9A0BCI",
    ]) {
      expect(storeToHostSchema.safeParse({ ...run, key }).success, key).toBe(false);
    }
  });

  it("requires a policy generation and resume bit on subscriptions and replies", () => {
    const sub = {
      t: "sub",
      sid: 2,
      target: { kind: "device" },
      query: "q",
      args: null,
    };
    expect(storeToHostSchema.safeParse(sub).success).toBe(false);
    expect(storeToHostSchema.safeParse({ ...sub, generation: 0 }).success).toBe(false);
    expect(storeToHostSchema.safeParse({ ...sub, generation: 0, resume: false }).success).toBe(
      true,
    );
    expect(storeToHostSchema.safeParse({ ...sub, generation: -1, resume: true }).success).toBe(
      false,
    );
    expect(storeToClientSchema.safeParse({ t: "value", sid: 1, value: null }).success).toBe(false);
    expect(
      storeToClientSchema.safeParse({ t: "error", sid: 1, error: { name: "Error", message: "x" } })
        .success,
    ).toBe(false);
    expect(
      storeToClientSchema.safeParse({ t: "value", sid: 1, generation: 0, value: null }).success,
    ).toBe(true);
    expect(
      storeToClientSchema.safeParse({
        t: "error",
        sid: 1,
        generation: 0,
        error: { name: "Error", message: "x" },
      }).success,
    ).toBe(true);
    expect(storeToClientSchema.safeParse({ t: "ready", protocol: 3, vaults: [] }).success).toBe(
      false,
    );
    expect(
      storeToClientSchema.safeParse({
        t: "ready",
        protocol: STORE_PROTOCOL_VERSION,
        vaults: [VAULT],
      }).success,
    ).toBe(true);
    expect(
      storeToClientSchema.safeParse({
        t: "result",
        rid: 1,
        result: { ok: true, value: { "~cashu": "undefined" } },
      }).success,
    ).toBe(true);
    expect(
      storeToClientSchema.safeParse({ t: "value", sid: 1, generation: 0, value: 1n }).success,
    ).toBe(false);
  });

  it("carries an error's name and message only", () => {
    expect(errorInfo(new RangeError("x".repeat(3000)))).toEqual({
      name: "RangeError",
      message: "x".repeat(2000),
    });
    expect(errorInfo("boom")).toEqual({ name: "Error", message: "non-error thrown" });
  });
});
