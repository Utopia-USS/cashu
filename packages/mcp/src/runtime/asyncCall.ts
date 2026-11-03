/** Async orchestration retains owned values, never a queue context, across external I/O. */
import { summaryOk } from "@cashu/domain/investments/macro";
import { leakCheck, type Privacy, Redactor, UnlabelledValue } from "../privacy/redactor.js";
import {
  enabledIn,
  type ToolArgs,
  ToolError,
  type ToolSpec,
  validateArguments,
} from "../registry.js";
import {
  type NativeAsyncAdapter,
  type NativeAsyncIo,
  type NativeAsyncValue,
  type NativePreparationExecution,
  ownedValue,
} from "./async.js";
import {
  APP_UPDATED,
  failure,
  type NativeCallBoundary,
  type NativeCallResult,
  renderNativeError,
  restrictivePrivacy,
  warnNative,
} from "./boundary.js";
import { finalizeNativeDelivery, guardInputFingerprint } from "./delivery.js";
import type { NativeToolStore } from "./types.js";

export class NativeAsyncLifecycle {
  private epoch = 0;
  private stopped = false;
  private readonly active = new Set<AbortController>();
  begin() {
    const epoch = this.epoch;
    const controller = new AbortController();
    this.active.add(controller);
    return {
      signal: controller.signal,
      stopped: () => this.stopped || this.epoch !== epoch || controller.signal.aborted,
      finish: () => this.active.delete(controller),
    };
  }
  invalidate(): void {
    this.stopped = true;
    this.epoch++;
    for (const controller of this.active) controller.abort();
  }
}
const isResult = (value: object): value is NativeCallResult => "ok" in value;

export async function runNativeAsyncCall(
  server: NativeCallBoundary,
  lifecycle: NativeAsyncLifecycle,
  spec: ToolSpec<NativeToolStore>,
  adapter: NativeAsyncAdapter,
  raw: ToolArgs | null,
  ceiling: Privacy | undefined,
): Promise<NativeCallResult> {
  // Snapshot before audit.start's first await; argument mutation cannot change an authorized call.
  let args: ToolArgs | null = null;
  let invalidSnapshot = false;
  try {
    args = ownedValue(raw) as ToolArgs | null;
  } catch {
    invalidSnapshot = true;
  }
  const call = lifecycle.begin();
  let floor = ceiling;
  let completed = false;
  let guardInputs: string | undefined;
  let fixedRefusal = false;
  let previousIo: NativeAsyncIo | undefined;
  const { runtime } = server;
  const fixedFailure = (message: string, kind: string, privacy: Privacy = "strict") => {
    fixedRefusal = true;
    return failure(message, kind, privacy);
  };
  const guarded = <T>(
    execution: NativePreparationExecution | undefined,
    fn: (context: NativePreparationExecution["context"]) => T,
  ): T | NativeCallResult => {
    if (runtime.replaced()) return fixedFailure(APP_UPDATED, "app_updated");
    if (call.stopped())
      return fixedFailure("the MCP session is no longer active", "session_closed");
    if (!execution)
      return fixedFailure("the profile of this server no longer exists", "profile_missing");
    floor = restrictivePrivacy(execution.policy.privacy, floor);
    if (!enabledIn(spec, execution.policy.modules))
      return fixedFailure(
        `tool ${spec.name} belongs to the module '${spec.module}', which is not enabled for this profile`,
        "module_disabled",
        floor,
      );
    try {
      if (invalidSnapshot)
        throw new ToolError("arguments must contain plain values", "invalid_arguments", {
          system: true,
        });
      return fn(execution.context);
    } catch (error) {
      let guard: NativePreparationExecution["context"]["guard"];
      try {
        guard = execution.context.guard;
        guardInputs = guardInputFingerprint(guard);
      } catch {
        return fixedFailure(
          "the response was withheld because the privacy context is unavailable",
          "privacy_check",
          "strict",
        );
      }
      const rendered = renderNativeError({ guard }, floor, error);
      if (rendered) return rendered;
      throw error;
    }
  };
  try {
    return await server.audited(
      spec.name,
      args,
      new Set(Object.keys(spec.properties)),
      async () => {
        const preparations = runtime.preparations;
        if (!preparations)
          return fixedFailure("native async preparation is unavailable", "unsupported");
        let validated: ToolArgs | undefined;
        let resume: NativeAsyncValue | undefined;
        let ioCount = 0;
        let ioFailed = false;
        while (true) {
          const step = await preparations.execute(floor, (execution) =>
            guarded(execution, (context) => {
              if (previousIo && !adapter.current(context, previousIo))
                throw new ToolError("the external capability is no longer current", "unavailable", {
                  system: true,
                });
              if (ioFailed)
                throw new ToolError("the external operation is unavailable", "unavailable", {
                  system: true,
                });
              validated ??= ownedValue(validateArguments(spec, args)) as ToolArgs;
              const next = adapter.advance(context, validated, resume);
              // Clone while the read-only queue scope is still active. No row/accessor escapes it.
              return next.kind === "io"
                ? { ...next, operation: ownedValue(next.operation) }
                : { ...next, ready: ownedValue(next.ready) };
            }),
          );
          if (isResult(step)) return step;
          if (step.kind === "io") {
            if (++ioCount > adapter.maxIoPhases) throw new Error("native async phase limit");
            try {
              if (call.stopped() || !step.io.isCurrent())
                throw new Error("inactive async capability");
              previousIo = step.io;
              resume = ownedValue(
                await adapter.perform(ownedValue(step.operation), step.io, call.signal, (code) => {
                  if (code === "mcp.import-stage-cleanup-failed") {
                    warnNative(runtime, code);
                  }
                }),
              );
              if (!step.io.isCurrent()) throw new Error("inactive async capability");
            } catch {
              ioFailed = true;
            }
            continue;
          }
          const ready = ownedValue(step.ready);
          const finished = await runtime.execute(floor, (execution) =>
            guarded(execution, () => {
              if (!execution || !validated) throw new Error("missing native async execution");
              if (previousIo && !adapter.current(execution.context, previousIo))
                throw new ToolError("the external capability is no longer current", "unavailable", {
                  system: true,
                });
              const prepared = adapter.finish(execution.context, validated, ready);
              if (
                prepared.prospectiveNames &&
                prepared.prospectiveNames.profileId !== execution.context.profileId
              )
                throw new Error("prospective guard profile mismatch");
              const guard = prepared.prospectiveNames
                ? execution.context.guard.withProspectiveSources(
                    execution.context.profileId,
                    prepared.prospectiveNames.providers,
                  )
                : execution.context.guard;
              const redact = (tree: Parameters<Redactor["apply"]>[0]) => {
                const redactor = new Redactor({ privacy: floor ?? "strict", guard, summaryOk });
                const data = redactor.apply(tree);
                if (data === null || typeof data !== "object" || Array.isArray(data))
                  throw new UnlabelledValue("a tool must return an object");
                leakCheck(data, {
                  strict: redactor.strict,
                  isins: redactor.isins,
                  nonMoney: redactor.nonMoney,
                });
                return data;
              };
              const data = redact(prepared.answer);
              const warning =
                prepared.cacheFailureAnswer === undefined
                  ? undefined
                  : redact(prepared.cacheFailureAnswer);
              if (prepared.afterCommit && (!warning || !adapter.afterCommit))
                throw new Error("cache publication requires a validated warning answer");
              const effect =
                prepared.afterCommit === undefined
                  ? undefined
                  : { data: ownedValue(prepared.afterCommit.data), io: prepared.afterCommit.io };
              if (call.stopped())
                throw new ToolError("the MCP session is no longer active", "session_closed", {
                  system: true,
                });
              guardInputs = guardInputFingerprint(guard);
              execution.commit();
              completed = true;
              return {
                result: { ok: true, privacy: floor ?? "strict", data } as NativeCallResult,
                warning,
                effect,
              };
            }),
          );
          if (isResult(finished)) return finished;
          if (finished.effect) {
            try {
              if (call.stopped() || !finished.effect.io.isCurrent())
                throw new Error("cache no longer current");
              // Bounded synchronous publication outside the queue. No postcommit await/privacy gap.
              const value: unknown = adapter.afterCommit?.(
                finished.effect.data,
                finished.effect.io,
              );
              if (value && typeof value === "object" && "then" in value) {
                void Promise.resolve(value).catch(() =>
                  warnNative(runtime, "mcp.async-cache-failed"),
                );
                warnNative(runtime, "mcp.async-cache-not-synchronous");
                return {
                  ok: true,
                  privacy: "strict",
                  data: { saved: true, note: "saved; the response was withheld" },
                };
              }
            } catch {
              warnNative(runtime, "mcp.async-cache-failed");
              return { ...finished.result, data: finished.warning };
            }
          }
          return finished.result;
        }
      },
      (result) =>
        finalizeNativeDelivery(
          runtime,
          spec,
          result,
          { completed, guardInputs, requireGuard: true, fixedRefusal },
          call.stopped,
          floor,
          (execution) =>
            previousIo === undefined ||
            !result.ok ||
            adapter.current(execution.context, previousIo),
        ),
    );
  } finally {
    call.finish();
  }
}
