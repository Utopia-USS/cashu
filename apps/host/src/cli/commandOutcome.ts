import { randomBytes } from "node:crypto";
import { type Command, type DurableCommandResult, mintUlid } from "@cashu/store";
import { runHostVaultCommand } from "../commands.js";
import type { OpenVault } from "../stores.js";
import { N } from "./native.strings.js";
import type { CommandIo } from "./tree.js";

/** Mint once for this CLI dispatch. Never generate a replacement after an uncertain answer. */
export function cliCommandKey(): string {
  return mintUlid(Date.now(), (n) => new Uint8Array(randomBytes(n)));
}

export function runCliVaultCommand<I, R>(
  vault: OpenVault,
  command: Command<I, R>,
  input: unknown,
  key: string,
  isCurrent?: () => boolean,
): Promise<DurableCommandResult<R>> {
  const checked: Command<I, R> = isCurrent
    ? {
        ...command,
        run(ctx, parsed) {
          return isCurrent()
            ? command.run(ctx, parsed)
            : { ok: false, reason: "cli_context_changed" };
        },
      }
    : command;
  return runHostVaultCommand(vault, checked, input, key, isCurrent);
}

/** The original key is enough for a later read-only status lookup. */
export function reportCliCommandFailure(
  io: CommandIo,
  result: Exclude<DurableCommandResult<unknown>, { readonly kind: "completed" }>,
  key: string,
  commandId: string,
): number {
  if (result.kind === "outcome_unknown") {
    io.stderr(`${io.t.tr(N.commandUnknown)(commandId, key)}\n`);
  } else {
    io.stderr(`${io.t.tr(N.commandFailure)(result.kind, result.reason, key)}\n`);
  }
  return 1;
}

export function reportCliProjectionUnavailable(
  io: CommandIo,
  key: string,
  commandId: string,
): number {
  io.stderr(`${io.t.tr(N.projectionUnavailable)(commandId, key)}\n`);
  return 1;
}
