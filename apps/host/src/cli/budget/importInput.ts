// Eligibility only. Typer retains help, parse diagnostics and options not represented here.
export interface ImportInput {
  readonly path: string;
  readonly bank?: string;
  readonly accountType: string;
  readonly name?: string;
  readonly recursive: boolean;
}
export function importInput(args: readonly string[], directory: boolean): ImportInput | undefined {
  const positional: string[] = [];
  const options = new Map<string, string>();
  let recursive = true;
  let ended = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (!ended && arg === "--") {
      ended = true;
      continue;
    }
    if (!ended && arg.startsWith("-")) {
      if (directory && ["--recursive", "--no-recursive"].includes(arg)) {
        recursive = arg === "--recursive";
        continue;
      }
      const at = arg.indexOf("=");
      const key = at < 0 ? arg : arg.slice(0, at);
      if (!(directory ? ["--bank"] : ["--bank", "--account-type", "--name"]).includes(key))
        return undefined;
      const value = at < 0 ? args[++i] : arg.slice(at + 1);
      if (value === undefined || (at < 0 && value.startsWith("--"))) return undefined;
      options.set(key, value);
    } else positional.push(arg);
  }
  if (positional.length > 1 || (!directory && positional.length !== 1)) return undefined;
  return {
    path: positional[0] ?? "data/incoming",
    accountType: options.get("--account-type") ?? "checking",
    recursive,
    ...(options.has("--bank") ? { bank: options.get("--bank") as string } : {}),
    ...(options.has("--name") ? { name: options.get("--name") as string } : {}),
  };
}
/** Control characters cannot appear in a single-line CLI label. Native output is literal text. */
export function importTextSupported(value: string): boolean {
  return !Array.from(value).some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127);
}
