import type { Command } from "../../command.js";
import type { DurableCommandResult } from "../../command-durable.js";

/** Host-owned append boundary. A service never acquires the host queue around this call. */
export type DurableWrite = <I, R>(
  command: Command<I, R>,
  input: unknown,
) => Promise<DurableCommandResult<R>>;

export class DurableWriteUnknown extends Error {
  vault?: string;
  readonly key: string;
  readonly commandId: string;
  constructor(key: string, commandId: string) {
    super("durable_write_outcome_unknown");
    this.key = key;
    this.commandId = commandId;
  }
}

export async function requireDurable<I, R>(
  write: DurableWrite,
  command: Command<I, R>,
  input: unknown,
): Promise<R> {
  const result = await write(command, input);
  if (result.kind === "completed") return result.value;
  if (result.kind === "outcome_unknown") throw new DurableWriteUnknown(result.key, command.id);
  throw new Error(result.kind === "refused" ? result.reason : result.reason);
}
