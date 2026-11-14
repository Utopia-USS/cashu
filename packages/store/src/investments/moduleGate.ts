// The investments module gate of the owner's UI commands: a vault with the module off refuses them.
import { type Command, refuse } from "../command.js";
import { enabledModuleIds, type Read } from "../core/queries.js";

/** The investments module is on for this vault. */
export const investmentsEnabled = (read: Read): boolean =>
  enabledModuleIds(read).has("investments");

/** `command`, refused with `module_disabled` while the investments module is off; `id` renames it. */
export function moduleGated<I, R, In>(
  command: Command<I, R, In>,
  id: string = command.id,
): Command<I, R, In> {
  return {
    ...command,
    id,
    run(ctx, input) {
      return investmentsEnabled(ctx.read) ? command.run(ctx, input) : refuse("module_disabled");
    },
  };
}
