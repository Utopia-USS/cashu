// A scripted `Authenticator` for tests: a fixed capability and the outcome of each prompt in order
// (a promise holds a prompt open until the test settles it); once the script runs out every prompt is
// cancelled. `prompts` records what each prompt said.
import type { Authenticator, AuthPrompt, AuthResult, LockCapability } from "../auth";

export interface MemoryAuthenticator extends Authenticator {
  readonly prompts: AuthPrompt[];
}

export function memoryAuthenticator(
  script: {
    capability?: LockCapability;
    results?: readonly (AuthResult | Promise<AuthResult>)[];
  } = {},
): MemoryAuthenticator {
  const results = [...(script.results ?? [])];
  const prompts: AuthPrompt[] = [];
  return {
    prompts,
    capability: async () => script.capability ?? "face",
    authenticate: async (prompt) => {
      prompts.push(prompt);
      return (await results.shift()) ?? "cancelled";
    },
  };
}
