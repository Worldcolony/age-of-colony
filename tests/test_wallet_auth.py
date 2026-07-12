import base64
import unittest

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from app.wallet_auth import (
    WALLET_SESSION_COOKIE,
    WalletAuthConfigurationError,
    WalletAuthError,
    WalletAuthManager,
    verify_ed25519_signature,
)


_B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def _base58_encode(value: bytes) -> str:
    number = int.from_bytes(value, "big")
    encoded = ""
    while number:
        number, remainder = divmod(number, 58)
        encoded = _B58_ALPHABET[remainder] + encoded
    leading_zeroes = len(value) - len(value.lstrip(b"\x00"))
    return "1" * leading_zeroes + (encoded or "")


def _wallet(private_key: Ed25519PrivateKey) -> str:
    raw = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    return _base58_encode(raw)


def _sign(private_key: Ed25519PrivateKey, message: str) -> str:
    return base64.b64encode(private_key.sign(message.encode("utf-8"))).decode("ascii")


class WalletAuthTest(unittest.TestCase):
    def setUp(self) -> None:
        self.private_key = Ed25519PrivateKey.generate()
        self.wallet = _wallet(self.private_key)
        self.manager = WalletAuthManager(
            b"wallet-auth-test-secret-is-at-least-32-bytes",
            domain="localhost:3000",
            uri="http://localhost:3000",
            challenge_ttl_seconds=300,
            session_ttl_seconds=900,
        )

    def test_challenge_is_unique_and_has_a_canonical_public_message(self):
        first = self.manager.create_challenge(self.wallet, now=1_000)
        second = self.manager.create_challenge(self.wallet, now=1_000)

        self.assertNotEqual(first.nonce, second.nonce)
        self.assertNotEqual(first.message, second.message)
        self.assertIn(f"Nonce: {first.nonce}", first.message)
        self.assertIn(f"Expiration Time: 1970-01-01T00:21:40Z", first.message)
        self.assertEqual(
            first.public_state(),
            {
                "wallet": self.wallet,
                "nonce": first.nonce,
                "message": first.message,
                "issuedAt": 1_000,
                "expiresAt": 1_300,
            },
        )

    def test_valid_signature_consumes_challenge_and_returns_short_session(self):
        challenge = self.manager.create_challenge(self.wallet, now=2_000)
        session = self.manager.verify_challenge(
            self.wallet,
            challenge.nonce,
            _sign(self.private_key, challenge.message),
            now=2_010,
        )

        self.assertEqual(session.wallet, self.wallet)
        self.assertEqual(session.issued_at, 2_010)
        self.assertEqual(session.expires_at, 2_910)
        self.assertEqual(self.manager.wallet_for_token(session.token, now=2_500), self.wallet)
        self.assertEqual(self.manager.session_expiry(session.token, now=2_500), 2_910)
        self.assertNotIn("token", session.public_state())
        self.assertEqual(self.manager.session_cookie_kwargs(session)["key"], WALLET_SESSION_COOKIE)
        self.assertTrue(self.manager.session_cookie_kwargs(session)["httponly"])

    def test_challenge_cannot_be_replayed(self):
        challenge = self.manager.create_challenge(self.wallet, now=3_000)
        signature = _sign(self.private_key, challenge.message)
        self.manager.verify_challenge(self.wallet, challenge.nonce, signature, now=3_001)

        with self.assertRaises(WalletAuthError) as raised:
            self.manager.verify_challenge(self.wallet, challenge.nonce, signature, now=3_002)

        self.assertEqual(raised.exception.code, "challenge_used")
        self.assertEqual(raised.exception.status_code, 409)

    def test_expired_challenge_is_rejected(self):
        challenge = self.manager.create_challenge(self.wallet, now=4_000)

        with self.assertRaises(WalletAuthError) as raised:
            self.manager.verify_challenge(
                self.wallet,
                challenge.nonce,
                _sign(self.private_key, challenge.message),
                now=challenge.expires_at,
            )

        self.assertEqual(raised.exception.code, "challenge_expired")

    def test_invalid_signature_does_not_consume_challenge(self):
        challenge = self.manager.create_challenge(self.wallet, now=5_000)
        attacker = Ed25519PrivateKey.generate()

        with self.assertRaises(WalletAuthError) as raised:
            self.manager.verify_challenge(
                self.wallet,
                challenge.nonce,
                _sign(attacker, challenge.message),
                now=5_001,
            )
        self.assertEqual(raised.exception.code, "invalid_signature")

        session = self.manager.verify_challenge(
            self.wallet,
            challenge.nonce,
            _sign(self.private_key, challenge.message),
            now=5_002,
        )
        self.assertEqual(session.wallet, self.wallet)

    def test_challenge_cannot_be_exchanged_for_another_wallet(self):
        challenge = self.manager.create_challenge(self.wallet, now=6_000)
        other_private_key = Ed25519PrivateKey.generate()
        other_wallet = _wallet(other_private_key)

        with self.assertRaises(WalletAuthError) as raised:
            self.manager.verify_challenge(
                other_wallet,
                challenge.nonce,
                _sign(other_private_key, challenge.message),
                now=6_001,
            )

        self.assertEqual(raised.exception.code, "challenge_wallet_mismatch")

    def test_session_expires_and_tampering_is_rejected(self):
        challenge = self.manager.create_challenge(self.wallet, now=7_000)
        session = self.manager.verify_challenge(
            self.wallet,
            challenge.nonce,
            _sign(self.private_key, challenge.message),
            now=7_001,
        )

        with self.assertRaises(WalletAuthError) as expired:
            self.manager.wallet_for_token(session.token, now=session.expires_at)
        self.assertEqual(expired.exception.code, "session_expired")

        payload, signature = session.token.split(".")
        replacement = "A" if payload[-1] != "A" else "B"
        tampered = f"{payload[:-1]}{replacement}.{signature}"
        with self.assertRaises(WalletAuthError) as invalid:
            self.manager.wallet_for_token(tampered, now=7_002)
        self.assertEqual(invalid.exception.code, "invalid_session")

    def test_token_is_bound_to_manager_secret(self):
        challenge = self.manager.create_challenge(self.wallet, now=8_000)
        session = self.manager.verify_challenge(
            self.wallet,
            challenge.nonce,
            _sign(self.private_key, challenge.message),
            now=8_001,
        )
        other_manager = WalletAuthManager(b"another-wallet-session-secret-with-32-bytes")

        with self.assertRaises(WalletAuthError) as raised:
            other_manager.wallet_for_token(session.token, now=8_002)

        self.assertEqual(raised.exception.code, "invalid_session")

    def test_generic_signature_validation_and_malformed_wallet(self):
        message = "Age of Colony test challenge"
        signature = _sign(self.private_key, message)

        self.assertEqual(verify_ed25519_signature(self.wallet, message, signature), self.wallet)
        with self.assertRaises(WalletAuthError) as raised:
            verify_ed25519_signature("not-a-solana-wallet", message, signature)
        self.assertEqual(raised.exception.code, "invalid_wallet")

    def test_short_session_secret_is_rejected(self):
        with self.assertRaises(WalletAuthConfigurationError):
            WalletAuthManager("too-short")

    def test_pending_challenges_are_bounded_and_newest_wallet_prompt_wins(self):
        manager = WalletAuthManager(
            b"bounded-wallet-auth-test-secret-at-least-32-bytes",
            max_pending_challenges=2,
        )
        first_key = Ed25519PrivateKey.generate()
        first_wallet = _wallet(first_key)
        obsolete = manager.create_challenge(first_wallet, now=10_000)
        newest = manager.create_challenge(first_wallet, now=10_001)

        with self.assertRaises(WalletAuthError) as replaced:
            manager.verify_challenge(
                first_wallet,
                obsolete.nonce,
                _sign(first_key, obsolete.message),
                now=10_002,
            )
        self.assertEqual(replaced.exception.code, "challenge_not_found")

        second_key = Ed25519PrivateKey.generate()
        second = manager.create_challenge(_wallet(second_key), now=10_002)
        third_key = Ed25519PrivateKey.generate()
        third = manager.create_challenge(_wallet(third_key), now=10_003)
        self.assertEqual(len(manager._challenges), 2)
        self.assertNotIn(newest.nonce, manager._challenges)
        self.assertIn(second.nonce, manager._challenges)
        self.assertIn(third.nonce, manager._challenges)


if __name__ == "__main__":
    unittest.main()
