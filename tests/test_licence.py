"""Licence tokens: minted at checkout, verified on arrival, no database.

The gate exists because the store listing is public and `/map-redacted` was
open: anyone who installed the extension — or anyone with `curl` and the URL —
got mappings on the owner's Anthropic budget. Gating the *download* cannot fix
that and Chrome does not allow it anyway, so the gate is here, on the call that
costs money.

Why a signed token rather than asking Stripe per request: the server is
stateless and must stay that way, and a Stripe call in the latency path of every
mapping makes a Stripe outage a BreezeFill outage. A signature is checked
locally in microseconds against a secret this process already holds.

What that trades away, stated plainly because it is the whole cost of the
design: a leaked token keeps working until it expires. Revocation is expiry, so
the lifetime IS the revocation window. There is no revocation list, because a
list is the database this product says it does not have.
"""

import base64
import hmac
import hashlib
import json
import time

import pytest

from licence import LicenceError, mint_licence, verify_licence


SECRET = "test-secret-not-a-real-one"


class TestMintAndVerify:
    def test_a_minted_token_verifies(self):
        token = mint_licence("sub_123", SECRET, lifetime_days=30)
        claims = verify_licence(token, SECRET)
        assert claims["sub"] == "sub_123"

    def test_the_subscription_id_survives_the_round_trip(self):
        # It is what support and revocation are keyed on. Nothing else about the
        # customer goes in: no email, no name, no clinic. A token is handled by
        # the same people who handle notes, so it carries the least it can.
        token = mint_licence("sub_abc123", SECRET, lifetime_days=1)
        assert verify_licence(token, SECRET)["sub"] == "sub_abc123"

    def test_no_personal_data_is_encoded_in_the_token(self):
        # A token is pasted into a panel, quoted in a support email and pasted
        # into a chat transcript. It must not be a place a customer's identity
        # leaks, and the payload is base64 — readable by anyone holding it.
        token = mint_licence("sub_123", SECRET, lifetime_days=30)
        payload = json.loads(base64.urlsafe_b64decode(token.split(".")[0] + "=="))
        assert set(payload) == {"sub", "iat", "exp"}


class TestRefusals:
    """Every one of these is a refusal, and each is asserted alongside the
    positive case above — a verifier that rejected everything would pass a suite
    that only checked rejections."""

    def test_a_tampered_payload_is_refused(self):
        token = mint_licence("sub_123", SECRET, lifetime_days=30)
        payload, _ = token.split(".")
        forged = json.dumps({"sub": "sub_free", "iat": 0, "exp": 9999999999}).encode()
        tampered = base64.urlsafe_b64encode(forged).decode().rstrip("=") + "." + token.split(".")[1]
        with pytest.raises(LicenceError):
            verify_licence(tampered, SECRET)

    def test_a_token_signed_with_another_secret_is_refused(self):
        token = mint_licence("sub_123", "some-other-secret", lifetime_days=30)
        with pytest.raises(LicenceError):
            verify_licence(token, SECRET)

    def test_an_expired_token_is_refused(self):
        token = mint_licence("sub_123", SECRET, lifetime_days=-1)
        with pytest.raises(LicenceError):
            verify_licence(token, SECRET)

    def test_a_token_expiring_later_today_still_works(self):
        # The positive half of the expiry rule. A subscription that lapses at
        # midnight must not stop working at breakfast.
        token = mint_licence("sub_123", SECRET, lifetime_days=1)
        assert verify_licence(token, SECRET)["sub"] == "sub_123"

    def test_a_malformed_token_is_refused_rather_than_crashing(self):
        # These arrive by copy-paste out of an email, so a truncated or
        # whitespace-mangled one is the ordinary case, not the adversarial one.
        for bad in ["", "   ", "not-a-token", "a.b.c", "....", "abc.", ".abc"]:
            with pytest.raises(LicenceError):
                verify_licence(bad, SECRET)

    def test_verification_without_a_secret_refuses_rather_than_accepting(self):
        # The dangerous default. A misconfigured deploy with no secret set must
        # not verify everything successfully — it must verify nothing.
        token = mint_licence("sub_123", SECRET, lifetime_days=30)
        with pytest.raises(LicenceError):
            verify_licence(token, "")

    def test_the_signature_comparison_is_constant_time(self):
        # Not a timing measurement — an assertion about the code, because the
        # obvious `==` is the thing to get wrong here and it reads identically.
        import inspect
        import licence

        assert "compare_digest" in inspect.getsource(licence.verify_licence)


class TestSignatureShape:
    def test_the_signature_is_over_the_payload_and_nothing_else(self):
        # Pinned so a future change to the encoding cannot silently invalidate
        # every token in a doctor's browser without a test saying so.
        token = mint_licence("sub_123", SECRET, lifetime_days=30)
        payload, signature = token.split(".")
        expected = hmac.new(SECRET.encode(), payload.encode(), hashlib.sha256).digest()
        assert signature == base64.urlsafe_b64encode(expected).decode().rstrip("=")
