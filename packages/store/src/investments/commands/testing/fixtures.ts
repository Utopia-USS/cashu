// Test fixtures for the investments queries and commands: a vault (in-memory store + command env),
// brokerage accounts, instruments through the real commands, and raw events for the facts no
// S22d command writes (imports, rule runs, alerts). Synthetic data only.
import { expect } from "vitest";
import type { Command, CommandEnv, CommandOutcome } from "../../../command.js";
import { openAccount } from "../../../core/commands.js";
import { type DetGid, detGidFor, vaultSalt } from "../../../gid.js";
import { Store } from "../../../materialize.js";
import { builtinModules } from "../../../modules.js";
import { run, testEnv } from "../../../testing/commands.js";
import { memoryDriver, openTestStore, TEST_SALT, testUlid } from "../../../testing/store.js";
import { createInstrument } from "../instruments.js";

export interface Vault {
  readonly store: Store;
  readonly env: CommandEnv & { advance(ms: number): void; holder: boolean };
  readonly det: DetGid;
  /** Run a command; the batch is applied to this vault's store. */
  run<I, R>(cmd: Command<I, R>, input: unknown): CommandOutcome<R>;
  /** Run a command that must succeed and return its value. */
  value<I, R>(cmd: Command<I, R>, input: unknown): R;
}

function wrap(store: Store, det: DetGid, env: Vault["env"]): Vault {
  return {
    store,
    env,
    det,
    run: (cmd, input) => run(store, env, cmd, input),
    value(cmd, input) {
      const out = run(store, env, cmd, input);
      if (!out.ok) expect.fail(`${cmd.id} refused: ${out.reason}`);
      return out.value;
    },
  };
}

/** The test vault (TEST_VAULT, TEST_SALT) with a fixed clock (2026-10-31T12:00Z). */
export function vault(options: { holder?: boolean; seed?: number } = {}): Vault {
  return wrap(
    openTestStore(),
    detGidFor(TEST_SALT),
    testEnv({ holder: options.holder ?? true, seed: options.seed ?? 1 }),
  );
}

/** A second, independent vault (another profile): its own id, salt and view database. */
export function otherVault(): Vault {
  const salt = vaultSalt(Uint8Array.from({ length: 32 }, (_, i) => 255 - i));
  const store = Store.open({
    driver: memoryDriver(),
    vault: "0b7e2c4d9a1f43e8b6c5d7e8f9a0b1c2",
    salt,
    modules: builtinModules(),
  });
  return wrap(store, detGidFor(salt), testEnv({ seed: 2 }));
}

/** A brokerage account of the vault. */
export function brokerage(v: Vault, name = "Rachunek maklerski"): string {
  return v.value(openAccount, {
    bank: "xtb",
    name,
    type: "brokerage",
    currency: "PLN",
    externalId: `brokerage:${name}`,
  }).account;
}

/** An instrument stored through `createInstrument` (DET gid from its ISIN). */
export function stock(
  v: Vault,
  symbol: string,
  isin: string,
  extra: Record<string, unknown> = {},
): string {
  return v.value(createInstrument, {
    name: `${symbol} SA`,
    currency: "PLN",
    assetClass: "equity",
    symbol,
    isin,
    mic: "XWAR",
    ...extra,
  }).gid;
}

let rawSeq = 0;

/** Apply raw events stamped by this vault's device clock (facts outside S22d's commands). */
export function applyRaw(
  v: Vault,
  events: readonly { type: string; gid: string; data: Record<string, unknown> }[],
) {
  const envelopes = events.map((e) => {
    rawSeq += 1;
    const wall = v.env.clock.now();
    return {
      eid: testUlid("01JF", rawSeq),
      vault: v.store.vault,
      device: v.env.device,
      hlc: v.env.hlc.tick(),
      at: new Date(wall).toISOString(),
      type: e.type,
      v: 1,
      gid: e.gid,
      data: e.data,
    };
  });
  return v.store.applyEnvelopes(envelopes);
}

/** A manual-style ULID for raw events. */
export const rawGid = (n: number) => testUlid("01JG", n);

/** Complete raw payloads for the facts S22d's commands do not write. */
export const raw = {
  watchAdded: (v: Vault, instrument: string, data: Record<string, unknown> = {}) => ({
    type: "watchlist.added",
    gid: v.det("watchlist_items", [instrument]),
    data: { instrument, source: "user", ...data },
  }),
  watchRemoved: (v: Vault, instrument: string) => ({
    type: "watchlist.removed",
    gid: v.det("watchlist_items", [instrument]),
    data: {},
  }),
  noteAdded: (gid: string, instrument: string | null, data: Record<string, unknown> = {}) => ({
    type: "note.added",
    gid,
    data: {
      run: null,
      instrument,
      theme: null,
      segment: null,
      kind: "news",
      polarity: "neutral",
      strength: 1,
      thesisRelation: "none",
      thesisField: null,
      title: "Notatka",
      summary: "Fakt.",
      sources: [{ title: "Zrodlo", url: "https://x.example" }],
      details: null,
      candidateKey: null,
      signal: null,
      observedAt: "2026-10-30T08:00:00.000Z",
      expiresAt: "2026-11-30T08:00:00.000Z",
      createdBy: "agent",
      ...data,
    },
  }),
  alertCreated: (gid: string, instrument: string | null, data: Record<string, unknown> = {}) => ({
    type: "alert.created",
    gid,
    data: {
      instrument,
      scope: instrument === null ? "portfolio" : "instrument",
      kind: "price_above",
      params: { level: 50 },
      polarity: "positive",
      severity: "info",
      title: "Alert",
      note: null,
      source: "user",
      createdBy: "app",
      cooldownDays: null,
      expiresAt: null,
      ...data,
    },
  }),
  signalOpened: (gid: string, dedupKey: string, data: Record<string, unknown> = {}) => ({
    type: "signal.opened",
    gid,
    data: {
      ruleId: dedupKey.split("|")[0],
      kind: "k",
      dedupKey,
      severity: "info",
      polarity: "neutral",
      message: "m",
      instrument: null,
      account: null,
      payload: {},
      run: null,
      ...data,
    },
  }),
  ruleRun: (gid: string, data: Record<string, unknown> = {}) => ({
    type: "ruleRun.finished",
    gid,
    data: {
      trigger: "worker",
      asOf: "2026-10-31",
      status: "ok",
      strategyVersion: null,
      stats: {},
      errors: [],
      report: { new: [], escalated: [] },
      startedAt: "2026-10-31T06:00:00.000Z",
      finishedAt: "2026-10-31T06:00:05.000Z",
      ...data,
    },
  }),
};
