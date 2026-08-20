"""Licence tokens — minted at checkout, verified on arrival, no database.

WHY THIS EXISTS. The Chrome Web Store listing is public and `/map-redacted` was
open, so anyone who installed the extension got mappings on the owner's
Anthropic budget — and so did anyone with `curl` and the URL, no extension
involved. Gating the *download* cannot close that: Chrome blocks self-hosted
CRX outside enterprise policy, and an unlisted item is still installable by
anyone holding the link. The gate therefore sits on the call that costs money.

WHY A SIGNED TOKEN rather than asking Stripe whether the subscription is live:

- The server is stateless and that is load-bearing — `README.md` says publicly
  that there is no database, and that sentence is why a clinician is being asked
  to trust this at all. A subscriber table would make it false.
- A Stripe call in the latency path of every mapping makes a Stripe outage, or a
  Stripe rate limit, into a BreezeFill outage.

A signature is checked here, locally, against a secret this process already
holds. Stripe stays the only subscriber list; it just is not consulted per
request.

THE COST OF THE DESIGN, stated because it is real and permanent: **a leaked
token keeps working until it expires.** Revocation IS expiry, so the lifetime is
the revocation window — 30 days by default, renewed silently while the
subscription is live. There is deliberately no revocation list, because a list is
the database this product says it does not have. If a token ever needs killing
sooner than its expiry, the lever is rotating the signing secret, which
invalidates every token at once and is a blunt instrument by design.

DO NOT REUSE THIS AS THE CREDENTIAL FOR A DOCTOR'S PROFILE, or for anything
else holding personal data. It was suggested on 2026-08-19 and rejected on the
strength of the paragraph directly above: no revocation short of rotating the
secret for everyone, a 30-day window, and a token that by design gets pasted
into support email. Those are fine costs for a paywall and disqualifying for
PII. It is also per-SUBSCRIPTION, so it cannot tell two doctors at one clinic
apart. See the IMPORTANT section at the end of CLAUDE.md.

WHAT A TOKEN CARRIES: a Stripe subscription id and two timestamps. Nothing else.
No email, no name, no clinic. The payload is base64, not encryption — anyone
holding the token can read it — and a token gets pasted into panels, quoted in
support email and pasted into chat transcripts, so it carries the least that
still allows support and renewal. It is a credential; treat it the way
`mapping.py` treats a ClaimEZ `?pid=`. Never log one.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time


class LicenceError(Exception):
    """A token that cannot be trusted, for any reason.

    One exception rather than one per cause, and deliberately: the caller must
    not be able to tell a doctor *why* their token failed in enough detail to
    help someone forge one. The panel says "this licence is not valid" and the
    owner looks it up by subscription id.
    """


# 30 days. Long enough that renewal is invisible while a subscription is live,
# short enough that a cancelled one stops working within a billing cycle. This
# is the revocation window — see the module docstring before changing it.
DEFAULT_LIFETIME_DAYS = 30


def _b64(raw: bytes) -> str:
    """URL-safe base64 with the padding stripped.

    Padding is stripped because a token is copied by hand out of an email, and
    a trailing "=" is the character most likely to be lost or escaped on the
    way. `_unb64` puts it back.
    """
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _unb64(text: str) -> bytes:
    # Restore the padding base64 needs: length must be a multiple of 4.
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def mint_licence(subscription_id: str, secret: str, lifetime_days: int = DEFAULT_LIFETIME_DAYS) -> str:
    """A token for one subscription, valid for `lifetime_days`.

    Called from the Stripe webhook at checkout and again at each renewal. Not
    called from any request path a doctor can reach — minting is issuance, and
    an endpoint that mints on demand is an endpoint that gives the product away.
    """
    if not secret:
        raise LicenceError("no signing secret")
    now = int(time.time())
    payload = _b64(
        json.dumps(
            {"sub": subscription_id, "iat": now, "exp": now + lifetime_days * 86400},
            separators=(",", ":"),
            sort_keys=True,
        ).encode()
    )
    return f"{payload}.{_sign(payload, secret)}"


def _sign(payload: str, secret: str) -> str:
    return _b64(hmac.new(secret.encode(), payload.encode(), hashlib.sha256).digest())


def verify_licence(token: str, secret: str) -> dict:
    """The claims in `token`, or `LicenceError`.

    Signature first, then expiry. That ordering matters: an expired token whose
    signature does not check out is a forgery, not a lapsed subscription, and
    reading its claims before verifying them is how a forged `exp` gets
    believed.
    """
    # The dangerous default. A deploy that forgot to set the secret must verify
    # NOTHING rather than everything — an empty secret is a valid HMAC key, so
    # without this check a misconfiguration silently opens the gate wide.
    if not secret:
        raise LicenceError("no signing secret")
    if not isinstance(token, str) or token.count(".") != 1:
        raise LicenceError("malformed token")

    payload, signature = token.strip().split(".")
    if not payload or not signature:
        raise LicenceError("malformed token")

    # compare_digest, never `==`. String equality short-circuits on the first
    # differing byte, which leaks how much of a guessed signature was right and
    # turns forgery into a few thousand requests. The two read identically.
    if not hmac.compare_digest(signature, _sign(payload, secret)):
        raise LicenceError("bad signature")

    try:
        claims = json.loads(_unb64(payload))
    except Exception as exc:
        # Signed by us and still unreadable means a minting bug, not an attack.
        raise LicenceError("unreadable claims") from exc

    if not isinstance(claims, dict) or "exp" not in claims or "sub" not in claims:
        raise LicenceError("incomplete claims")
    if int(claims["exp"]) <= int(time.time()):
        raise LicenceError("expired")

    return claims
