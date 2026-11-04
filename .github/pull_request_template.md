## What and why

<!-- One or two sentences: what this changes and why. Link the issue if there is one. -->

## How it was tested

<!-- Commands you ran, what you checked in the app. -->

## Checklist

- [ ] Tests added or updated, on synthetic data only (no real statements, balances, IBANs or names)
- [ ] No data files staged: nothing from `data/` or `statements/`, no `.env`, `*.pem`, database or export (`git status` checked)
- [ ] `pnpm check` and `pnpm arch:check` pass; for desktop changes also `pnpm --filter @cashu/desktop build`
- [ ] Docs updated where the change affects them (`README.md`, `CLAUDE.md`, `docs/`, skills)
- [ ] No new network call or data leaving the machine, or it is described above
- [ ] No em dash character; UI strings in Polish, everything else in English
