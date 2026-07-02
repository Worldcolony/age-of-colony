"""Wallet-ownership auth for queen mutations.

A Solana wallet address is a base58-encoded Ed25519 public key, so the
client proves ownership by signing a short timestamped message with
Phantom's ``signMessage``. The server rebuilds the message, checks the
timestamp is fresh (no stored nonces needed), and verifies the Ed25519
signature against the pubkey taken from the URL path. On mismatch the
mutation is rejected — no one can amend or dethrone another wallet's queen.
"""
from __future__ import annotations

import base64
import time

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from fastapi import Header, HTTPException

QUEEN_AUTH_WINDOW_SECONDS = 300  # signed message accepted for +/- 5 minutes

_B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
_B58_INDEX = {char: index for index, char in enumerate(_B58_ALPHABET)}


def base58_decode(value: str) -> bytes:
    number = 0
    for char in value:
        digit = _B58_INDEX.get(char)
        if digit is None:
            raise ValueError(f"invalid base58 character: {char!r}")
        number = number * 58 + digit
    decoded = number.to_bytes((number.bit_length() + 7) // 8, "big")
    pad = len(value) - len(value.lstrip("1"))
    return b"\x00" * pad + decoded


def queen_auth_message(wallet: str, timestamp: int) -> str:
    return f"age-of-colony:queen:{wallet}:{timestamp}"


def verify_wallet_signature(wallet: str, signature_b64: str, timestamp: str) -> None:
    """Raise HTTPException unless the signature proves ownership of ``wallet``."""
    try:
        ts = int(timestamp)
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=401, detail="Invalid signature timestamp.") from exc
    if abs(time.time() - ts) > QUEEN_AUTH_WINDOW_SECONDS:
        raise HTTPException(status_code=401, detail="Signature expired — sign again.")

    try:
        pubkey_bytes = base58_decode(wallet.strip())
        if len(pubkey_bytes) != 32:
            raise ValueError("pubkey must be 32 bytes")
        signature = base64.b64decode(signature_b64, validate=True)
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=401, detail="Malformed wallet or signature.") from exc

    message = queen_auth_message(wallet.strip(), ts).encode("utf-8")
    try:
        Ed25519PublicKey.from_public_bytes(pubkey_bytes).verify(signature, message)
    except InvalidSignature as exc:
        raise HTTPException(status_code=403, detail="Signature does not match this wallet.") from exc


async def require_wallet_owner(
    wallet: str,
    x_aoc_signature: str = Header(default=""),
    x_aoc_ts: str = Header(default=""),
) -> str:
    """FastAPI dependency: the path wallet must have signed the challenge."""
    if not x_aoc_signature or not x_aoc_ts:
        raise HTTPException(
            status_code=401,
            detail="Wallet signature required — sign the queen challenge with Phantom.",
        )
    verify_wallet_signature(wallet, x_aoc_signature, x_aoc_ts)
    return wallet
