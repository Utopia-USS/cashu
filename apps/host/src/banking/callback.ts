import "reflect-metadata";
import { randomBytes, webcrypto } from "node:crypto";
import { createServer, type Server } from "node:https";
import type { Duplex } from "node:stream";
import { IP, SubjectAlternativeNameExtension, X509CertificateGenerator } from "@peculiar/x509";
import { S } from "./callback.strings.js";
import { BankingFault } from "./client.js";

export interface CallbackCapture {
  readonly redirectUrl: string;
  wait(timeoutMs?: number): Promise<string>;
  /** Hands over a callback URL the owner copied from the browser; throws `callback_invalid`. */
  offer(callbackUrl: string): void;
  close(): Promise<void>;
}

/** What a callback's query says: the authorization code, the bank's refusal, or nothing usable. */
type CallbackReading =
  | { readonly kind: "code"; readonly code: string }
  | { readonly kind: "denied"; readonly reason: string }
  | { readonly kind: "invalid"; readonly reason: string };

/**
 * Reads the query Enable Banking redirects to. Only `state`, `code` and `error` count; anything else
 * Enable Banking or the bank adds (`error_description`, tracking parameters) is ignored, never echoed.
 */
function readCallback(params: URLSearchParams, state: string): CallbackReading {
  if (params.getAll("state").length !== 1 || params.get("state") !== state)
    return { kind: "invalid", reason: "state" };
  const errors = params.getAll("error");
  if (errors.length > 0) {
    const reason = errors[0] ?? "";
    return { kind: "denied", reason: /^[a-z_]{1,40}$/.test(reason) ? reason : "other" };
  }
  const codes = params.getAll("code");
  if (codes.length !== 1) return { kind: "invalid", reason: "code_missing" };
  const code = codes[0] ?? "";
  if (!/^[A-Za-z0-9._~-]{1,2048}$/.test(code)) return { kind: "invalid", reason: "code_format" };
  return { kind: "code", code };
}

/** One stderr line (host.log) per callback that did not deliver a code: a static reason only. */
function logCallback(reason: string): void {
  try {
    console.warn("banking.callback", reason);
  } catch {
    // Best effort: logging must not change the answer.
  }
}

/** The owner's copied callback URL: the pending origin, path and state, and a code. */
export function parseBankingCallbackUrl(value: string, redirectUrl: string, state: string): string {
  let target: URL;
  let parsed: URL;
  try {
    target = new URL(redirectUrl);
    parsed = new URL(value.trim());
  } catch {
    throw new BankingFault("callback_invalid");
  }
  if (parsed.origin !== target.origin || parsed.pathname !== target.pathname)
    throw new BankingFault("callback_invalid");
  const reading = readCallback(parsed.searchParams, state);
  if (reading.kind === "denied") throw new BankingFault("consent_denied");
  if (reading.kind === "invalid") throw new BankingFault("callback_invalid");
  return reading.code;
}

function pem(label: string, bytes: Uint8Array): string {
  const content =
    Buffer.from(bytes)
      .toString("base64")
      .match(/.{1,64}/g)
      ?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${content}\n-----END ${label}-----\n`;
}

/** A fresh loopback TLS identity. Its private key never touches disk or the bank API. */
async function tlsIdentity(): Promise<{ key: string; cert: string }> {
  const algorithm = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } as const;
  const keys = await webcrypto.subtle.generateKey(algorithm, true, ["sign", "verify"]);
  const cert = await X509CertificateGenerator.createSelfSigned({
    serialNumber: randomBytes(16).toString("hex"),
    name: "CN=localhost",
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 10 * 60_000),
    signingAlgorithm: algorithm,
    keys,
    extensions: [new SubjectAlternativeNameExtension([{ type: IP, value: "127.0.0.1" }], true)],
  });
  return {
    key: pem(
      "PRIVATE KEY",
      new Uint8Array(await webcrypto.subtle.exportKey("pkcs8", keys.privateKey)),
    ),
    cert: cert.toString("pem"),
  };
}

/** Only a literal 127.0.0.1 HTTPS callback, exact path and one-use random state are accepted. */
export async function listenForBankingCallback(
  redirectUrl: string,
  state: string,
  language: "pl" | "en" = "en",
): Promise<CallbackCapture> {
  let target: URL;
  try {
    target = new URL(redirectUrl);
  } catch {
    throw new BankingFault("configuration");
  }
  if (
    target.protocol !== "https:" ||
    target.hostname !== "127.0.0.1" ||
    !target.port ||
    target.username ||
    target.password ||
    target.search ||
    target.hash ||
    target.pathname !== "/eb/callback" ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(state)
  )
    throw new BankingFault("configuration");
  const identity = await tlsIdentity();
  let settle: ((value: string) => void) | undefined;
  let reject: ((reason: Error) => void) | undefined;
  let used = false;
  const code = new Promise<string>((resolve, fail) => {
    settle = resolve;
    reject = fail;
  });
  void code.catch(() => undefined);
  const server: Server = createServer(identity, (request, response) => {
    const finish = (page: "accepted" | "denied" | "stale") => {
      response.writeHead(page === "stale" ? 400 : 200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      });
      response.end(
        `<!doctype html><meta charset="utf-8"><title>cashU</title><p>${S[page][language]}</p>`,
      );
    };
    if (request.method !== "GET" || !request.url || request.url.length > 4096) {
      logCallback("request");
      finish("stale");
      return;
    }
    let parsed: URL;
    try {
      parsed = new URL(request.url, target);
    } catch {
      logCallback("url");
      finish("stale");
      return;
    }
    // A browser also asks for /favicon.ico: answer it without touching the consent.
    if (parsed.pathname !== target.pathname) {
      response.writeHead(404).end();
      return;
    }
    if (request.headers.host !== target.host) {
      logCallback("host");
      finish("stale");
      return;
    }
    if (used) {
      logCallback("used");
      finish("stale");
      return;
    }
    const reading = readCallback(parsed.searchParams, state);
    if (reading.kind === "invalid") {
      logCallback(reading.reason);
      finish("stale");
      return;
    }
    used = true;
    if (reading.kind === "denied") {
      logCallback(`denied:${reading.reason}`);
      finish("denied");
      reject?.(new BankingFault("consent_denied"));
      return;
    }
    finish("accepted");
    settle?.(reading.code);
  });
  const sockets = new Set<Duplex>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  try {
    await new Promise<void>((resolve, fail) => {
      server.once("error", fail);
      server.listen(Number(target.port), "127.0.0.1", () => {
        server.off("error", fail);
        resolve();
      });
    });
  } catch {
    server.close();
    throw new BankingFault("configuration");
  }
  let closed = false;
  return {
    redirectUrl,
    async wait(timeoutMs = 300_000) {
      if (timeoutMs < 1 || timeoutMs > 300_000) throw new BankingFault("configuration");
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          code,
          new Promise<string>((_, fail) => {
            timer = setTimeout(() => fail(new BankingFault("consent_timeout")), timeoutMs);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    offer(callbackUrl: string) {
      if (closed || used) throw new BankingFault("callback_invalid");
      const code = parseBankingCallbackUrl(callbackUrl, redirectUrl, state);
      used = true;
      settle?.(code);
    },
    async close() {
      if (closed) return;
      closed = true;
      reject?.(new BankingFault("consent_cancelled"));
      server.closeAllConnections();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
