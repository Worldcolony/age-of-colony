"""Reusable Solana wallet authentication primitives.

The browser first asks for a short-lived challenge and signs its exact
``message`` with the wallet's Ed25519 key.  A successfully verified challenge
is consumed once and exchanged for a short-lived HMAC-signed session token.

This module deliberately has no FastAPI dependency.  An API layer can put the
returned token in an HttpOnly cookie (recommended) or accept it as a bearer
token, and translate :class:`WalletAuthError` into the appropriate HTTP error.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import re
import secrets
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey


WALLET_SESSION_COOKIE = "aoc_wallet_session"
WALLET_SESSION_COOKIE_PATH = "/"
DEFAULT_CHALLENGE_TTL_SECONDS = 300
DEFAULT_SESSION_TTL_SECONDS = 60 * 60
DEFAULT_MAX_PENDING_CHALLENGES = 4096

_B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
_B58_INDEX = {character: index for index, character in enumerate(_B58_ALPHABET)}
_B64URL_RE = re.compile(r"^[A-Za-z0-9_-]+$")


class WalletAuthError(ValueError):
    """A stable, API-friendly wallet authentication failure."""

    def __init__(self, code: str, detail: str, *, status_code: int = 401) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail
        self.status_code = status_code


class WalletAuthConfigurationError(ValueError):
    """Raised when the auth manager is configured insecurely."""


@dataclass(frozen=True)
class WalletChallenge:
    wallet: str
    nonce: str
    message: str
    issued_at: int
    expires_at: int

    def public_state(self) -> dict[str, Any]:
        return {
            "wallet": self.wallet,
            "nonce": self.nonce,
            "message": self.message,
            "issuedAt": self.issued_at,
            "expiresAt": self.expires_at,
        }


@dataclass(frozen=True)
class WalletSession:
    token: str
    wallet: str
    session_id: str
    issued_at: int
    expires_at: int

    def public_state(self) -> dict[str, Any]:
        """Safe response body; the session token belongs in an HttpOnly cookie."""

        return {
            "authenticated": True,
            "wallet": self.wallet,
            "issuedAt": self.issued_at,
            "expiresAt": self.expires_at,
        }


@dataclass(frozen=True)
class WalletSessionClaims:
    wallet: str
    session_id: str
    issued_at: int
    expires_at: int


@dataclass
class _ChallengeRecord:
    challenge: WalletChallenge
    consumed_at: int | None = None


def base58_decode(value: str) -> bytes:
    """Decode base58 without accepting ambiguous or non-base58 characters."""

    number = 0
    for character in value:
        digit = _B58_INDEX.get(character)
        if digit is None:
            raise ValueError(f"invalid base58 character: {character!r}")
        number = number * 58 + digit
    decoded = number.to_bytes((number.bit_length() + 7) // 8, "big")
    leading_zeroes = len(value) - len(value.lstrip("1"))
    return b"\x00" * leading_zeroes + decoded


def normalize_wallet(wallet: str) -> str:
    """Return a canonical Solana pubkey or raise ``invalid_wallet``."""

    cleaned = str(wallet or "").strip()
    try:
        decoded = base58_decode(cleaned)
    except (TypeError, ValueError) as exc:
        raise WalletAuthError("invalid_wallet", "Malformed Solana wallet.", status_code=422) from exc
    if len(decoded) != 32:
        raise WalletAuthError("invalid_wallet", "Solana wallet must decode to 32 bytes.", status_code=422)
    return cleaned


def verify_ed25519_signature(wallet: str, message: str | bytes, signature_b64: str) -> str:
    """Verify a Phantom-compatible base64 Ed25519 signature.

    Returns the normalized wallet so callers can safely persist it.
    """

    normalized_wallet = normalize_wallet(wallet)
    payload = message.encode("utf-8") if isinstance(message, str) else bytes(message)
    try:
        signature = base64.b64decode(str(signature_b64 or ""), validate=True)
    except (binascii.Error, TypeError, ValueError) as exc:
        raise WalletAuthError("invalid_signature", "Malformed wallet signature.", status_code=403) from exc
    if len(signature) != 64:
        raise WalletAuthError("invalid_signature", "Wallet signature must be 64 bytes.", status_code=403)

    try:
        public_key = Ed25519PublicKey.from_public_bytes(base58_decode(normalized_wallet))
        public_key.verify(signature, payload)
    except (InvalidSignature, ValueError) as exc:
        raise WalletAuthError("invalid_signature", "Signature does not match this wallet.", status_code=403) from exc
    return normalized_wallet


class WalletAuthManager:
    """Issue one-use wallet challenges and short-lived signed sessions."""

    def __init__(
        self,
        session_secret: str | bytes,
        *,
        domain: str = "Age of Colony",
        uri: str = "https://age-of-colony.app",
        chain_id: str = "solana:mainnet",
        issuer: str = "age-of-colony",
        challenge_ttl_seconds: int = DEFAULT_CHALLENGE_TTL_SECONDS,
        session_ttl_seconds: int = DEFAULT_SESSION_TTL_SECONDS,
        max_pending_challenges: int = DEFAULT_MAX_PENDING_CHALLENGES,
        clock: Callable[[], float] = time.time,
    ) -> None:
        secret = session_secret.encode("utf-8") if isinstance(session_secret, str) else bytes(session_secret)
        if len(secret) < 32:
            raise WalletAuthConfigurationError("Wallet session secret must contain at least 32 bytes.")
        if challenge_ttl_seconds <= 0 or session_ttl_seconds <= 0 or max_pending_challenges <= 0:
            raise WalletAuthConfigurationError("Wallet authentication TTLs and challenge capacity must be positive.")
        for label, value in (("domain", domain), ("uri", uri), ("chain_id", chain_id), ("issuer", issuer)):
            if not str(value).strip() or "\n" in str(value) or "\r" in str(value):
                raise WalletAuthConfigurationError(f"Wallet auth {label} must be a non-empty single line.")

        self._secret = secret
        self.domain = str(domain).strip()
        self.uri = str(uri).strip()
        self.chain_id = str(chain_id).strip()
        self.issuer = str(issuer).strip()
        self.challenge_ttl_seconds = int(challenge_ttl_seconds)
        self.session_ttl_seconds = int(session_ttl_seconds)
        self.max_pending_challenges = int(max_pending_challenges)
        self._clock = clock
        self._challenges: dict[str, _ChallengeRecord] = {}
        self._lock = threading.RLock()

    def create_challenge(self, wallet: str, *, now: int | float | None = None) -> WalletChallenge:
        normalized_wallet = normalize_wallet(wallet)
        issued_at = self._now(now)
        expires_at = issued_at + self.challenge_ttl_seconds

        with self._lock:
            self._prune_challenges(issued_at)
            # Only the newest login prompt for a wallet remains valid. This
            # prevents repeated requests for one address from growing memory.
            for existing_nonce, record in list(self._challenges.items()):
                if record.challenge.wallet == normalized_wallet and record.consumed_at is None:
                    self._challenges.pop(existing_nonce, None)
            while len(self._challenges) >= self.max_pending_challenges:
                oldest_nonce = min(
                    self._challenges,
                    key=lambda item: self._challenges[item].challenge.issued_at,
                )
                self._challenges.pop(oldest_nonce, None)
            nonce = self._unique_nonce()
            message = self._challenge_message(normalized_wallet, nonce, issued_at, expires_at)
            challenge = WalletChallenge(
                wallet=normalized_wallet,
                nonce=nonce,
                message=message,
                issued_at=issued_at,
                expires_at=expires_at,
            )
            self._challenges[nonce] = _ChallengeRecord(challenge=challenge)
            return challenge

    def verify_challenge(
        self,
        wallet: str,
        nonce: str,
        signature_b64: str,
        *,
        now: int | float | None = None,
    ) -> WalletSession:
        """Consume a valid challenge and exchange it for a signed session."""

        normalized_wallet = normalize_wallet(wallet)
        clean_nonce = str(nonce or "").strip()
        checked_at = self._now(now)

        with self._lock:
            record = self._checked_challenge(clean_nonce, normalized_wallet, checked_at)
            message = record.challenge.message

        # Signature verification is deliberately outside the lock.  The second
        # atomic check below guarantees that only one concurrent caller wins.
        verify_ed25519_signature(normalized_wallet, message, signature_b64)

        with self._lock:
            record = self._checked_challenge(clean_nonce, normalized_wallet, checked_at)
            record.consumed_at = checked_at

        return self._create_session(normalized_wallet, issued_at=checked_at)

    def verify_session(self, token: str, *, now: int | float | None = None) -> WalletSessionClaims:
        """Validate token integrity and expiry, returning trusted claims."""

        checked_at = self._now(now)
        try:
            encoded_payload, encoded_signature = str(token or "").split(".", 1)
            payload_bytes = _base64url_decode(encoded_payload)
            signature = _base64url_decode(encoded_signature)
        except (TypeError, ValueError) as exc:
            raise WalletAuthError("invalid_session", "Malformed wallet session.") from exc

        expected_signature = hmac.new(self._secret, encoded_payload.encode("ascii"), hashlib.sha256).digest()
        if len(signature) != len(expected_signature) or not hmac.compare_digest(signature, expected_signature):
            raise WalletAuthError("invalid_session", "Invalid wallet session signature.")

        try:
            payload = json.loads(payload_bytes.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise WalletAuthError("invalid_session", "Malformed wallet session payload.") from exc
        if not isinstance(payload, dict):
            raise WalletAuthError("invalid_session", "Malformed wallet session payload.")

        wallet = payload.get("sub")
        session_id = payload.get("jti")
        issued_at = payload.get("iat")
        expires_at = payload.get("exp")
        if (
            payload.get("v") != 1
            or payload.get("iss") != self.issuer
            or not isinstance(wallet, str)
            or not isinstance(session_id, str)
            or not session_id
            or type(issued_at) is not int
            or type(expires_at) is not int
            or expires_at <= issued_at
        ):
            raise WalletAuthError("invalid_session", "Malformed wallet session claims.")
        normalized_wallet = normalize_wallet(wallet)
        if issued_at > checked_at:
            raise WalletAuthError("invalid_session", "Wallet session was issued in the future.")
        if checked_at >= expires_at:
            raise WalletAuthError("session_expired", "Wallet session expired.")
        return WalletSessionClaims(
            wallet=normalized_wallet,
            session_id=session_id,
            issued_at=issued_at,
            expires_at=expires_at,
        )

    def wallet_for_token(self, token: str, *, now: int | float | None = None) -> str:
        return self.verify_session(token, now=now).wallet

    def session_expiry(self, token: str, *, now: int | float | None = None) -> int:
        return self.verify_session(token, now=now).expires_at

    def session_cookie_kwargs(
        self,
        session: WalletSession,
        *,
        secure: bool = True,
        same_site: str = "lax",
    ) -> dict[str, Any]:
        """Arguments accepted directly by Starlette/FastAPI ``set_cookie``."""

        return {
            "key": WALLET_SESSION_COOKIE,
            "value": session.token,
            "max_age": max(0, session.expires_at - session.issued_at),
            "httponly": True,
            "secure": secure,
            "samesite": same_site,
            "path": WALLET_SESSION_COOKIE_PATH,
        }

    @staticmethod
    def clear_cookie_kwargs(*, secure: bool = True, same_site: str = "lax") -> dict[str, Any]:
        """Arguments accepted by ``delete_cookie`` for the session cookie."""

        return {
            "key": WALLET_SESSION_COOKIE,
            "httponly": True,
            "secure": secure,
            "samesite": same_site,
            "path": WALLET_SESSION_COOKIE_PATH,
        }

    def _create_session(self, wallet: str, *, issued_at: int) -> WalletSession:
        expires_at = issued_at + self.session_ttl_seconds
        session_id = secrets.token_urlsafe(18)
        payload = {
            "v": 1,
            "iss": self.issuer,
            "sub": wallet,
            "jti": session_id,
            "iat": issued_at,
            "exp": expires_at,
        }
        encoded_payload = _base64url_encode(
            json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
        )
        signature = hmac.new(self._secret, encoded_payload.encode("ascii"), hashlib.sha256).digest()
        token = f"{encoded_payload}.{_base64url_encode(signature)}"
        return WalletSession(
            token=token,
            wallet=wallet,
            session_id=session_id,
            issued_at=issued_at,
            expires_at=expires_at,
        )

    def _checked_challenge(self, nonce: str, wallet: str, checked_at: int) -> _ChallengeRecord:
        record = self._challenges.get(nonce)
        if record is None:
            raise WalletAuthError("challenge_not_found", "Wallet challenge not found.")
        if record.challenge.wallet != wallet:
            raise WalletAuthError("challenge_wallet_mismatch", "Challenge belongs to another wallet.", status_code=403)
        if record.consumed_at is not None:
            raise WalletAuthError("challenge_used", "Wallet challenge has already been used.", status_code=409)
        if checked_at >= record.challenge.expires_at:
            raise WalletAuthError("challenge_expired", "Wallet challenge expired.")
        return record

    def _challenge_message(self, wallet: str, nonce: str, issued_at: int, expires_at: int) -> str:
        return "\n".join(
            [
                f"{self.domain} wants you to sign in with your Solana account:",
                wallet,
                "",
                "Sign in to Age of Colony. This request does not trigger a blockchain transaction.",
                "",
                f"URI: {self.uri}",
                "Version: 1",
                f"Chain ID: {self.chain_id}",
                f"Nonce: {nonce}",
                f"Issued At: {_iso_utc(issued_at)}",
                f"Expiration Time: {_iso_utc(expires_at)}",
            ]
        )

    def _unique_nonce(self) -> str:
        for _ in range(16):
            nonce = secrets.token_urlsafe(24)
            if nonce not in self._challenges:
                return nonce
        raise RuntimeError("Unable to allocate a unique wallet challenge nonce.")

    def _prune_challenges(self, now: int) -> None:
        retention = self.challenge_ttl_seconds
        stale = [
            nonce
            for nonce, record in self._challenges.items()
            if (
                record.consumed_at is not None
                and record.consumed_at + retention <= now
                or record.challenge.expires_at + retention <= now
            )
        ]
        for nonce in stale:
            self._challenges.pop(nonce, None)

    def _now(self, override: int | float | None) -> int:
        value = self._clock() if override is None else override
        return int(value)


def _iso_utc(timestamp: int) -> str:
    return datetime.fromtimestamp(timestamp, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def _base64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _base64url_decode(value: str) -> bytes:
    if not value or not _B64URL_RE.fullmatch(value):
        raise ValueError("invalid base64url")
    padding = "=" * (-len(value) % 4)
    try:
        return base64.b64decode(value + padding, altchars=b"-_", validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("invalid base64url") from exc
