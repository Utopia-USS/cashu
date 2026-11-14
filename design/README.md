# Dev designs

Standalone HTML design mockups for cashU, one dir per app and feature:
`design/<app>/<feature>/*.html` (`<app>` = `desktop` or `mobile`). They are dev-only explorations - not
shipped assets, not app code - and each page must render on its own from this tree (local refs stay
inside `design/`; CDN fonts are fine).

Preview them with `sh design/serve.sh` (or `pnpm design`), then open http://localhost:8600 - a plain
index of every mockup. Any file is reachable at `http://localhost:8600/<app>/<feature>/<file>.html`.

Every mockup is written in English, uses synthetic data only (never real balances, names, IBANs or
transactions), and carries a visible author badge - a small fixed pill in the bottom-left corner
(`class="designed-by"`, first element after `<body>`) reading `designed by <author>`.

Working material - briefs, notes, generator and screenshot scripts, screenshots, superseded rounds -
does NOT belong here: it mirrors the same paths under `design/workspace/`, which is gitignored and
local-only.

Full contract: [tools/claude-dev/skills/cashu-dev-designs/SKILL.md](../tools/claude-dev/skills/cashu-dev-designs/SKILL.md).
