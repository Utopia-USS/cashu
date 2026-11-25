// Test wiring for commands: a fixed clock, a seeded ULID source, a lease and a writer that applies
// each batch to the store. Synthetic data only.
import { HybridClock } from "@cashu/sync/hlc";
import {
  type Command,
  type CommandEnv,
  type CommandOutcome,
  runCommand,
  storeWriter,
} from "../command.js";
import type { Store } from "../materialize.js";
import { rng } from "./random.js";

const TEST_DEVICE = "cccccccccccccccccccccccccccccccc";
const BASE_WALL = 1_793_448_000_000; // 2026-10-31T12:00:00.000Z

export interface TestEnv extends CommandEnv {
  /** Move the fixed clock forward. */
  advance(ms: number): void;
  holder: boolean;
}

export function testEnv(
  options: { device?: string; wall?: number; seed?: number; holder?: boolean } = {},
): TestEnv {
  let now = options.wall ?? BASE_WALL;
  const clock = { now: () => now };
  const device = options.device ?? TEST_DEVICE;
  const r = rng(options.seed ?? 1);
  const env: TestEnv = {
    device,
    clock,
    hlc: new HybridClock(device, { physical: clock }),
    holder: options.holder ?? true,
    lease: { isHolder: () => env.holder },
    random: (n) => Uint8Array.from({ length: n }, () => Math.floor(r() * 256)),
    advance(ms) {
      now += ms;
    },
  };
  return env;
}

/** Run `cmd` against `store`, applying its batch to the same store. */
export function run<I, R>(
  store: Store,
  env: CommandEnv,
  cmd: Command<I, R>,
  input: unknown,
): CommandOutcome<R> {
  return runCommand(store, storeWriter(store), cmd, input, env);
}
