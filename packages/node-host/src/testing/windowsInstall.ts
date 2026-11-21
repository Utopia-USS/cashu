// A synthetic Windows install dir in the packaged layout (`cashU.exe`, `resources/...`,
// `resources/app-identity.json`, a bundle manifest over every resource file), for tests on any OS
// that pass `platform: "win32"` to the identity functions. Synthetic bytes only.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface WindowsInstallInput {
  readonly bundleId?: string;
  readonly version?: string;
  /** More resource files (install-relative `resources/...` paths), listed in the manifest. */
  readonly resources?: Readonly<Record<string, string>>;
}

/** Writes the install into the empty or missing directory `dir` and returns `dir`. */
export function writeWindowsInstall(dir: string, input: WindowsInstallInput = {}): string {
  const identity = {
    schema: 1,
    bundleId: input.bundleId ?? "io.utopiasoft.cashu",
    version: input.version ?? "1.2.3",
  };
  const resources: Record<string, string> = {
    "resources/host.mjs": "// host",
    "resources/shim.mjs": "// shim",
    "resources/notify-catalog-v1.json": "{}",
    "resources/skills/workspace-setup/SKILL.md": "skill",
    "resources/connectors/README.md": "catalog",
    "resources/renderer/index.html": "<html></html>",
    "resources/app.asar": "asar",
    "resources/app-identity.json": `${JSON.stringify(identity)}\n`,
    ...input.resources,
  };
  const write = (path: string, content: string) => {
    const file = join(dir, ...path.split("/"));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  };
  const files: Record<string, string> = {};
  for (const [path, content] of Object.entries(resources)) {
    write(path, content);
    files[path] = createHash("sha256").update(content).digest("hex");
  }
  write("cashU.exe", "binary");
  write("ffmpeg.dll", "codec");
  write("resources/bundle-manifest.json", JSON.stringify({ schema: 1, files }));
  return dir;
}
