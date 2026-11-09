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
    // Another path (the browser's favicon request) never touches the consent.
    expect(await visit(`https://127.0.0.1:${port}/favicon.ico`)).toBe(404);
    // Parameters Enable Banking or the bank add are ignored; state and code decide.
    expect(await visit(`${base}?state=${state}&code=synthetic-code&lang=pl`)).toBe(200);
    expect(await capture.wait(1000)).toBe("synthetic-code");
    expect(await visit(`${base}?state=${state}&code=replay`)).toBe(400);
  } finally {
    await capture.close();
  }
});

it("turns a bank denial, with Enable Banking's description, into consent_denied", async () => {
  const port = await freePort();
  const base = `https://127.0.0.1:${port}/eb/callback`;
  const state = "s".repeat(43);
  const capture = await listenForBankingCallback(base, state);
  try {
    expect(
      await visit(`${base}?state=${state}&error=access_denied&error_description=Synthetic%20text`),
    ).toBe(200);
    await expect(capture.wait(1000)).rejects.toThrow("enable_banking_consent_denied");
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

it("ends a wait that the owner cancels with consent_cancelled", async () => {
  const port = await freePort();
  const capture = await listenForBankingCallback(
    `https://127.0.0.1:${port}/eb/callback`,
    "s".repeat(43),
  );
  const waiting = capture.wait(5000);
  await capture.close();
  await expect(waiting).rejects.toThrow("enable_banking_consent_cancelled");
});

it("takes a copied callback URL into the wait, once, and refuses a foreign one", async () => {
  const port = await freePort();
  const base = `https://127.0.0.1:${port}/eb/callback`;
  const state = "s".repeat(43);
  const capture = await listenForBankingCallback(base, state);
  try {
    expect(() => capture.offer(`${base}?state=wrong&code=synthetic`)).toThrow(
      "enable_banking_callback_invalid",
    );
    capture.offer(`  ${base}?code=copied&state=${state}  `);
    expect(await capture.wait(1000)).toBe("copied");
    expect(() => capture.offer(`${base}?code=again&state=${state}`)).toThrow(
      "enable_banking_callback_invalid",
    );
  } finally {
    await capture.close();
  }
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
      "enable_banking_callback_invalid",
    );
  expect(() =>
    parseBankingCallbackUrl(`${redirect}?error=access_denied&state=${state}`, redirect, state),
  ).toThrow("enable_banking_consent_denied");
});
