# One-shot Python import

Close every Python cashU process before copying or importing its data directory. Keep it closed until import and verification finish. The importer reads the original directory as files, opens SQLite only on a private copy, and creates a new native target directory. The target path must not exist.

```sh
pnpm migrate import --source /absolute/python-data --target /absolute/new-native-data --recovery-file /absolute/private/recovery-words.txt
pnpm migrate verify --source /absolute/python-data --target /absolute/new-native-data --at TIMESTAMP_FROM_IMPORT_OUTPUT
```

Store the recovery words securely, then remove the plaintext recovery file when backed up. The file is created once with mode 0600. Retain the original Python directory until the native import and parity checks pass. Existing Enable Banking sessions and key files are not imported; reconnect with the bank. Connector code and approvals must be reinstalled or approved separately. Language preference, desktop window state, and the completed Python rename marker start fresh in the native app.

The importer copies historical price, FX, macro, calendar, notification, connector fetch, MCP audit, and connector run state into the native device database and checks exact content after reopening it. Globally cataloged instruments and aliases with no profile reference are preserved there, along with price rows linked by source instrument ID. Mapped vault price bars without a unique provider/symbol alias remain available by vault and instrument ID; connecting every quote screen to that read port is later work. An unsupported or changed source fails without overwriting an existing native target.

Referenced staged proposals and archived import files are copied into vault-key encrypted native blobs before inventory is published. `migrate verify` reopens each blob through the native import reader and compares its content with a fresh sealed source copy.
