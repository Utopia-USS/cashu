import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import { networkInterfaces } from "node:os";
import type {
  PairingCancelResult,
  PairingConfirmResult,
  PairingInspectResult,
  PairingInviteResult,
} from "@cashu/host-protocol";
import {
  encodeLanDescriptor,
  LAN_CARRIER_PATH,
  LAN_CHALLENGE_PATH,
  LAN_MAX_WIRE_BYTES,
  LAN_PAIR_PATH,
  LAN_PAIR_RESUME_PATH,
  lanAuthBody,
  lanCarrierReplySchema,
  lanCarrierRequestSchema,
  lanChallengeRequestSchema,
  lanPairResumeSchema,
  type PairExchangeReply,
  pairExchangeReplySchema,
  pairExchangeSchema,
} from "@cashu/host-protocol/pairing-lan";
import { mintUlid } from "@cashu/store";
import { crypto, devices } from "@cashu/sync";
import type { NativeVaultSession } from "../nativeVault.js";
import { loadLanTlsIdentity } from "./tls.js";

const MAX_INVITES = 1;
const CHALLENGE_TTL = 30_000;
const WELCOME_TTL = 24 * 60 * 60 * 1000;
const POLL_MS = 10_000;

type CodeResolver = (value: string | undefined) => void;
type Challenge = {
  vault: string;
  device: string;
  purpose: "carrier" | "resume";
  session?: string;
  expiresAt: number;
};

function reply(res: ServerResponse, body: unknown, status = 200): void {
  const encoded = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "content-length": String(encoded.length),
  });
  res.end(encoded);
}

async function readJson(req: IncomingMessage, cap: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > cap) throw new Error("too_large");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

class Exchange implements devices.PairingLink {
  readonly #incoming: Uint8Array[] = [];
  readonly #outgoing: Uint8Array[] = [];
  #receive?: (value: Uint8Array) => void;
  #send?: (value: Uint8Array) => void;
  #closed = false;
  #nextSeq = 0;
  #last?: { readonly encoded: string; readonly reply: PairExchangeReply };
  #busy = false;
  #drain?: () => void;
  #replay: Uint8Array[];
  #replayAt = 0;

  constructor(replay: readonly Uint8Array[] = []) {
    const total = replay.reduce((size, value) => size + value.byteLength, 0);
    if (
      replay.length > 1025 ||
      total > 72 * 1024 * 1024 ||
      replay.some((value) => value.length === 0 || value.length > 4 * 1024 * 1024)
    )
      throw new Error("pairing_receipt_too_large");
    this.#replay = [...replay];
  }

  async send(message: Uint8Array): Promise<void> {
    if (this.#closed) throw new Error("pairing_closed");
    if (message.length === 0 || message.length > 4 * 1024 * 1024)
      throw new Error("pairing_message_too_large");
    while (this.#outgoing.length >= 2 && !this.#closed)
      await new Promise<void>((resolve) => {
        this.#drain = resolve;
      });
    if (this.#closed) throw new Error("pairing_closed");
    const waiter = this.#send;
    this.#send = undefined;
    if (waiter) waiter(message);
    else this.#outgoing.push(message);
  }

  async receive(): Promise<Uint8Array> {
    if (this.#closed) throw new Error("pairing_closed");
    const value = this.#incoming.shift();
    if (value) return value;
    return new Promise((resolve) => {
      this.#receive = resolve;
    });
  }

  close(): void {
    this.#closed = true;
    this.#receive?.(new Uint8Array());
    this.#receive = undefined;
    this.#send?.(new Uint8Array());
    this.#send = undefined;
    this.#drain?.();
    this.#drain = undefined;
    this.#incoming.length = 0;
    this.#outgoing.length = 0;
    this.#replay.length = 0;
    this.#last = undefined;
  }

  async exchange(input: {
    v: 1;
    session: string;
    seq: number;
    kind: "send" | "poll";
    body?: string;
  }): Promise<PairExchangeReply> {
    if (this.#closed) return { v: 1, seq: input.seq, kind: "closed", code: "cancelled" };
    const encoded = JSON.stringify(input);
    if (input.seq === this.#nextSeq - 1 && this.#last?.encoded === encoded) return this.#last.reply;
    if (input.seq !== this.#nextSeq || this.#busy)
      return { v: 1, seq: input.seq, kind: "closed", code: "invalid" };
    this.#busy = true;
    try {
      if (input.kind === "send") {
        const message = Buffer.from(input.body ?? "", "base64url");
        if (message.length === 0 || message.length > 4 * 1024 * 1024 || this.#incoming.length >= 1)
          return { v: 1, seq: input.seq, kind: "closed", code: "invalid" };
        const waiter = this.#receive;
        this.#receive = undefined;
        if (waiter) waiter(message);
        else this.#incoming.push(message);
      }
      let outbound = this.#outgoing.shift();
      if (outbound) {
        this.#drain?.();
        this.#drain = undefined;
      }
      if (!outbound && this.#replayAt < this.#replay.length)
        outbound = this.#replay[this.#replayAt++];
      if (!outbound)
        outbound = await new Promise<Uint8Array>((resolve) => {
          const timer = setTimeout(() => {
            this.#send = undefined;
            resolve(new Uint8Array());
          }, POLL_MS);
          this.#send = (value) => {
            clearTimeout(timer);
            resolve(value);
          };
        });
      const result: PairExchangeReply =
        outbound.length > 0
          ? {
              v: 1,
              seq: input.seq,
              kind: "message",
              body: Buffer.from(outbound).toString("base64url"),
            }
          : {
              v: 1,
              seq: input.seq,
              kind: this.#closed ? "closed" : "pending",
              ...(this.#closed ? { code: "cancelled" as const } : {}),
            };
      this.#last = { encoded, reply: result };
      this.#nextSeq += 1;
      return result;
    } finally {
      this.#busy = false;
    }
  }
}

interface LiveInvite {
  readonly vault: string;
  readonly operationId: string;
  readonly link: Exchange;
  readonly expiresAt: number;
  retireAt?: number;
  code?: CodeResolver;
  earlyCode?: string;
  dispatched?: boolean;
  codeResult?: (result: PairingConfirmResult) => void;
  outcome?: PairingConfirmResult;
}

export interface LanPairingService {
  invite(vault: string): Promise<PairingInviteResult>;
  confirm(vault: string, operationId: string, code: string): Promise<PairingConfirmResult>;
  inspect(vault: string, operationId: string): Promise<PairingInspectResult>;
  cancel(vault: string, operationId: string): Promise<PairingCancelResult>;
  close(): Promise<void>;
  /** Active owner pairing or verified paired requests only; unauthenticated traffic is excluded. */
  pending(): number;
  readonly address: { readonly ip: string; readonly port: number; readonly spki: string };
}

export function localLanIp(): string | undefined {
  const values = Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address)
    .sort();
  return values.find((ip) => {
    try {
      encodeLanDescriptor({ v: 1, ip, port: 1, spki: "0".repeat(64) });
      return true;
    } catch {
      return false;
    }
  });
}

export async function startLanPairingService(input: {
  readonly dataDir: string;
  readonly ip: string;
  readonly port: number;
  /** Resolve the current checked session for every request; host sessions may be replaced. */
  readonly vault: (vaultId: string) => NativeVaultSession | undefined;
  readonly now?: () => number;
}): Promise<LanPairingService> {
  const now = input.now ?? Date.now;
  const tls = await loadLanTlsIdentity(input.dataDir, input.ip, now());
  const invites = new Map<string, LiveInvite>();
  const challenges = new Map<string, Challenge>();
  let closed = false;
  let starting = false;
  let inFlight = 0;
  let authorizedCarrier = 0;
  const rates = new Map<string, { start: number; count: number }>();
  const prune = () => {
    for (const [nonce, challenge] of challenges)
      if (challenge.expiresAt < now()) challenges.delete(nonce);
    for (const [session, live] of invites)
      if (now() > (live.retireAt ?? live.expiresAt)) {
        live.code?.(undefined);
        live.codeResult?.({ kind: "refused", code: "expired" });
        live.link.close();
        invites.delete(session);
      }
    for (const [peer, rate] of rates) if (now() - rate.start >= 60_000) rates.delete(peer);
  };
  const cleanup = setInterval(prune, 60_000);
  cleanup.unref();
  const server: Server = createServer(
    { key: tls.key, cert: tls.cert, requestTimeout: 35_000, headersTimeout: 10_000 },
    (req, res) => {
      const peer = req.socket.remoteAddress ?? "unknown";
      const previousRate = rates.get(peer);
      const rate =
        !previousRate || now() - previousRate.start >= 60_000
          ? { start: now(), count: 0 }
          : previousRate;
      rate.count += 1;
      rates.set(peer, rate);
      if (
        inFlight >= 2 ||
        rate.count > 240 ||
        (req.headers["content-length"] !== undefined &&
          (!/^\d+$/.test(req.headers["content-length"] as string) ||
            Number(req.headers["content-length"]) >
              (req.url === LAN_CARRIER_PATH ? LAN_MAX_WIRE_BYTES : 6 * 1024 * 1024)))
      ) {
        reply(res, { v: 1, kind: "refused", code: "busy" }, 429);
        req.resume();
        return;
      }
      inFlight += 1;
      const deadline = setTimeout(() => req.destroy(), 35_000);
      void (async () => {
        prune();
        if (
          closed ||
          req.method !== "POST" ||
          typeof req.url !== "string" ||
          req.url.includes("?")
        ) {
          reply(res, { kind: "refused", code: "invalid" }, 404);
          return;
        }
        const path = req.url;
        if (
          ![LAN_PAIR_PATH, LAN_PAIR_RESUME_PATH, LAN_CHALLENGE_PATH, LAN_CARRIER_PATH].includes(
            path,
          )
        ) {
          reply(res, { kind: "refused", code: "invalid" }, 404);
          return;
        }
        const raw = await readJson(
          req,
          path === LAN_CARRIER_PATH ? LAN_MAX_WIRE_BYTES : 6 * 1024 * 1024,
        );
        if (path === LAN_PAIR_PATH) {
          const parsed = pairExchangeSchema.safeParse(raw);
          if (!parsed.success) {
            reply(res, { v: 1, kind: "closed", code: "invalid" }, 400);
            return;
          }
          const live = invites.get(parsed.data.session);
          if (!live || now() > (live.retireAt ?? live.expiresAt)) {
            reply(res, { v: 1, seq: parsed.data.seq, kind: "closed", code: "expired" });
            return;
          }
          reply(res, pairExchangeReplySchema.parse(await live.link.exchange(parsed.data)));
          return;
        }
        if (path === LAN_CHALLENGE_PATH) {
          const parsed = lanChallengeRequestSchema.safeParse(raw);
          if (!parsed.success) {
            reply(res, { v: 1, kind: "refused", code: "invalid" }, 400);
            return;
          }
          const known = input.vault(parsed.data.vault);
          if (
            challenges.size > 1024 ||
            !known ||
            !(await known.pairingKnown(
              parsed.data.device,
              parsed.data.purpose,
              parsed.data.session,
            ))
          ) {
            reply(res, { v: 1, kind: "refused", code: "unavailable" });
            return;
          }
          const nonce = randomBytes(32).toString("hex");
          const challenge: Challenge = {
            vault: parsed.data.vault,
            device: parsed.data.device,
            purpose: parsed.data.purpose,
            ...(parsed.data.session === undefined ? {} : { session: parsed.data.session }),
            expiresAt: now() + CHALLENGE_TTL,
          };
          challenges.set(nonce, challenge);
          reply(res, { v: 1, nonce, expiresAt: challenge.expiresAt });
          return;
        }
        if (path === LAN_CARRIER_PATH) {
          const parsed = lanCarrierRequestSchema.safeParse(raw);
          if (!parsed.success) {
            reply(res, { v: 1, kind: "refused", code: "invalid" }, 400);
            return;
          }
          const request = parsed.data;
          const challenge = challenges.get(request.auth.nonce);
          challenges.delete(request.auth.nonce);
          if (
            !challenge ||
            challenge.purpose !== "carrier" ||
            challenge.vault !== request.vault ||
            challenge.device !== request.device ||
            challenge.expiresAt < now()
          ) {
            reply(res, { v: 1, kind: "refused", code: "unauthorized" });
            return;
          }
          const vault = input.vault(request.vault);
          if (!vault) {
            reply(res, { v: 1, kind: "refused", code: "unavailable" });
            return;
          }
          let authorized = false;
          try {
            const result = await vault.carrierRequest(request, challenge.expiresAt, () => {
              authorized = true;
              authorizedCarrier += 1;
            });
            reply(res, lanCarrierReplySchema.parse(result));
          } finally {
            if (authorized) authorizedCarrier -= 1;
          }
          return;
        }
        const parsed = lanPairResumeSchema.safeParse(raw);
        if (!parsed.success) {
          reply(res, { v: 1, kind: "refused", code: "invalid" }, 400);
          return;
        }
        const request = parsed.data;
        const challenge = challenges.get(request.auth.nonce);
        challenges.delete(request.auth.nonce);
        const vault = input.vault(request.vault);
        if (
          !challenge ||
          challenge.purpose !== "resume" ||
          challenge.vault !== request.vault ||
          challenge.device !== request.device ||
          challenge.session !== request.session ||
          challenge.expiresAt < now() ||
          !vault
        ) {
          reply(res, { v: 1, kind: "refused", code: "unauthorized" });
          return;
        }
        const attempt = await vault.pairingAttempt(request.session);
        if (
          !attempt ||
          attempt.vault !== request.vault ||
          attempt.device !== request.device ||
          attempt.phase !== "completed" ||
          attempt.committedAt === undefined ||
          now() > attempt.committedAt + WELCOME_TTL
        ) {
          reply(res, { v: 1, kind: "refused", code: "expired" });
          return;
        }
        const body = lanAuthBody({
          purpose: "resume",
          path: LAN_PAIR_RESUME_PATH,
          method: "resume",
          vault: request.vault,
          device: request.device,
          session: request.session,
          nonce: request.auth.nonce,
          expiresAt: challenge.expiresAt,
        });
        const key = Buffer.from(attempt.signKey, "hex");
        if (
          !crypto.verifyContextSignature(
            "cashu/lan-auth/v1",
            body,
            Buffer.from(request.auth.signature, "hex"),
            key,
          ) ||
          !(await vault.pairingTrust(
            request.device,
            key,
            Buffer.from(attempt.boxKey, "hex"),
            Buffer.from(attempt.certificate, "hex"),
          ))
        ) {
          reply(res, { v: 1, kind: "refused", code: "unauthorized" });
          return;
        }
        if (attempt.welcome.length === 0) {
          reply(res, { v: 1, kind: "refused", code: "expired" });
          return;
        }
        const previous = invites.get(request.session);
        previous?.link.close();
        const link = new Exchange([attempt.welcome, ...attempt.pages]);
        invites.set(request.session, {
          vault: request.vault,
          operationId: attempt.operationId,
          link,
          expiresAt: attempt.committedAt + WELCOME_TTL,
          retireAt: attempt.committedAt + WELCOME_TTL,
          outcome: { kind: "completed", operationId: attempt.operationId, device: request.device },
        });
        reply(res, { v: 1, kind: "ready", firstSeq: 0 });
      })()
        .catch(() => {
          if (!res.headersSent) reply(res, { v: 1, kind: "refused", code: "unknown" }, 503);
        })
        .finally(() => {
          clearTimeout(deadline);
          inFlight -= 1;
        });
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(input.port, input.ip, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("lan_address_unavailable");
  const descriptor = tls.descriptor(address.port);
  const rendezvous = encodeLanDescriptor(descriptor, input.ip === "127.0.0.1");
  return {
    address: { ip: input.ip, port: address.port, spki: tls.spki },
    pending: () =>
      authorizedCarrier +
      (starting ? 1 : 0) +
      [...invites.values()].filter((item) => !item.outcome && now() <= item.expiresAt).length,
    async invite(vaultId) {
      prune();
      if (
        closed ||
        starting ||
        [...invites.values()].filter((item) => !item.outcome && now() <= item.expiresAt).length >=
          MAX_INVITES
      )
        return { kind: "refused", code: "busy" };
      starting = true;
      try {
        // One terminal receipt may remain in memory for a live joiner's final polls. A new
        // invitation releases it; committed bytes remain available through signed cold resume.
        for (const [session, terminal] of invites) {
          if (!terminal.outcome) continue;
          terminal.link.close();
          invites.delete(session);
        }
        const vault = input.vault(vaultId);
        if (!vault) return { kind: "refused", code: "unavailable" };
        const created = await vault.pairingStart(rendezvous);
        if (!created.ok)
          return {
            kind: "refused",
            code:
              created.reason === "capacity"
                ? "capacity"
                : created.reason === "not_trusted"
                  ? "not_trusted"
                  : "unavailable",
          };
        const { inviter, qr, authority } = created.value;
        if (closed) {
          inviter.reject();
          return { kind: "refused", code: "unavailable" };
        }
        const operationId = mintUlid(now());
        let registered = false;
        try {
          registered = await vault.pairingRegisterInvite(
            inviter.session,
            operationId,
            qr,
            inviter.invite.expiresAt,
          );
        } catch {
          // No QR was published; the ephemeral inviter must not remain usable.
        }
        if (!registered || closed) {
          inviter.reject();
          return { kind: "refused", code: "unavailable" };
        }
        const link = new Exchange();
        const live: LiveInvite = {
          vault: vaultId,
          operationId,
          link,
          expiresAt: inviter.invite.expiresAt,
        };
        invites.set(inviter.session, live);
        void devices
          .runInviter(inviter, link, {
            now,
            eid: () => mintUlid(now()),
            afterHello: async (joiner) => {
              if (!(await vault.pairingBindJoiner(inviter.session, joiner)))
                throw new Error("pairing_hello_unavailable");
            },
            enterCode: (attemptsLeft) =>
              new Promise((resolve) => {
                if (attemptsLeft <= 0) {
                  resolve(undefined);
                  return;
                }
                if (live.earlyCode !== undefined) {
                  const code = live.earlyCode;
                  live.earlyCode = undefined;
                  resolve(code);
                  return;
                }
                live.codeResult?.({ kind: "refused", code: "invalid" });
                live.codeResult = undefined;
                live.code = resolve;
              }),
            beforeWelcome: async (welcome) => {
              const outcome = await vault.pairingAppend({
                session: inviter.session,
                operationId,
                welcome,
                authority,
                qr,
                rendezvous,
              });
              if (outcome === "outcome_unknown")
                live.outcome = { kind: "outcome_unknown", operationId };
              if (outcome !== "completed") throw new Error("pairing_append_unavailable");
            },
          })
          .then(async (result) => {
            const persisted = await vault.pairingOperation(operationId);
            live.outcome =
              persisted?.phase === "completed"
                ? { kind: "completed", operationId, device: persisted.device }
                : persisted?.phase === "may_append"
                  ? { kind: "outcome_unknown", operationId }
                  : result.ok
                    ? { kind: "outcome_unknown", operationId }
                    : {
                        kind: "refused",
                        code: result.reason === "expired" ? "expired" : "invalid",
                      };
            live.retireAt = now() + WELCOME_TTL;
            live.codeResult?.(live.outcome);
            live.codeResult = undefined;
          })
          .catch(() => {
            live.outcome = { kind: "outcome_unknown", operationId };
            live.retireAt = now() + WELCOME_TTL;
            live.codeResult?.(live.outcome);
            live.codeResult = undefined;
          });
        return { kind: "ready", operationId, qr, expiresAt: inviter.invite.expiresAt };
      } finally {
        starting = false;
      }
    },
    confirm(vault, operationId, code) {
      const live = [...invites.values()].find(
        (item) => item.vault === vault && item.operationId === operationId,
      );
      if (!live || !/^[0-9]{6}$/.test(code))
        return Promise.resolve({ kind: "refused", code: "invalid" });
      if (live.outcome) return Promise.resolve(live.outcome);
      if (now() > live.expiresAt) return Promise.resolve({ kind: "refused", code: "unavailable" });
      if (live.codeResult || live.earlyCode !== undefined)
        return Promise.resolve({ kind: "refused", code: "busy" });
      live.dispatched = true;
      return new Promise((resolve) => {
        live.codeResult = resolve;
        const enter = live.code;
        live.code = undefined;
        if (enter) enter(code);
        else live.earlyCode = code;
      });
    },
    async inspect(vault, operationId) {
      const live = [...invites.values()].find(
        (item) => item.vault === vault && item.operationId === operationId,
      );
      if (!live) {
        const persisted = await input.vault(vault)?.pairingOperation(operationId);
        if (!persisted) return { kind: "refused", code: "invalid" };
        return {
          kind:
            persisted.phase === "completed"
              ? "completed"
              : persisted.phase === "not_started"
                ? "not_started"
                : "outcome_unknown",
          operationId,
        };
      }
      const persisted = await input.vault(vault)?.pairingOperation(operationId);
      if (persisted?.phase === "completed") return { kind: "completed", operationId };
      if (persisted?.phase === "may_append") return { kind: "outcome_unknown", operationId };
      if (live.outcome?.kind === "completed") return { kind: "completed", operationId };
      if (live.outcome?.kind === "outcome_unknown") return { kind: "outcome_unknown", operationId };
      if (live.outcome?.kind === "refused") return { kind: "not_started", operationId };
      return { kind: "pending", operationId };
    },
    async cancel(vault, operationId) {
      const live = [...invites.entries()].find(
        ([, item]) => item.vault === vault && item.operationId === operationId,
      );
      if (!live) return { kind: "refused" };
      const persisted = await input.vault(vault)?.pairingOperation(operationId);
      if (persisted || live[1].outcome || live[1].dispatched) return { kind: "refused" };
      live[1].code?.(undefined);
      live[1].codeResult?.({ kind: "refused", code: "invalid" });
      live[1].link.close();
      live[1].outcome = { kind: "refused", code: "invalid" };
      live[1].retireAt = now() + WELCOME_TTL;
      return { kind: "cancelled" };
    },
    async close() {
      closed = true;
      clearInterval(cleanup);
      for (const live of invites.values()) {
        live.code?.(undefined);
        live.link.close();
      }
      invites.clear();
      challenges.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
