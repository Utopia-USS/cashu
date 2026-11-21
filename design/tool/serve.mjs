// Static preview server of the design/ tree (node:* only, no dependencies).
// `/` lists every mockup; any file is reachable at /<app>/<feature>/<file>.html; design/workspace/ is never served.
// Usage: sh design/serve.sh [--port N]   (default 8600, bound to 127.0.0.1)
import { createServer } from "node:http";
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, normalize, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKIP = new Set(["workspace", "tool", "node_modules", ".DS_Store"]);
const portArg = process.argv.indexOf("--port");
const PORT = portArg > -1 ? Number(process.argv[portArg + 1]) : 8600;
const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".woff2": "font/woff2",
  ".mp4": "video/mp4", ".md": "text/plain; charset=utf-8",
};

async function mockups(dir = ROOT) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name) || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await mockups(p)));
    else if (e.name.endsWith(".html")) out.push(relative(ROOT, p).split(sep).join("/"));
  }
  return out.sort();
}

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
async function index() {
  const groups = new Map();
  for (const f of await mockups()) {
    const dir = f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : ".";
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(f);
  }
  const body = [...groups].map(([dir, files]) => `<h2>${esc(dir)}</h2><ul>${files.map((f) => `<li><a href="/${esc(f)}">${esc(f.slice(f.lastIndexOf("/") + 1))}</a></li>`).join("")}</ul>`).join("");
  return `<!doctype html><meta charset="utf-8"><title>cashU designs</title><style>body{background:#0a0a0b;color:#ededf0;font:14px/1.5 system-ui,sans-serif;max-width:760px;margin:48px auto;padding:0 20px}h1{font-size:20px;font-weight:600}h2{font-size:12px;font-weight:500;color:#6e6e77;margin:28px 0 6px}ul{margin:0;padding:0;list-style:none}li{padding:6px 0;border-top:1px solid rgba(255,255,255,.07)}a{color:#8ea4ff;text-decoration:none}a:hover{text-decoration:underline}</style><h1>cashU designs</h1>${body || "<p>No mockups yet.</p>"}`;
}

createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (path === "/" || path === "/index") {
      res.writeHead(200, { "content-type": TYPES[".html"], "cache-control": "no-store" });
      return res.end(await index());
    }
    const file = normalize(join(ROOT, path));
    const rel = relative(ROOT, file);
    if (rel.startsWith("..") || SKIP.has(rel.split(sep)[0])) throw Object.assign(new Error(), { code: "ENOENT" });
    const target = (await stat(file)).isDirectory() ? join(file, "index.html") : file;
    const data = await readFile(target);
    res.writeHead(200, { "content-type": TYPES[extname(target).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(data);
  } catch (e) {
    res.writeHead(e.code === "ENOENT" || e.code === "ENOTDIR" ? 404 : 500, { "content-type": "text/plain" });
    res.end(e.code === "ENOENT" || e.code === "ENOTDIR" ? "Not found (design/workspace/ is never served)" : "Server error");
  }
}).listen(PORT, "127.0.0.1", () => console.log(`cashU designs: http://localhost:${PORT}/`));
