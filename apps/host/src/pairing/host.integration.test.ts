import { createHash, X509Certificate } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { Agent, createServer, type RequestOptions, request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { connect } from "node:tls";
import {
  decodeLanDescriptor,
  LAN_CARRIER_PATH,
  LAN_CHALLENGE_PATH,
  LAN_PAIR_PATH,
  LAN_PAIR_RESUME_PATH,
  lanAuthBody,
  lanBytesDigest,
  lanCarrierReplySchema,
  lanPairResumeReplySchema,
  type PairExchangeReply,
  pairExchangeReplySchema,
} from "@cashu/host-protocol/pairing-lan";
import { connectHost } from "@cashu/node-host";
import { openNodeSqlite } from "@cashu/node-host/sqlite";
import {
  builtinModules,
  prepareCommand,
  renameProfile,
  Store,
  toUnstampedEvent,
  vaultSalt,
} from "@cashu/store";
import {
  createOwnLogCarrier,
  createOwnLogCodec,
  createSyncEngine,
  crypto,
  devices,
  MemoryClockStore,
  MemoryTransport,
  type Transport,
} from "@cashu/sync";
import { expect, it } from "vitest";
import { startLocalHost } from "../host.js";
import { nativeVaultFixture } from "../testing/nativeVaultFixture.js";
import { HostLanCarrier } from "./carrier.js";
import { loadLanTlsIdentity } from "./tls.js";

class PinnedAgent extends Agent {
  readonly #ip: string;
  readonly #pin: string;
  constructor(ip: string, pin: string) {
    super({ keepAlive: false });
    this.#ip = ip;
    this.#pin = pin;
  }
  override createConnection(
    _options: RequestOptions,
    callback?: (error: Error | null, stream: Duplex) => void,
  ): undefined {
    // The Agent does not give the request a socket until the same socket passes the pin check.
    const socket = connect({
      host: this.#ip,
      port: Number(_options.port),
      rejectUnauthorized: false,
    });
    let delivered = false;
    const finish = (error: Error | null) => {
      if (delivered) return;
      delivered = true;
      if (error) socket.destroy();
      callback?.(error, socket);
    };
    socket.once("error", finish);
    socket.once("secureConnect", () => {
      try {
        const certificate = new X509Certificate(socket.getPeerCertificate().raw);
        const actual = createHash("sha256")
          .update(certificate.publicKey.export({ format: "der", type: "spki" }))
          .digest("hex");
        if (
          certificate.checkIP(this.#ip) !== this.#ip ||
          actual !== this.#pin ||
          Date.parse(certificate.validFrom) > Date.now() ||
          Date.parse(certificate.validTo) <= Date.now()
        )
          throw new Error("pin_mismatch");
        finish(null);
      } catch (error) {
        finish(error as Error);
      }
    });
    return undefined;
  }
}

async function pinnedHost(ip: string, port: number, pin: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = connect({ host: ip, port, rejectUnauthorized: false });
    socket.once("error", reject);
    socket.once("secureConnect", () => {
      try {
        const raw = socket.getPeerCertificate().raw;
        const certificate = new X509Certificate(raw);
        const actual = createHash("sha256")
          .update(certificate.publicKey.export({ format: "der", type: "spki" }))
          .digest("hex");
        if (
          certificate.checkIP(ip) !== ip ||
          actual !== pin ||
          Date.parse(certificate.validTo) <= Date.now()
        )
          throw new Error("pin_mismatch");
        socket.end();
        resolve();
      } catch (error) {
        socket.destroy();
        reject(error);
      }
    });
  });
}

async function post(
  ip: string,
  port: number,
  pin: string,
  body: unknown,
  path = LAN_PAIR_PATH,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const bytes = Buffer.from(JSON.stringify(body));
    const req = request(
      {
        hostname: ip,
        port,
        path,
        method: "POST",
        agent: new PinnedAgent(ip, pin),
        headers: { "content-type": "application/json", "content-length": bytes.length },
      },
      (res) => {
        const parts: Buffer[] = [];
        res.on("data", (part: Buffer) => parts.push(part));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.once("error", reject);
    req.end(bytes);
  });
}

class LocalPairLink implements devices.PairingLink {
  readonly #ip: string;
  readonly #port: number;
  readonly #pin: string;
  readonly #session: string;
  #seq = 0;
  readonly #inbox: Uint8Array[] = [];

  constructor(ip: string, port: number, pin: string, session: string) {
    this.#ip = ip;
    this.#port = port;
    this.#pin = pin;
    this.#session = session;
  }

  async #exchange(kind: "send" | "poll", body?: Uint8Array): Promise<void> {
    const seq = this.#seq++;
    const raw = await post(this.#ip, this.#port, this.#pin, {
      v: 1,
      session: this.#session,
      seq,
      kind,
      ...(body === undefined ? {} : { body: Buffer.from(body).toString("base64url") }),
    });
    const result: PairExchangeReply = pairExchangeReplySchema.parse(raw);
    if (result.seq !== seq || result.kind === "closed") throw new Error("pairing_exchange_closed");
    if (result.kind === "message") this.#inbox.push(Buffer.from(result.body ?? "", "base64url"));
  }

  send(value: Uint8Array): Promise<void> {
    return this.#exchange("send", value);
  }
  async receive(): Promise<Uint8Array> {
    while (this.#inbox.length === 0) await this.#exchange("poll");
    return this.#inbox.shift()!;
  }
}

/** Node localhost counterpart to the mobile native pinned request; same v1 signed wire. */
function phoneCarrier(
  ip: string,
  port: number,
  pin: string,
  vault: string,
  identity: crypto.DeviceIdentity,
): Transport {
  const ask = async (
    method: "list" | "read" | "append",
    writer?: string,
    seg?: number,
    offset?: number,
    bytes?: Uint8Array,
  ) => {
    const challenge = (await post(
      ip,
      port,
      pin,
      { v: 1, vault, device: identity.deviceId, purpose: "carrier" },
      LAN_CHALLENGE_PATH,
    )) as { nonce: string; expiresAt: number };
    const signature = Buffer.from(
      identity.sign(
        "cashu/lan-auth/v1",
        lanAuthBody({
          purpose: "carrier",
          path: LAN_CARRIER_PATH,
          method,
          vault,
          device: identity.deviceId,
          writer,
          seg,
          offset,
          bytesDigest: bytes ? lanBytesDigest(bytes) : undefined,
          nonce: challenge.nonce,
          expiresAt: challenge.expiresAt,
        }),
      ),
    ).toString("hex");
    const result = lanCarrierReplySchema.parse(
      await post(
        ip,
        port,
        pin,
        {
          v: 1,
          method,
          vault,
          device: identity.deviceId,
          writer,
          seg,
          offset,
          bytes: bytes ? Buffer.from(bytes).toString("base64url") : undefined,
          auth: { v: 1, vault, device: identity.deviceId, nonce: challenge.nonce, signature },
        },
        LAN_CARRIER_PATH,
      ),
    );
    if (result.kind === "refused") throw new Error(`carrier_${result.code}`);
    return result;
  };
  return {
    consistency: { kind: "eventual" },
    async list(id) {
      if (id !== vault) throw new Error("wrong_vault");
      const result = await ask("list");
      if (result.kind !== "list") throw new Error("wrong_reply");
      return result.segments.map(({ writer, seg, size }) => ({ device: writer, seg, size }));
    },
    async read(id, writer, seg, offset) {
      if (id !== vault) throw new Error("wrong_vault");
      const result = await ask("read", writer, seg, offset);
      if (result.kind !== "read") throw new Error("wrong_reply");
      return Buffer.from(result.bytes, "base64url");
    },
    async append(id, writer, seg, offset, bytes) {
      if (id !== vault) throw new Error("wrong_vault");
      const result = await ask("append", writer, seg, offset, bytes);
      if (
        result.kind !== "append" ||
        result.size !== offset + bytes.length ||
        result.digest !== lanBytesDigest(bytes)
      )
        throw new Error("wrong_receipt");
    },
  };
}

it("withholds every request byte when the actual HTTPS socket has the wrong pin", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cashu-pin-barrier-"));
  const tls = await loadLanTlsIdentity(dir, "127.0.0.1");
  let requests = 0;
  const server = createServer({ key: tls.key, cert: tls.cert }, (req, res) => {
    requests += 1;
    req.resume();
    res.end("{}");
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("address_unavailable");
    await expect(
      post("127.0.0.1", address.port, "f".repeat(64), {
        v: 1,
        deliberatelySensitiveSyntheticBody: "withheld",
      }),
    ).rejects.toThrow("pin_mismatch");
    expect(requests).toBe(0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

it("pairs through the real native host composition and mirrors initial encrypted history before welcome", async () => {
  const fixture = await nativeVaultFixture();
  const host = await startLocalHost({
    dataDir: fixture.dataDir,
    home: fixture.home,
    vaultSource: fixture.vaultSource,
    launcher: false,
    python: null,
    lan: { kind: "loopback", port: 0 },
  });
  const ui = await connectHost({ dataDir: fixture.dataDir, role: "ui", build: "pairing-test" });
  const phone = crypto.createDeviceIdentity(fixture.vaultSource.provider.sodium);
  try {
    expect(host.lan).toBeUndefined(); // No listener until the owner's invite action.
    const response = (await ui.call("native.pairing.invite", { vault: fixture.vaultId })) as {
      kind: string;
      qr?: string;
      operationId?: string;
    };
    expect(response.kind).toBe("ready");
    if (!response.qr || !response.operationId || !host.lan) throw new Error("invite_unavailable");
    const encoded = devices.decodeInvite(response.qr);
    const descriptor = encoded?.rendezvous
      ? decodeLanDescriptor(encoded.rendezvous, true)
      : undefined;
    if (!descriptor) throw new Error("descriptor_unavailable");
    expect(host.lan.address.port).toBe(descriptor.port);
    await pinnedHost(descriptor.ip, descriptor.port, descriptor.spki);
    const started = devices.PairingJoiner.start(
      {
        sodium: fixture.vaultSource.provider.sodium,
        identity: phone,
        name: "Synthetic phone",
      },
      response.qr,
      Date.now(),
    );
    if (!started.ok) throw new Error(started.reason);
    const link = new LocalPairLink(
      descriptor.ip,
      descriptor.port,
      descriptor.spki,
      started.value.joiner.session,
    );
    let confirmed: Promise<unknown> | undefined;
    const result = await devices.runJoiner(started.value.joiner, started.value.hello, link, {
      now: Date.now,
      showSas(code) {
        confirmed = host.lan!.confirm(fixture.vaultId, response.operationId!, code);
      },
    });
    expect(result.ok).toBe(true);
    expect(await confirmed).toMatchObject({ kind: "completed", device: phone.deviceId });
    const pairedVault = host.stores.vaults.get(fixture.vaultId)?.native;
    expect(pairedVault?.isCurrent()).toBe(true);
    expect(await pairedVault?.pairingKnown(phone.deviceId, "carrier")).toBe(true);
    const carrier = new HostLanCarrier(join(fixture.dataDir, "lan-carrier"));
    const initial = await carrier.list(fixture.vaultId);
    expect(
      initial.some(
        (part) =>
          part.device === fixture.vaultSource.provider.inventory[0]?.deviceId && part.size > 0,
      ),
    ).toBe(true);
    expect((await host.lan.inspect(fixture.vaultId, response.operationId)).kind).toBe("completed");
    if (result.ok) {
      const welcome = result.value;
      const ring = welcome.ring;
      const history = devices.recoveryHistory(
        fixture.vaultId,
        ring.recovery,
        welcome.registryEvents,
      );
      const authority = new devices.VaultDevices({
        sodium: fixture.vaultSource.provider.sodium,
        identity: phone,
        ring,
        provenance: new devices.MemoryProvenanceStore(),
        clock: Date.now,
        bootstrapCertificates: [welcome.certificate, ...history.certificates],
      });
      const gate = new devices.DeviceFrameGate(authority, {
        sodium: fixture.vaultSource.provider.sodium,
      });
      const saltKey = ring.gidSalt();
      const salt = vaultSalt(saltKey.expose().slice());
      saltKey.wipe();
      const phoneStore = Store.open({
        driver: openNodeSqlite(":memory:"),
        vault: fixture.vaultId,
        salt,
        modules: builtinModules(),
      });
      const codec = createOwnLogCodec({
        sodium: fixture.vaultSource.provider.sodium,
        ring,
        signer: phone,
      });
      const phoneEngine = await createSyncEngine({
        vault: fixture.vaultId,
        device: phone.deviceId,
        local: new MemoryTransport(),
        remotes: [
          createOwnLogCarrier({
            transport: phoneCarrier(
              descriptor.ip,
              descriptor.port,
              descriptor.spki,
              fixture.vaultId,
              phone,
            ),
            codec,
            gate,
            device: phone.deviceId,
          }),
        ],
        codec,
        gate,
        sink: phoneStore.sink(),
        clockStore: new MemoryClockStore(),
        physicalClock: { now: Date.now },
      });
      try {
        const pulled = await phoneEngine.sync();
        expect(pulled.offlineRemotes).toBe(0);
        expect(pulled.rejected).toEqual([]);
        expect(phoneStore.read<{ name: string }>("SELECT name FROM profiles")[0]?.name).toBe(
          "Synthetic",
        );
        const env = {
          device: phone.deviceId,
          clock: { now: Date.now },
          lease: { isHolder: () => true },
        };
        const phoneEdit = prepareCommand(phoneStore, renameProfile, { name: "Phone edit" }, env);
        if (!phoneEdit.ok) throw new Error(phoneEdit.reason);
        await phoneEngine.write(phoneEdit.events.map(toUnstampedEvent));
        const pushed = await phoneEngine.sync();
        expect(pushed.offlineRemotes).toBe(0);
        const hostVault = host.stores.vaults.get(fixture.vaultId);
        if (!hostVault || hostVault.mode !== "native") throw new Error("host_vault_missing");
        expect(
          hostVault.native.store.read<{ name: string }>("SELECT name FROM profiles")[0]?.name,
        ).toBe("Phone edit"); // Carrier append pulled through the actual host engine.
        await hostVault.native.queue.run(async () => {
          const hostEdit = prepareCommand(
            hostVault.native.store,
            renameProfile,
            { name: "Host edit" },
            hostVault.env,
          );
          if (!hostEdit.ok) throw new Error(hostEdit.reason);
          await hostVault.native.engine.write(hostEdit.events.map(toUnstampedEvent));
        });
        await host.syncVault(fixture.vaultId);
        const returned = await phoneEngine.sync();
        expect(returned.offlineRemotes).toBe(0);
        expect(returned.rejected).toEqual([]);
        expect(phoneStore.read<{ name: string }>("SELECT name FROM profiles")[0]?.name).toBe(
          "Host edit",
        );
      } finally {
        await phoneEngine.close();
        phoneStore.close();
        ring.wipe();
      }
      const next = (await ui.call("native.pairing.invite", { vault: fixture.vaultId })) as {
        kind: string;
        operationId?: string;
      };
      expect(next.kind).toBe("ready");
      if (next.operationId) {
        expect(
          await ui.call("native.pairing.cancel", {
            vault: fixture.vaultId,
            operationId: next.operationId,
          }),
        ).toMatchObject({ kind: "cancelled" });
      }
    }
  } finally {
    phone.wipe();
    ui.close();
    await host.stop();
    fixture.cleanup();
  }
});

it("retrieves the exact committed welcome with the same staged identity after response loss and cold host restart", async () => {
  const fixture = await nativeVaultFixture();
  const phone = crypto.createDeviceIdentity(fixture.vaultSource.provider.sodium);
  let host = await startLocalHost({
    dataDir: fixture.dataDir,
    home: fixture.home,
    vaultSource: fixture.vaultSource,
    launcher: false,
    python: null,
    lan: { kind: "loopback", port: 0 },
  });
  let ui = await connectHost({ dataDir: fixture.dataDir, role: "ui", build: "pairing-test" });
  try {
    const response = (await ui.call("native.pairing.invite", { vault: fixture.vaultId })) as {
      kind: string;
      qr?: string;
      operationId?: string;
    };
    if (response.kind !== "ready" || !response.qr || !response.operationId)
      throw new Error("invite_unavailable");
    const invite = devices.decodeInvite(response.qr);
    const descriptor = invite?.rendezvous
      ? decodeLanDescriptor(invite.rendezvous, true)
      : undefined;
    if (!descriptor) throw new Error("descriptor_unavailable");
    await pinnedHost(descriptor.ip, descriptor.port, descriptor.spki);
    const started = devices.PairingJoiner.start(
      {
        sodium: fixture.vaultSource.provider.sodium,
        identity: phone,
        name: "Synthetic phone",
      },
      response.qr,
      Date.now(),
    );
    if (!started.ok) throw new Error(started.reason);
    const link = new LocalPairLink(
      descriptor.ip,
      descriptor.port,
      descriptor.spki,
      started.value.joiner.session,
    );
    await link.send(started.value.hello);
    const challenge = started.value.joiner.receiveChallenge(await link.receive(), Date.now());
    if (!challenge.ok) throw new Error(challenge.reason);
    const snapshot = started.value.joiner.snapshotPending();
    if (!snapshot) throw new Error("snapshot_unavailable");
    const confirmed = host.lan!.confirm(fixture.vaultId, response.operationId, challenge.value.sas);
    await link.send(challenge.value.reply);
    expect(await confirmed).toMatchObject({ kind: "completed", device: phone.deviceId });
    // The client loses the response here. It retains its exact sealed pending snapshot and identity.
    ui.close();
    await host.stop();
    host = await startLocalHost({
      dataDir: fixture.dataDir,
      home: fixture.home,
      vaultSource: fixture.vaultSource,
      launcher: false,
      python: null,
      lan: { kind: "loopback", port: descriptor.port },
    });
    expect(host.lan).toBeDefined(); // Completed trusted pairing is the persisted serving opt-in.
    ui = await connectHost({ dataDir: fixture.dataDir, role: "ui", build: "pairing-test" });
    const address = host.lan!.address;
    expect(address).toMatchObject({
      ip: descriptor.ip,
      port: descriptor.port,
      spki: descriptor.spki,
    });
    await pinnedHost(descriptor.ip, descriptor.port, descriptor.spki);
    const restored = devices.PairingJoiner.restorePending(
      {
        sodium: fixture.vaultSource.provider.sodium,
        identity: phone,
        name: "Synthetic phone",
      },
      snapshot,
      Date.now(),
    );
    if (!restored.ok) throw new Error(restored.reason);
    const rawChallenge = (await post(
      descriptor.ip,
      descriptor.port,
      descriptor.spki,
      {
        v: 1,
        vault: fixture.vaultId,
        device: phone.deviceId,
        purpose: "resume",
        session: restored.value.session,
      },
      LAN_CHALLENGE_PATH,
    )) as {
      v: 1;
      nonce: string;
      expiresAt: number;
    };
    const signature = Buffer.from(
      phone.sign(
        "cashu/lan-auth/v1",
        lanAuthBody({
          purpose: "resume",
          path: LAN_PAIR_RESUME_PATH,
          method: "resume",
          vault: fixture.vaultId,
          device: phone.deviceId,
          session: restored.value.session,
          nonce: rawChallenge.nonce,
          expiresAt: rawChallenge.expiresAt,
        }),
      ),
    ).toString("hex");
    const resumed = lanPairResumeReplySchema.parse(
      await post(
        descriptor.ip,
        descriptor.port,
        descriptor.spki,
        {
          v: 1,
          session: restored.value.session,
          vault: fixture.vaultId,
          device: phone.deviceId,
          auth: {
            v: 1,
            vault: fixture.vaultId,
            device: phone.deviceId,
            nonce: rawChallenge.nonce,
            signature,
          },
        },
        LAN_PAIR_RESUME_PATH,
      ),
    );
    expect(resumed.kind).toBe("ready");
    const replay = new LocalPairLink(
      descriptor.ip,
      descriptor.port,
      descriptor.spki,
      restored.value.session,
    );
    let progress = restored.value.receiveWelcome(await replay.receive());
    while (progress.ok && !progress.value.done)
      progress = restored.value.receivePage(await replay.receive());
    expect(progress.ok && progress.value.done).toBe(true);
    if (progress.ok && progress.value.done) progress.value.welcome.ring.wipe();
    const listed = (await ui.call("native.devices.list", { vault: fixture.vaultId })) as {
      kind: string;
      devices?: { id: string }[];
    };
    expect(listed.devices?.filter((device) => device.id === phone.deviceId)).toHaveLength(1);
    expect((await host.lan!.inspect(fixture.vaultId, response.operationId)).kind).toBe("completed");
  } finally {
    phone.wipe();
    ui.close();
    await host.stop();
    fixture.cleanup();
  }
});
