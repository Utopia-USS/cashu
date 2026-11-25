// First-sync cost on the phone's code path (opt-in measurement, not a gate). A Mac-like device imports a
// synthetic 20,000-row mBank statement (the shape of the M4 real-project run: card payments at 400
// synthetic shops, a monthly salary, one account), pushes it to the fake relay, and a phone paired through
// the real protocol runs its first sync through `createVaultSession` with the phone's store configuration
// (`companionReads: true`, file databases on better-sqlite3 with the phone's pragmas, the session's batch
// size and yielding sink, libsodium-wrappers as the stand-in for the native verifier). Prints one
// `FIRSTSYNC {...}` line: time per phase (relay reads, sink transactions, each deriver, the materializers,
// signature verifies, the replay after the pass) on V8. Hermes is slower (see the performance reference).
//
//   CASHU_FIRSTSYNC_BENCH=1 [CASHU_FIRSTSYNC_ROWS=20000] [CASHU_FIRSTSYNC_SPLIT=month] pnpm --filter @cashu/mobile exec jest \
//     src/services/vaultEngine.firstsync.measure.test.ts
//
// Skipped unless CASHU_FIRSTSYNC_BENCH=1, so the default tier never runs it. Synthetic data only.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { budget, core } from "@cashu/domain";
import {
  betterSqlite3Driver,
  builtinModules,
  createProfile,
  importStatement,
  prepareCommand,
  Store,
  type StoreModule,
  toUnstampedEvent,
  vaultSalt,
} from "@cashu/store";
import {
  initializeMetaClockGuard,
  loadDeviceAuthority,
  metaClockGuardStore,
  metaClockStore,
  metaGateStateStore,
  mintUlid,
  type SqlDriver,
  SqlProvenanceStore,
} from "@cashu/store/sync";
import {
  AnonymousAuth,
  createOwnLogCodec,
  createSyncEngine,
  crypto,
  devices,
  FirestoreRest,
  FirestoreTransport,
  type Transport,
} from "@cashu/sync";
import {
  createFakeFirebase,
  type FakeFirebase,
  MemoryAuthStore,
  MemoryTransport,
} from "@cashu/sync/testing/firestore";
import Database from "better-sqlite3";
import { memoryKeyStore, runtime } from "../selftest/testing/runtime";
import { createVaultQueue } from "./commandQueue";
import { storeJoinedVault } from "./vaultBootstrap";
import { createVaultSession } from "./vaultEngine";

const ENABLED = process.env.CASHU_FIRSTSYNC_BENCH === "1";
const ROWS = Number(process.env.CASHU_FIRSTSYNC_ROWS ?? 20_000);
const SPLIT = process.env.CASHU_FIRSTSYNC_SPLIT === "month";
const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** The run's generator (`~/cashu-lab/m4-real-run/gen-mbank.mjs`): a synthetic mBank statement, UTF-8. */
function syntheticMbank(n: number): Uint8Array {
  let seed = 42;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const start = Date.UTC(2021, 10, 15);
  const end = Date.UTC(2026, 10, 14);
  const days = Math.round((end - start) / 864e5) + 1;
  const perDay = n / days;
  const pl = (c: number) => {
    const [a, b] = (Math.abs(c) / 100).toFixed(2).split(".") as [string, string];
    return `${c < 0 ? "-" : ""}${a.replace(/\B(?=(\d{3})+(?!\d))/g, " ")},${b}`;
  };
  let bal = 2_000_000;
  const open = bal;
  let cr = 0;
  let db = 0;
  const rows: string[] = [];
  let i = 0;
  for (let d = 0; d < days && i < n; d++) {
    const ds = new Date(start + d * 864e5).toISOString().slice(0, 10);
    let k = Math.floor(perDay) + (rnd() < perDay % 1 ? 1 : 0);
    if (d === days - 1) k = n - i;
    for (let j = 0; j < k && i < n; j++, i++) {
      if (ds.endsWith("-10") && j === 0) {
        const amt = 900_000;
        bal += amt;
        cr += amt;
        rows.push(
          `${ds};${ds};PRZELEW PRZYCHODZĄCY;"WYNAGRODZENIE TEST ${ds.slice(0, 7)}";"PRACODAWCA TEST SP. Z O.O.";'99102000000000000000009902';${pl(amt)};${pl(bal)};`,
        );
      } else {
        const m = String(1 + Math.floor(rnd() * 400)).padStart(4, "0");
        const amt = -(100 + Math.floor(rnd() * 4500));
        bal += amt;
        db += amt;
        rows.push(
          `${ds};${ds};ZAKUP PRZY UŻYCIU KARTY;"SKLEP TEST ${m}/MIASTO TEST   DATA TRANSAKCJI: ${ds}";"";'';${pl(amt)};${pl(bal)};`,
        );
      }
    }
  }
  const head = [
    "mBank S.A. Bankowość Detaliczna;",
    "",
    "#Klient;",
    "KLIENT TESTOWY;",
    "",
    "Elektroniczne zestawienie operacji za okres od 2021-11-15 do 2026-11-14;",
    "",
    "#Za okres:;",
    "2021-11-15;2026-11-14;",
    "",
    "#Rodzaj rachunku;",
    "eKonto;",
    "",
    "#Waluta;",
    "PLN;",
    "",
    "#Numer rachunku;",
    "99 1140 0000 0000 0000 0000 9901;",
    "",
    "#Saldo początkowe;#Uznania;#Obciążenia;",
    `${pl(open)};${pl(cr)};${pl(db)};`,
    "",
    "#Data księgowania;#Data operacji;#Opis operacji;#Tytuł;#Nadawca/Odbiorca;#Numer konta;#Kwota;#Saldo po operacji;",
  ];
  const text = [...head, ...rows, `;;;;;;#Saldo końcowe;${pl(bal)};`, ""].join("\r\n");
  return new TextEncoder().encode(text);
}

/** Wall-clock accumulators by phase name. */
class Clock {
  readonly ms = new Map<string, number>();
  readonly calls = new Map<string, number>();
  add(name: string, ms: number) {
    this.ms.set(name, (this.ms.get(name) ?? 0) + ms);
    this.calls.set(name, (this.calls.get(name) ?? 0) + 1);
  }
  time<T>(name: string, fn: () => T): T {
    const t0 = performance.now();
    try {
      return fn();
    } finally {
      this.add(name, performance.now() - t0);
    }
  }
  async timeAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const t0 = performance.now();
    try {
      return await fn();
    } finally {
      this.add(name, performance.now() - t0);
    }
  }
  report(): Record<string, { ms: number; calls: number }> {
    return Object.fromEntries(
      [...this.ms].map(([k, v]) => [k, { ms: Math.round(v), calls: this.calls.get(k) ?? 0 }]),
    );
  }
}

/** The builtin modules with every deriver's `derive` / `deriveAll` timed (same ids and versions). */
function timedModules(clock: Clock): StoreModule[] {
  return builtinModules().map((m) =>
    m.derivers === undefined
      ? m
      : {
          ...m,
          derivers: m.derivers.map((d) => ({
            ...d,
            derive: (dirty, ctx) => clock.time(`derive ${d.id}`, () => d.derive(dirty, ctx)),
            deriveAll: (ctx) => clock.time(`deriveAll ${d.id}`, () => d.deriveAll(ctx)),
          })),
        },
  );
}

function timedTransport(remote: Transport, clock: Clock): Transport {
  return {
    consistency: remote.consistency,
    list: (vault) => clock.timeAsync("relay list", () => remote.list(vault)),
    read: (vault, device, seg, from) =>
      clock.timeAsync("relay read", () => remote.read(vault, device, seg, from)),
    append: (vault, device, seg, at, bytes) => remote.append(vault, device, seg, at, bytes),
  };
}

function relayTransport(fake: FakeFirebase): FirestoreTransport {
  const auth = new AnonymousAuth({
    endpoint: fake.identity,
    store: new MemoryAuthStore(),
    fetch: fake.fetch,
  });
  const rest = new FirestoreRest({ endpoint: fake.endpoint, auth, fetch: fake.fetch });
  return new FirestoreTransport({ rest, uid: () => auth.uid() });
}

function fileDriver(path: string, synchronous: "NORMAL" | "FULL"): SqlDriver {
  const db = new Database(path);
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = ${synchronous}`);
  return betterSqlite3Driver(db);
}

function gidSaltOf(ring: crypto.Keyring): Uint8Array {
  const salt = ring.gidSalt();
  try {
    return salt.expose().slice();
  } finally {
    salt.wipe();
  }
}

(ENABLED ? describe : describe.skip)("first sync cost (opt-in measurement)", () => {
  it("measures the phone's first sync of a synthetic mBank import", async () => {
    const lib = await runtime();
    const sodium = crypto.fromLibsodium(lib, { aead: "noble" });
    const clock = new Clock();
    const native = crypto.libsodiumEd25519Verifier(lib as unknown as crypto.LibsodiumSignLike);
    const previous = crypto.bindEd25519Verifier({
      kind: native.kind,
      verify: (signature, message, publicKey) =>
        clock.time("ed25519 verify", () => native.verify(signature, message, publicKey)),
    });
    const dir = mkdtempSync(join(tmpdir(), "cashu-firstsync-"));
    try {
      const fake = createFakeFirebase();
      const now = () => Date.now();
      const eid = () => mintUlid(now(), (n) => sodium.randomBytes(n));

      // ---- the Mac: create the vault, import the statement, push -----------------------------------
      const recovery = crypto.recoveryIdentity(sodium, crypto.createRecoveryKey(sodium).phrase);
      const identity = crypto.createDeviceIdentity(sodium);
      const created = crypto.createVaultWithRecovery(sodium, recovery, identity);
      const vault = created.ring.vaultId;
      const macKeys = memoryKeyStore(sodium);
      await crypto.saveDeviceIdentity(macKeys, identity);
      await crypto.saveKeyring(macKeys, created.ring);
      const provenance = SqlProvenanceStore.open(
        betterSqlite3Driver(new Database(":memory:")),
        created.ring,
        "new",
      );
      provenance.put({
        kid: created.ring.active.kid,
        generation: created.ring.active.generation,
        epoch: created.ring.active.epoch,
        sender: identity.deviceId,
        recipients: null,
        source: "own",
        receivedAt: now(),
      });
      const macStore = Store.open({
        driver: fileDriver(join(dir, "mac-view.db"), "NORMAL"),
        vault,
        salt: vaultSalt(gidSaltOf(created.ring)),
        modules: builtinModules(),
      });
      initializeMetaClockGuard(macStore.driver, identity.deviceId);
      const mac = await loadDeviceAuthority({
        vaultId: vault,
        deviceId: identity.deviceId,
        keyStore: macKeys,
        sodium,
        provenance,
        clock: now,
        bootstrapCertificates: [created.creatorCertificate],
      });
      const macEngine = await createSyncEngine({
        vault,
        device: identity.deviceId,
        local: new MemoryTransport(),
        remotes: [relayTransport(fake)],
        codec: createOwnLogCodec({ sodium, ring: mac.ring, signer: mac.identity }),
        gate: mac.gate,
        sink: macStore.sink(),
        clockStore: metaClockStore(macStore.driver, identity.deviceId),
        clockGuard: metaClockGuardStore(macStore.driver, identity.deviceId),
        gateState: metaGateStateStore(macStore.driver, identity.deviceId),
        gossipEid: eid,
      });
      await macEngine.write([
        devices.buildDeviceAdded(
          mac.identity,
          vault,
          eid(),
          {
            deviceId: identity.deviceId,
            signPublicKey: identity.signPublicKey,
            boxPublicKey: identity.box.publicKey,
          },
          "Mac",
          created.creatorCertificate,
        ),
        devices.creatorPin(mac.identity, recovery, vault, eid(), now()),
      ]);
      const env = { device: identity.deviceId, clock: { now }, lease: { isHolder: () => true } };
      const write = async (command: typeof createProfile, input: unknown) => {
        const prepared = prepareCommand(macStore, command, input, env);
        if (!prepared.ok) throw new Error(prepared.reason);
        await macEngine.write(prepared.events.map(toUnstampedEvent));
      };
      await write(createProfile, {
        slug: "demo-anna",
        name: "Anna",
        baseCurrency: "PLN",
        modules: ["budget"],
      });
      const parsed = budget.parseStatementFile(
        syntheticMbank(ROWS),
        core.builtinRegistry().institutions,
        "mbank",
      );
      if (!parsed.ok) throw new Error(`parse: ${parsed.reason}`);
      // One import (the run's shape) or one per month (CASHU_FIRSTSYNC_SPLIT=month: a log built by
      // monthly statements, so the phone's batches cut through it).
      const statement = parsed.statement;
      const months = SPLIT
        ? [...new Set(statement.transactions.map((t) => t.bookingDate.slice(0, 7)))].sort()
        : [undefined];
      const t0 = performance.now();
      for (const month of months) {
        const inMonth = (date: string) => month === undefined || date.startsWith(month);
        await write(importStatement as unknown as typeof createProfile, {
          statement: {
            ...statement,
            transactions: statement.transactions.filter((t) => inMonth(t.bookingDate)),
            balances: statement.balances.filter((b) => inMonth(b.date)),
            closingBalances: statement.closingBalances.filter((b) => inMonth(b.date)),
          },
          source: "csv",
          filename: `synthetic-${month ?? "all"}.csv`,
          newestDayRule: false,
        });
      }
      const macImportMs = performance.now() - t0;
      await macEngine.sync();
      const macEvents = macStore.read<{ n: number }>("SELECT COUNT(*) AS n FROM transactions")[0]
        ?.n;
      expect(macEvents).toBe(ROWS);
      const relayList = await relayTransport(fake).list(vault);
      const relayBytes = relayList.reduce((n, s) => n + s.size, 0);

      // ---- pairing (the real protocol), the welcome kept like the services do -----------------------
      const phoneIdentity = crypto.createDeviceIdentity(sodium);
      const invite = devices.PairingInviter.create({
        sodium,
        identity: mac.identity,
        ring: mac.ring,
        registry: mac.devices.registry,
        now: now(),
      });
      if (!invite.ok) throw new Error(invite.reason);
      const started = devices.PairingJoiner.start(
        { sodium, identity: phoneIdentity, name: "iPhone" },
        invite.value.qr,
        now(),
      );
      if (!started.ok) throw new Error(started.reason);
      const toInviter: Uint8Array[] = [];
      const toJoiner: Uint8Array[] = [];
      const waitInviter: ((m: Uint8Array) => void)[] = [];
      const waitJoiner: ((m: Uint8Array) => void)[] = [];
      const push = (items: Uint8Array[], waits: ((m: Uint8Array) => void)[], m: Uint8Array) => {
        const next = waits.shift();
        if (next) next(m);
        else items.push(m);
      };
      const take = (items: Uint8Array[], waits: ((m: Uint8Array) => void)[]) => {
        const item = items.shift();
        return item ? Promise.resolve(item) : new Promise<Uint8Array>((r) => waits.push(r));
      };
      let sas: string | undefined;
      const [inv, join_] = await Promise.all([
        devices.runInviter(
          invite.value.inviter,
          {
            send: async (m) => push(toJoiner, waitJoiner, m),
            receive: () => take(toInviter, waitInviter),
          },
          { now, enterCode: async () => sas, eid },
        ),
        devices.runJoiner(
          started.value.joiner,
          started.value.hello,
          {
            send: async (m) => push(toInviter, waitInviter, m),
            receive: () => take(toJoiner, waitJoiner),
          },
          {
            now,
            showSas: (code) => {
              sas = code;
            },
          },
        ),
      ]);
      if (!inv.ok || !join_.ok) throw new Error("pairing failed");
      await macEngine.write([inv.value.deviceAdded]);
      await macEngine.sync();

      const keyStore = memoryKeyStore(sodium);
      const log = fileDriver(join(dir, "phone-log.db"), "FULL");
      await storeJoinedVault(
        keyStore,
        log,
        {
          identity: phoneIdentity,
          ring: join_.value.ring,
          certificate: join_.value.certificate,
          registryEvents: join_.value.registryEvents,
          inviter: identity.deviceId,
        },
        now,
      );

      // ---- the phone: its store configuration, timed ------------------------------------------------
      const store = Store.open({
        driver: fileDriver(join(dir, "phone-view.db"), "NORMAL"),
        vault,
        salt: vaultSalt(gidSaltOf(join_.value.ring)),
        modules: timedModules(clock),
        companionReads: true,
      });
      const sink = store.sink.bind(store);
      let applied = 0;
      store.sink = (): ReturnType<Store["sink"]> => {
        const inner = sink();
        return {
          ...inner,
          cursors: () => inner.cursors(),
          reset: () => inner.reset(),
          applyBatches: async (batches, options) => {
            applied += batches.reduce((n, b) => n + b.events.length, 0);
            return clock.timeAsync("sink applyBatches", async () =>
              inner.applyBatches(batches, options),
            );
          },
          ...(inner.needsUpgrade ? { needsUpgrade: inner.needsUpgrade.bind(inner) } : {}),
        };
      };
      const relay = timedTransport(relayTransport(fake), clock);
      const session = createVaultSession({
        vault,
        device: phoneIdentity.deviceId,
        kind: "paired",
        sodium,
        remotes: [relay],
        queue: createVaultQueue(),
        now,
        yieldToUi: () => clock.timeAsync("yield to UI", yieldToUi),
        store,
        log,
        keyStore,
      });
      const timeline: { t: number; what: string }[] = [];
      const begin = performance.now();
      let lastPhase: string | undefined;
      let lastDone = -1;
      let replayStarted: number | undefined;
      // Each audit after the pass is one run of `replay` from 0 (done falling again starts another).
      const audits: { start: number; end?: number; total: number }[] = [];
      session.subscribe(() => {
        const s = session.status();
        const t = Math.round(performance.now() - begin);
        if (s.replay !== undefined) {
          if (replayStarted === undefined || s.replay.done < lastDone) {
            const prev = audits.at(-1);
            if (prev !== undefined && prev.end === undefined) prev.end = t;
            audits.push({ start: t, total: s.replay.total });
            replayStarted = t;
          }
          lastDone = s.replay.done;
        }
        if (s.replay === undefined && replayStarted !== undefined) {
          const prev = audits.at(-1);
          if (prev !== undefined && prev.end === undefined) prev.end = t;
          replayStarted = undefined;
          lastDone = -1;
        }
        if (s.progress !== undefined && s.progress.phase !== lastPhase) {
          lastPhase = s.progress.phase;
          timeline.push({ t, what: `${lastPhase} ${s.progress.done}/${s.progress.total}` });
        }
      });
      await session.opened;
      timeline.push({
        t: Math.round(performance.now() - begin),
        what: `open ${session.status().phase}`,
      });
      const passStart = performance.now();
      await session.pass("full");
      const passMs = performance.now() - passStart;
      timeline.push({
        t: Math.round(performance.now() - begin),
        what: `ready ${session.status().phase}`,
      });
      expect(session.status().phase).toBe("ready");
      expect(store.read<{ n: number }>("SELECT COUNT(*) AS n FROM transactions")[0]?.n).toBe(ROWS);
      console.log(
        `FIRSTSYNC ${JSON.stringify({
          rows: ROWS,
          split: SPLIT ? months.length : 1,
          appliedEvents: applied,
          relaySegments: relayList.length,
          relayBytes,
          macImportMs: Math.round(macImportMs),
          passMs: Math.round(passMs),
          phases: clock.report(),
          timeline,
          audits,
        })}`,
      );
      await session.close();
      await macEngine.close();
      store.close();
      macStore.close();
    } finally {
      crypto.bindEd25519Verifier(previous);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 900_000);
});
