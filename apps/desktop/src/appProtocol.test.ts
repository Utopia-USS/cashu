import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appAssetPath, appAssetResponse } from "./appProtocol.js";

describe("packaged app protocol", () => {
  it("serves only fixed renderer files with a restrictive policy", () => {
    const root = mkdtempSync(join(tmpdir(), "cashu-static-"));
    const renderer = join(root, "renderer");
    mkdirSync(join(renderer, "assets"), { recursive: true });
    writeFileSync(join(renderer, "index.html"), "<html></html>");
    writeFileSync(join(renderer, "assets", "main.js"), "console.log(1)");
    writeFileSync(join(root, "secret.js"), "secret");
    symlinkSync(join(root, "secret.js"), join(renderer, "link.js"));
    expect(appAssetPath("app://cashu/assets/desktop/index.html", root)).toBe(
      realpathSync.native(join(renderer, "index.html")),
    );
    expect(appAssetPath("app://cashu/assets/desktop/assets/main.js", root)).toBe(
      realpathSync.native(join(renderer, "assets", "main.js")),
    );
    for (const url of [
      "app://cashu.evil/assets/desktop/index.html",
      "app://evil@cashu/assets/desktop/index.html",
      "app://cashu:42/assets/desktop/index.html",
      "app://cashu/assets/desktop/../secret.js",
      "app://cashu/assets/desktop/%2e%2e/secret.js",
      "app://cashu/assets/desktop/link.js",
      "app://cashu/secret.js",
    ])
      expect(appAssetPath(url, root)).toBeNull();
    const response = appAssetResponse("app://cashu/assets/desktop/index.html", root);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
  });
});
