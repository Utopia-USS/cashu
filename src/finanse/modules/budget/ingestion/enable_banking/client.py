"""HTTP client for the Enable Banking API.

Auth model (free "Restricted Production" tier): you register an application in
the Enable Banking control panel and generate an RSA key pair, keeping the
private key locally. Every request carries a short-lived RS256 JWT signed with
that key; the JWT *is* the bearer token.

Docs: https://enablebanking.com/docs/api/reference/  — endpoint/field names here
are written to that reference and may need minor tweaks against live responses.
The user performs the actual bank login (SCA) in their browser; no bank
credentials ever pass through this code.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any, Iterator

import httpx
import jwt
from cryptography.hazmat.primitives.serialization import load_pem_private_key


class EnableBankingError(RuntimeError):
    pass


class EnableBankingClient:
    def __init__(
        self,
        app_id: str,
        key_path: str | Path,
        *,
        base_url: str = "https://api.enablebanking.com",
        redirect_url: str = "http://localhost:8000/eb/callback",
        timeout: float = 30.0,
    ) -> None:
        if not app_id:
            raise EnableBankingError("Enable Banking application id is not configured.")
        key_path = Path(key_path)
        if not key_path.exists():
            raise EnableBankingError(f"Private key not found at {key_path}.")
        self.app_id = app_id
        self.base_url = base_url.rstrip("/")
        self.redirect_url = redirect_url
        self._timeout = timeout
        self._private_key = load_pem_private_key(key_path.read_bytes(), password=None)

    # --- auth ---

    def _jwt(self) -> str:
        now = int(time.time())
        payload = {
            "iss": "enablebanking.com",
            "aud": "api.enablebanking.com",
            "iat": now,
            "exp": now + 3600,
        }
        return jwt.encode(
            payload, self._private_key, algorithm="RS256", headers={"kid": self.app_id}
        )

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._jwt()}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }

    def _request(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        url = f"{self.base_url}{path}"
        try:
            with httpx.Client(timeout=self._timeout) as client:
                resp = client.request(method, url, headers=self._headers(), **kwargs)
        except httpx.HTTPError as e:
            raise EnableBankingError(f"HTTP error calling {method} {path}: {e}") from e
        if resp.status_code >= 400:
            raise EnableBankingError(
                f"{method} {path} -> {resp.status_code}: {resp.text[:500]}"
            )
        return resp.json() if resp.content else {}

    # --- endpoints ---

    def get_application(self) -> dict[str, Any]:
        """App metadata — useful as a connectivity/credentials check."""
        return self._request("GET", "/application")

    def get_aspsps(self, country: str | None = None) -> list[dict[str, Any]]:
        params = {"country": country} if country else None
        data = self._request("GET", "/aspsps", params=params)
        return data.get("aspsps", data if isinstance(data, list) else [])

    def start_authorization(
        self,
        aspsp_name: str,
        country: str,
        *,
        valid_days: int = 90,
        state: str = "",
        psu_type: str = "personal",
    ) -> dict[str, Any]:
        """Begin bank authorization; returns {url, authorization_id}.

        Open `url` in a browser, complete the bank's SCA login, then feed the
        `code` from the redirect back into `create_session`.
        """
        valid_until = time.strftime(
            "%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(time.time() + valid_days * 86400)
        )
        body = {
            "access": {"valid_until": valid_until},
            "aspsp": {"name": aspsp_name, "country": country},
            "state": state or "finanse",
            "redirect_url": self.redirect_url,
            "psu_type": psu_type,
        }
        return self._request("POST", "/auth", json=body)

    def create_session(self, code: str) -> dict[str, Any]:
        """Exchange the redirect `code` for an authorized session with accounts."""
        return self._request("POST", "/sessions", json={"code": code})

    def get_session(self, session_id: str) -> dict[str, Any]:
        return self._request("GET", f"/sessions/{session_id}")

    def get_account_details(self, account_uid: str) -> dict[str, Any]:
        return self._request("GET", f"/accounts/{account_uid}/details")

    def get_account_balances(self, account_uid: str) -> list[dict[str, Any]]:
        data = self._request("GET", f"/accounts/{account_uid}/balances")
        return data.get("balances", [])

    def iter_transactions(
        self,
        account_uid: str,
        *,
        date_from: str | None = None,
        date_to: str | None = None,
    ) -> Iterator[dict[str, Any]]:
        """Yield transactions, following continuation keys across pages."""
        params: dict[str, str] = {}
        if date_from:
            params["date_from"] = date_from
        if date_to:
            params["date_to"] = date_to
        while True:
            data = self._request(
                "GET", f"/accounts/{account_uid}/transactions", params=params
            )
            yield from data.get("transactions", [])
            cont = data.get("continuation_key")
            if not cont:
                break
            params["continuation_key"] = cont
