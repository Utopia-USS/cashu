/** Real synthetic store with a serialized, buffered native-call test runtime. */
import { runCommand, storeWriter, type v1 } from "@cashu/store";
import { mcpProfile } from "@cashu/store/core";
import { toolContext } from "../registry.js";
import { type NativeExecution, type NativeRuntime, restrictivePrivacy } from "../runtime/server.js";
import type { NativeToolStore } from "../runtime/types.js";
import { nativeFixture } from "./native.js";

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export function asyncFixture() {
  const f = nativeFixture();
  const audit: string[] = [],
    warnings: string[] = [];
  let tail = Promise.resolve(),
    commits = 0,
    replaced = false,
    guardFailed = false;
  type Services = Pick<
    NativeToolStore,
    | "investmentAsync"
    | "investmentWrites"
    | "readInvestmentImportFile"
    | "readInvestmentMappingFile"
  >;
  let services:
    | Services
    | ((context: ReturnType<typeof toolContext<NativeToolStore>>) => Services) = {};
  const queue = <T>(fn: () => T): Promise<T> => {
    const result = tail.then(fn);
    tail = result.then(
      () => {},
      () => {},
    );
    return result;
  };
  const policy = () => {
    const profile = mcpProfile(f.store.read.bind(f.store));
    return profile
      ? {
          privacy: profile.mcpPrivacy === "amounts" ? ("amounts" as const) : ("strict" as const),
          modules: new Set(profile.modules),
        }
      : undefined;
  };
  const execute = <T>(
    ceiling: Parameters<NativeRuntime["execute"]>[0],
    fn: (execution: NativeExecution | undefined) => T,
    preparation = false,
  ): Promise<T> =>
    queue(() => {
      const current = policy();
      if (!current || replaced) return fn(undefined);
      const pending: v1.Envelope[] = [];
      const base = f.context(restrictivePrivacy(current.privacy, ceiling));
      let context: ReturnType<typeof toolContext<NativeToolStore>>;
      let resolved: Services | undefined;
      const bindings = () =>
        (resolved ??= typeof services === "function" ? services(context) : services);
      const store: NativeToolStore = {
        ...base.store,
        get investmentAsync() {
          return bindings().investmentAsync;
        },
        get investmentWrites() {
          return bindings().investmentWrites;
        },
        get readInvestmentImportFile() {
          return bindings().readInvestmentImportFile;
        },
        get readInvestmentMappingFile() {
          return bindings().readInvestmentMappingFile;
        },
        run(command, input) {
          if (preparation) throw new Error("preparation cannot write");
          if (pending.length) throw new Error("second buffered write");
          return runCommand(
            f.store,
            { append: (events) => pending.push(...events) },
            command,
            input,
            f.env,
          );
        },
      };
      context = toolContext({
        store,
        profileId: base.profileId,
        privacy: restrictivePrivacy(current.privacy, ceiling),
        today: base.today,
        loadGuard: () => {
          if (guardFailed) throw new Error("synthetic guard unavailable");
          return base.guard;
        },
        loadAccountLabels: () => base.accountLabels,
      });
      return fn({
        context,
        policy: current,
        commit() {
          commits++;
          storeWriter(f.store).append(pending);
        },
      });
    });
  const runtime: NativeRuntime = {
    now: f.env.clock.now,
    replaced: () => replaced,
    policy: async () => policy(),
    delegation: async () => undefined,
    warn: (code) => warnings.push(code),
    audit: {
      start: async () => {
        audit.push("start");
        return audit.length;
      },
      finish: async (_id, privacy, outcome) => {
        audit.push(`finish:${privacy}:${outcome}`);
      },
    },
    execute,
    preparations: {
      execute: (ceiling, fn) =>
        execute(
          ceiling,
          (e) => fn(e === undefined ? undefined : { context: e.context, policy: e.policy }),
          true,
        ),
    },
  };
  return {
    f,
    runtime,
    audit,
    warnings,
    commits: () => commits,
    replace: () => {
      replaced = true;
    },
    failGuard: () => {
      guardFailed = true;
    },
    services: (value: typeof services) => {
      services = value;
    },
  };
}
