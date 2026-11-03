/** Test-only Electron probe. Compile into a disposable build/t46 fixture, never the release app. */
import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, realpathSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve, sep } from "node:path";
import { app } from "electron";
import { type AppUpdater, CancellationToken } from "electron-updater";
import { ElectronHttpExecutor } from "electron-updater/out/electronHttpExecutor.js";
import { GenericProvider } from "electron-updater/out/providers/GenericProvider.js";

export type LocalProbeScenario = "good" | "bad_checksum" | "malformed" | "network";
export interface LocalProbeInput {
  readonly archivePath: string;
  readonly outputDir: string;
  readonly updateVersion: string;
  readonly scenario: LocalProbeScenario;
}
export interface LocalProbeResult {
  readonly scenario: LocalProbeScenario;
  readonly metadata: "parsed" | "rejected";
  readonly archive: "verified" | "rejected" | "not_attempted";
}

async function sha512(path: string): Promise<string> {
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("base64");
}

function inside(root: string, path: string): boolean {
  return path.startsWith(`${root}${sep}`);
}

/** Real library GenericProvider metadata parsing and Electron HTTP checksum, with no Squirrel call. */
export async function runLocalUpdaterProbe(input: LocalProbeInput): Promise<LocalProbeResult> {
  const executable = realpathSync(process.execPath);
  const marker = `${sep}build${sep}t46${sep}`;
  const markerIndex = executable.indexOf(marker);
  if (!app.isPackaged || markerIndex < 0) throw new Error("isolated_fixture_required");
  const fixtureRoot = executable.slice(0, markerIndex + marker.length - 1);
  const archive = realpathSync(input.archivePath);
  const outputCandidate = resolve(input.outputDir);
  if (!inside(fixtureRoot, archive) || realpathSync(dirname(outputCandidate)) !== fixtureRoot)
    throw new Error("isolated_fixture_required");
  mkdirSync(outputCandidate, { recursive: true, mode: 0o700 });
  const outputDir = realpathSync(outputCandidate);
  if (!inside(fixtureRoot, outputDir)) throw new Error("isolated_fixture_required");
  if (!/^\d+\.\d+\.\d+$/.test(input.updateVersion)) throw new Error("invalid_test_version");
  // Electron net's private session and destination stay under this disposable fixture root.
  app.setPath("userData", outputDir);
  app.setPath("sessionData", outputDir);
  app.commandLine.appendSwitch("disk-cache-dir", outputDir);
  await app.whenReady();
  const digest = await sha512(archive);
  const archiveName = "synthetic-update.zip";
  const server = createServer((request, response) => {
    if (input.scenario === "network") {
      response.writeHead(503);
      response.end();
      return;
    }
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (path === "/latest-mac.yml") {
      response.setHeader("Content-Type", "text/yaml");
      response.setHeader("Cache-Control", "no-store");
      response.end(
        input.scenario === "malformed"
          ? "version: [invalid\n"
          : `version: ${input.updateVersion}\nfiles:\n  - url: ${archiveName}\n    sha512: ${input.scenario === "bad_checksum" ? `${"A".repeat(86)}==` : digest}\nreleaseDate: 2026-11-03T00:00:00.000Z\n`,
      );
      return;
    }
    if (path === `/${archiveName}`) {
      response.setHeader("Content-Type", "application/zip");
      response.setHeader("Content-Length", statSync(archive).size);
      createReadStream(archive).pipe(response);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("localhost_server_unavailable");
    const executor = new ElectronHttpExecutor();
    // GenericProvider only reads channel/isAddNoCacheQuery from this inert test updater shape.
    const stub = { channel: null, isAddNoCacheQuery: false } as unknown as AppUpdater;
    const provider = new GenericProvider(
      { provider: "generic", url: `http://127.0.0.1:${address.port}/` },
      stub,
      { isUseMultipleRangeRequest: false, platform: "darwin", executor },
    );
    let info: Awaited<ReturnType<GenericProvider["getLatestVersion"]>>;
    try {
      info = await provider.getLatestVersion();
    } catch {
      return { scenario: input.scenario, metadata: "rejected", archive: "not_attempted" };
    }
    if (
      input.scenario === "malformed" ||
      input.scenario === "network" ||
      info.version !== input.updateVersion
    )
      return { scenario: input.scenario, metadata: "rejected", archive: "not_attempted" };
    const files = provider.resolveFiles(info);
    const selected = files.find((file) => file.url.pathname.endsWith(".zip"));
    if (!selected || selected.url.origin !== `http://127.0.0.1:${address.port}`)
      return { scenario: input.scenario, metadata: "rejected", archive: "not_attempted" };
    try {
      await executor.download(selected.url, join(outputDir, `probe-${input.scenario}.zip`), {
        sha512: selected.info.sha512,
        cancellationToken: new CancellationToken(),
      });
      return { scenario: input.scenario, metadata: "parsed", archive: "verified" };
    } catch {
      return { scenario: input.scenario, metadata: "parsed", archive: "rejected" };
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
