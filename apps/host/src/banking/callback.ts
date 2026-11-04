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
  close(): Promise<void>;
}

export function parseBankingCallbackUrl(value: string, redirectUrl: string, state: string): string {
  let target: URL;
  let parsed: URL;
  try {
    target = new URL(redirectUrl);
    parsed = new URL(value);
  } catch {
    throw new BankingFault("authorization");
  }
  if (
    parsed.origin !== target.origin ||
    parsed.pathname !== target.pathname ||
    parsed.hash ||
    parsed.searchParams.getAll("state").length !== 1 ||
    parsed.searchParams.get("state") !== state ||
    parsed.searchParams.getAll("code").length !== 1 ||
    parsed.searchParams.has("error") ||
    [...parsed.searchParams.keys()].some((key) => key !== "state" && key !== "code")
  )
    throw new BankingFault("authorization");
  const code = parsed.searchParams.get("code") ?? "";
  if (!/^[A-Za-z0-9._~-]{1,2048}$/.test(code)) throw new BankingFault("authorization");
  return code;
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
    const finish = (status: number) => {
      response.writeHead(status, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      });
      response.end(
        `<!doctype html><meta charset="utf-8"><title>cashU</title><p>${status === 200 ? S.accepted[language] : S.rejected[language]}</p>`,
      );
    };
    if (
      used ||
      request.method !== "GET" ||
      request.headers.host !== target.host ||
      !request.url ||
      request.url.length > 4096
    ) {
      finish(404);
      return;
    }
    let parsed: URL;
    try {
      parsed = new URL(request.url, target);
    } catch {
      finish(400);
      return;
    }
    if (
      parsed.origin !== target.origin ||
      parsed.pathname !== target.pathname ||
      parsed.hash ||
      parsed.searchParams.getAll("state").length !== 1 ||
      parsed.searchParams.get("state") !== state ||
      [...parsed.searchParams.keys()].some(
        (key) => key !== "state" && key !== "code" && key !== "error",
      )
    ) {
      finish(400);
      return;
    }
    if (parsed.searchParams.getAll("error").length === 1 && !parsed.searchParams.has("code")) {
      used = true;
      finish(200);
      reject?.(new BankingFault("authorization"));
      return;
    }
    if (parsed.searchParams.getAll("code").length !== 1 || parsed.searchParams.has("error")) {
      finish(400);
      return;
    }
    const value = parsed.searchParams.get("code") ?? "";
    if (!/^[A-Za-z0-9._~-]{1,2048}$/.test(value)) {
      finish(400);
      return;
    }
    used = true;
    finish(200);
    settle?.(value);
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
            timer = setTimeout(() => fail(new BankingFault("expired")), timeoutMs);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      reject?.(new BankingFault("expired"));
      server.closeAllConnections();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
