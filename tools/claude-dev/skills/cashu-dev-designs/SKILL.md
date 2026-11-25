---
name: cashu-dev-designs
description: |
  The repo's dev-design tree: standalone HTML mockups tracked under design/ (one dir per app + feature), their gitignored working mirror under design/workspace/, and the local preview server (sh design/serve.sh or pnpm design, port 8600).

  Applicability - POSITIVE: creating or iterating an HTML mockup, concept, variant lab or proposal of a cashU screen; deciding where a brief, note, generator or screenshot script, screenshot or superseded round belongs; previewing or screenshotting dev designs; building a hub page that compares variants.

  Applicability - NEGATIVE: NOT turning a design into code (packages/ui components, tokens, Storybook: cashu-ui; screens, hooks, data: cashu-ts-architecture), NOT the product skills in .claude/skills/, NOT real user data in any form.
---

# cashu-dev-designs

Design explorations are plain, self-contained HTML pages: fast to write, fast to iterate with the owner,
reviewable in a browser without building the app. They live in ONE tracked tree, `design/`, so a
direction from three months ago is still findable and still renders. Everything needed to *produce* a
mockup - briefs, notes, scripts, screenshots, superseded rounds - is working material: it goes to the
gitignored mirror `design/workspace/`, at the same relative path.

Three rules carry most of the value: **the tracked tree holds only HTML plus the assets it references**,
**a mockup renders from the `design/` root alone**, and **mockups hold synthetic data only**.

## Layout

```
design/                                        # committed: the tracked mockup tree
├── README.md                                  # committed: orientation, serve command, pointer here
├── serve.sh                                   # committed: launcher (node design/tool/serve.mjs)
├── tool/serve.mjs                             # committed: static server + index page (node:* only)
├── desktop/                                   # committed: desktop app (Electron renderer) mockups
│   └── investments-home/lab.html              # committed: variant lab V1-V5 of the investments home top
├── mobile/                                    # committed: mobile app mockups (when there are any)
└── workspace/                                 # gitignored: mirrored working material, local-only
    └── desktop/investments-home/
        ├── NOTES.md                           # gitignored: decisions, card guidelines, motion rules
        ├── shots.sh, shots/                   # gitignored: screenshot script and its output
        ├── rounds/                            # gitignored: superseded rounds, kept to look back
        └── motion-video/                      # gitignored: reference material
```

`design/workspace/` is ignored by one root `.gitignore` entry; nothing else under `design/` is ignored.
If a file you add does not show up in `git status`, it belongs in the workspace mirror or it is
misplaced.

## Conventions

- **One dir per feature:** `design/<app>/<feature>/`, `<app>` = `desktop` or `mobile`, `<feature>` named
  the way the team names the screen (`investments-home`, `budget-overview`, `review-deck`).
- **Author badge.** Every mockup carries a visible pill in the bottom-left corner of the viewport (the
  top centre is where cashU's navigation sits) reading
  `designed by <author>` as the first element after `<body>`, with `class="designed-by"` (the tree is
  greppable by both). It credits the person who directed the design, not the tool. Dark snippet:

  ```html
  <div class="designed-by" style="position:fixed;left:12px;bottom:12px;z-index:9999;pointer-events:none;font:600 10px/1 system-ui,-apple-system,sans-serif;letter-spacing:.04em;text-transform:uppercase;color:#8e8e94;background:rgba(22,22,25,.9);border:1px solid rgba(255,255,255,.1);border-radius:999px;padding:4px 10px;">designed by <span style="color:#8ea4ff;">jakob</span></div>
  ```
- **English only** in mockup copy, whatever language the conversation ran in. Polish UI copy belongs in
  the app's catalogs, not in mockups.
- **Synthetic data only.** Never a real balance, account number, IBAN, person name, holding size or
  transaction - not from the owner's app, not from a screenshot the owner pasted. Public instrument
  names and tickers are fine; amounts and positions are invented.
- **File naming.** Competing directions: `concept-a.html` / `concept-b.html`; options put in front of
  the owner: `proposal-a.html`; one obvious design: `index.html`; a single page that switches between
  variants: `lab.html` (keys 1-n, the URL hash keeps the variant). Keep names once published - the
  owner refers to them by filename.
- **Hub pages** may embed siblings in scaled `<iframe>`s with relative paths and a `?v=N` cache-bust;
  every file still stands alone.
- **Assets** sit next to the HTML that uses them (`<feature>/assets/`, or `design/<app>/assets/` for a
  shared palette), referenced relatively. Small images may be inlined as data URIs.
- **Self-containment.** Google Fonts and other CDN tags are fine. Every local reference resolves inside
  `design/`: never reach into `apps/` or `packages/` and never use absolute paths - copy the asset in.
  Inline CSS / JS unless a stylesheet is genuinely shared within the feature dir.
- **Lab URL switches** worth keeping in every lab: `?still` (final states, no motion, for screenshots)
  and a way to pin hover-only states open (`?card=...`), so a headless screenshot shows them.

## Workspace rule

Anything that is not the mockup or its assets goes to `design/workspace/<app>/<feature>/`, mirroring the
tracked path: briefs, notes, decision logs, generator and screenshot scripts, screenshots, superseded
rounds, reference videos and frames. Never park working material in the tracked tree, and never scatter
it elsewhere in the repo (`apps/`, `docs/`, `.claude/`, repo root). The workspace is local-only and may
be pruned: a decision that must survive goes into the mockup itself (its header comment, the variant
note) or into the code once it is implemented.

## Preview and screenshots

```sh
sh design/serve.sh            # or: pnpm design -> http://localhost:8600/ (index of every mockup)
sh design/serve.sh --port 9000
```

Any file is at `http://localhost:8600/<app>/<feature>/<file>.html`. The server never serves
`design/workspace/` (and `design/tool/`): a 404 for a file that exists means it is in the mirror.
Open pages over the server, not `file://` - relative assets and fonts need it.

Headless screenshots (final states): Chrome `--headless=new --window-size=1440,2000
--force-device-scale-factor=2 --virtual-time-budget=3000 --screenshot=<out> "<url>?still#V5"`; keep
the script and its output in the workspace mirror. In the agent's Browser pane a hidden pane throttles
animation frames: verify motion end states with the lab's motion-off switch and measurements, and say
plainly that live motion still needs a human eye.

## Adding a design

1. `design/<app>/<feature>/` - create it if the feature has no dir yet.
2. Author the HTML there, named per the conventions, in English, synthetic data, with the
   `designed by <author>` badge first after `<body>`.
3. Assets in `<feature>/assets/`; brief, notes, scripts and shots in `design/workspace/<app>/<feature>/`.
4. Check every local reference resolves inside `design/`.
5. Preview over `sh design/serve.sh`; bump `?v=N` on any hub that embeds the file.
6. Commit the HTML and assets only; the workspace mirror stays local.

## See also

- `cashu-ui` (this plugin) - the real UI system (tokens, `packages/ui` components, Storybook) a mockup
  is designing towards and a chosen direction ends up in.
- `cashu-ts-architecture` (this plugin) - screens, hooks and data when a design becomes code.
- [design/README.md](../../../../design/README.md) - the tree's own short orientation note.

## Self-audit checklist

1. The new or edited HTML sits in `design/<app>/<feature>/`, named per the conventions.
2. The `designed by <author>` badge (`class="designed-by"`) is the first element after `<body>`; all
   copy is English.
3. Every amount, name and position in it is synthetic; nothing came from the owner's real data.
4. No md, script, screenshot, dump or superseded round landed in the tracked tree - working material is
   under `design/workspace/<same path>`.
5. Every local `src` / `href` resolves inside `design/`; CDN fonts / scripts are the only remote ones.
6. The page renders over `http://localhost:8600/...`.
7. `git status` shows only the HTML (+ assets) as new files, nothing from the workspace mirror.
