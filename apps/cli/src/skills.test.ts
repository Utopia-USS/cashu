// The real shim reuses one host, while each caller retains its own HOME for skill installation.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { removeTempDirs, tempDir } from "./testing/dirs.js";
import { cleanEnv } from "./testing/env.js";
import { hostPid, runShim, SHIM_TEST_TIMEOUT_MS, stopHosts } from "./testing/shim.js";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
afterEach(async () => {
  await stopHosts();
  removeTempDirs();
});
it("uses the second caller's home through an already-running host", {
  timeout: SHIM_TEST_TIMEOUT_MS,
}, async () => {
  const firstHome = tempDir("cashu-skills-first-home-");
  const secondHome = tempDir("cashu-skills-second-home-");
  const cwd = tempDir("cashu-skills-cwd-");
  const data = tempDir("cashu-skills-data-");
  const env = {
    ...cleanEnv(),
    CASHU_DATA_DIR: data,
    CASHU_TESTING: "1",
    CASHU_LANG: "en",
    HOME: firstHome,
  };
  const path = await runShim(["skills", "path"], env, { cwd });
  expect(path).toMatchObject({
    code: 0,
    stdout: `${join(REPO, ".claude", "skills")}\n`,
    stderr: "",
  });
  const pid = hostPid(data);
  expect(pid).toBeDefined();
  const install = await runShim(["skills", "install"], { ...env, HOME: secondHome }, { cwd });
  expect(install.code).toBe(0);
  expect(install.stderr).toBe("");
  expect(install.stdout).toContain("installed /assets-setup -> ");
  expect(hostPid(data)).toBe(pid);
  expect(existsSync(join(firstHome, ".claude", "skills"))).toBe(false);
  expect(readFileSync(join(secondHome, ".claude", "skills", "assets-setup", "SKILL.md"))).toEqual(
    readFileSync(join(REPO, ".claude", "skills", "assets-setup", "SKILL.md")),
  );
});
