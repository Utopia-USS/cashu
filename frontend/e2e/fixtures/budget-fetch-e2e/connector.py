"""Synthetic e2e fetch connector: no network, fixed made-up data (python3 stdlib)."""
import json
import sys


def reply(payload, code=0):
    sys.stdout.write(json.dumps(payload))
    sys.exit(code)


def main():
    request = json.load(sys.stdin)
    command = request.get("command")
    if not (request.get("secrets") or {}).get("api_key"):
        reply({"error": {"kind": "auth_failed", "message": "no key"}}, 1)
    if command == "check":
        reply({"ok": True})
    if command == "fetch":
        account = {"iban": "PL99 1090 0000 0000 0000 0000 0001", "currency": "PLN"}
        transactions = [
            {"booking_date": "2026-10-06", "amount": "-25.00", "currency": "PLN", "description": "E2E SKLEP", "transaction_id": "E2E-1"},
            {"booking_date": "2026-10-06", "amount": "-7.50", "currency": "PLN", "description": "E2E KAWA", "transaction_id": "E2E-2"},
        ]
        print("fetched 2 entries", file=sys.stderr)
        reply({"document": {"format": "cashu-budget-import", "format_version": 1, "source": "e2e_api",
                            "account": account, "transactions": transactions}, "cursor": "E2E-2"})
    reply({"error": {"kind": "internal", "message": "unknown command"}}, 1)


if __name__ == "__main__":
    main()
