# statements/ — drop your bank statement exports (CSV) here

This directory is **git-ignored** (except this file and the empty structure), so
your statements never end up in the repository.

Arrange files in subdirectories named after the bank — the importer takes the
bank from the folder name:

```
statements/
├── mbank/   ← mBank exports (cp1250, ;)
├── erste/   ← Erste / former Santander exports (UTF-8, ; no header)
└── pekao/   ← Pekao exports (UTF-8, ;)
```

Then:

```bash
finanse import-dir statements     # recursive, bank inferred from the subdir name
finanse match-transfers           # pair internal transfers between your own accounts
```

Don't have one of these banks? Ignore or delete the empty subdirectory.
Want to add a new bank? See `AGENTS.md` → "Adding a new bank".
