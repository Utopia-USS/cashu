// What the shim does with its argv. It knows exactly three shapes and nothing else of the command tree
// (that lives in the host, so the shim never changes when commands do):
//   `host status|stop|run`              the shim's own admin commands (status never starts a host);
//   `[root profile] mcp [profile]`      an MCP session for one profile (stdio lines <-> the host);
//   anything else                       `cli.exec` in the host (which may delegate to Python).
// The MCP shape mirrors the Python CLI: the profile is the root `--profile/-p` or `mcp --profile/-p`
// (both only if equal) and nothing else may follow; every other form (help, a typo, two different
// profiles, no profile, a slug the protocol cannot carry) goes to the host as a normal command, so the
// Python CLI prints its own usage error byte for byte.
import { profileSlugSchema } from "@cashu/host-protocol";

export type Route =
  | { readonly kind: "cli" }
  | { readonly kind: "app"; readonly debug: boolean }
  | { readonly kind: "mcp"; readonly profile: string }
  | { readonly kind: "host"; readonly action: "status" | "stop" | "run" }
  | { readonly kind: "host-usage" };

/** Reads `--profile X`, `--profile=X`, `-p X`, `-pX` from `argv[i]`; [value, tokens used] or undefined. */
function profileOption(argv: readonly string[], i: number): [string, number] | undefined {
  const arg = argv[i] as string;
  if (arg === "--profile" || arg === "-p") {
    const value = argv[i + 1];
    return value === undefined ? undefined : [value, 2];
  }
  if (arg.startsWith("--profile=")) return [arg.slice("--profile=".length), 1];
  if (arg.startsWith("-p") && arg.length > 2 && !arg.startsWith("--")) return [arg.slice(2), 1];
  return undefined;
}

export function route(argv: readonly string[]): Route {
  if (argv[0] === "app" && (argv.length === 1 || (argv.length === 2 && argv[1] === "--debug")))
    return { kind: "app", debug: argv.length === 2 };
  if (argv[0] === "host") {
    const action = argv[1];
    if (argv.length === 2 && (action === "status" || action === "stop" || action === "run")) {
      return { kind: "host", action };
    }
    return { kind: "host-usage" };
  }
  const profiles: string[] = [];
  let i = 0;
  let sawMcp = false;
  while (i < argv.length) {
    const arg = argv[i] as string;
    if (!sawMcp && arg === "mcp") {
      sawMcp = true;
      i += 1;
      continue;
    }
    const option = profileOption(argv, i);
    if (option === undefined) return { kind: "cli" };
    profiles.push(option[0]);
    i += option[1];
  }
  const [profile] = profiles;
  if (!sawMcp || profile === undefined || profiles.some((p) => p !== profile))
    return { kind: "cli" };
  if (!profileSlugSchema.safeParse(profile).success) return { kind: "cli" };
  return { kind: "mcp", profile };
}
