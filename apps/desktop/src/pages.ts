import { type Lang, t } from "./strings.js";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function page(lang: Lang, body: string): string {
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><style>
:root { color-scheme: light dark; }
body { font: 14px -apple-system, system-ui, sans-serif; display: flex; align-items: center;
  justify-content: center; height: 100vh; margin: 0; background: #fff; color: #222; }
@media (prefers-color-scheme: dark) { body { background: #141414; color: #ddd; } }
main { max-width: 560px; padding: 24px; } code { font-size: 12px; }
</style></head><body><main>${body}</main></body></html>`;
}

export function loadingHtml(lang: Lang): string {
  return page(lang, `<p>${t(lang, "loading")}</p>`);
}

export function errorHtml(lang: Lang, message: string, logFile: string | null): string {
  const where = logFile ? `<p>${t(lang, "logHint")}<code>${escapeHtml(logFile)}</code></p>` : "";
  return page(lang, `<h2>${t(lang, "startFailedTitle")}</h2><p>${escapeHtml(message)}</p>${where}`);
}

export function dataUrl(html: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
