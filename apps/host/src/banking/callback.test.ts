import { get } from "node:https";
import { createServer } from "node:net";
import { expect, it } from "vitest";
import { listenForBankingCallback, parseBankingCallbackUrl } from "./callback.js";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no synthetic port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
function visit(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    get(url, { rejectUnauthorized: false }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode ?? 0));
    }).on("error", reject);
  });
}

it("accepts one exact state callback and rejects wrong state, path and replay", async () => {
  const port = await freePort();
  const base = `https://127.0.0.1:${port}/eb/callback`;
  const state = "s".repeat(43);
  const capture = await listenForBankingCallback(base, state);
  try {
    expect(await visit(`${base}?state=wrong&code=synthetic`)).toBe(400);
    expect(await visit(`https://127.0.0.1:${port}/other?state=${state}&code=synthetic`)).toBe(400);
    expect(await visit(`${base}?state=${state}&code=synthetic-code`)).toBe(200);
    expect(await capture.wait(1000)).toBe("synthetic-code");
    expect(await visit(`${base}?state=${state}&code=replay`)).toBe(404);
  } finally {
    await capture.close();
  }
});

it("turns a bank denial into a sanitized authorization error", async () => {
  const port = await freePort();
  const base = `https://127.0.0.1:${port}/eb/callback`;
  const state = "s".repeat(43);
  const capture = await listenForBankingCallback(base, state);
  try {
    expect(await visit(`${base}?state=${state}&error=access_denied`)).toBe(200);
    await expect(capture.wait(1000)).rejects.toThrow("enable_banking_authorization");
  } finally {
    await capture.close();
  }
});

it("closes a pending callback without a waiter or leaked listener", async () => {
  const port = await freePort();
  const base = `https://127.0.0.1:${port}/eb/callback`;
  const capture = await listenForBankingCallback(base, "s".repeat(43));
  await capture.close();
  await expect(visit(`${base}?state=${"s".repeat(43)}&code=synthetic`)).rejects.toThrow();
});

it("accepts a manually copied full callback URL only with the pending origin and state", () => {
  const redirect = "https://127.0.0.1:18888/eb/callback";
  const state = "s".repeat(43);
  expect(
    parseBankingCallbackUrl(`${redirect}?code=synthetic&state=${state}`, redirect, state),
  ).toBe("synthetic");
  for (const value of [
    `https://evil.example/eb/callback?code=synthetic&state=${state}`,
    `${redirect}?code=synthetic&state=wrong`,
    `${redirect}?code=synthetic&code=second&state=${state}`,
  ])
    expect(() => parseBankingCallbackUrl(value, redirect, state)).toThrow(
      "enable_banking_authorization",
    );
});
