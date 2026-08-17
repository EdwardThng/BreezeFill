"""Subscriptions, without a subscriber list.

Stripe already knows who is paying, so this module's whole job is to turn that
into an answer for one question — *may this browser map a claim?* — without
this backend ever holding a database of its own. `README.md` says publicly that
there is no patient database here, and a `subscribers` table beside it would be
the first thing anyone points at when asking whether that is still true.

The licence key IS the Stripe identity, signed:

    bf_<base64url(customer_id)>.<hmac_sha256(customer_id, SECRET)[:32]>

Two properties come out of that shape and both matter:

* **It is self-describing.** The customer id is in the key, so a request
  carrying one can be checked against Stripe directly. Nothing has to be looked
  up in a store that does not exist.
* **It cannot be minted by the holder.** The HMAC is over the customer id with
  a server secret, so a doctor cannot invent a colleague's key by guessing a
  customer id, and a leaked key names exactly one subscription that can be
  cancelled.

The signature alone is never enough to let a claim through, because a signature
cannot expire. Every check asks Stripe for the subscription's live status; the
HMAC is only there to reject junk before spending a network call on it.

WHAT THIS MODULE MUST NEVER DO
------------------------------
Log, return, or raise anything containing the secret key or a customer's
personal details. A Stripe error can quote a request body; only its type is
ever recorded here, the same rule `_review_rows` follows for clinical text.
"""

from __future__ import annotations

import base64
import hmac
import logging
import os
from dataclasses import dataclass
from hashlib import sha256

logger = logging.getLogger("breezefill.licensing")

# Statuses that mean "this clinic is paid up". `trialing` counts: a trial is a
# subscription Stripe is managing, and refusing it would break the one flow
# most likely to be used to evaluate the product.
LIVE_STATUSES = frozenset({"active", "trialing"})

PREFIX = "bf_"


class LicenceError(Exception):
    """A licence that cannot be honoured, with a reason safe to show a doctor."""


@dataclass(frozen=True)
class LicenceStatus:
    """The answer to "may this browser map a claim", and why."""

    active: bool
    #: Stripe's own word for it, or a local reason. Shown in the panel.
    status: str
    #: True when the answer is "we could not tell", as opposed to "no".
    unknown: bool = False


def _secret() -> str:
    secret = os.environ.get("BREEZEFILL_LICENCE_SECRET", "")
    if not secret:
        raise LicenceError("This server cannot issue licences.")
    return secret


def _sign(customer_id: str) -> str:
    return hmac.new(
        _secret().encode("utf-8"), customer_id.encode("utf-8"), sha256
    ).hexdigest()[:32]


def mint(customer_id: str) -> str:
    """A licence key for a Stripe customer. Nothing is stored."""
    if not customer_id:
        raise LicenceError("No customer on that subscription.")
    packed = base64.urlsafe_b64encode(customer_id.encode("utf-8")).decode("ascii").rstrip("=")
    return f"{PREFIX}{packed}.{_sign(customer_id)}"


def customer_of(licence: str) -> str:
    """The customer id inside a licence, if the signature holds.

    `compare_digest` rather than `==`: the comparison is against a secret and a
    timing difference is a slow way to forge one. Cheap to do right.
    """
    licence = (licence or "").strip()
    if not licence.startswith(PREFIX) or "." not in licence:
        raise LicenceError("That licence key is not one of ours.")
    packed, _, signature = licence[len(PREFIX):].partition(".")
    try:
        padding = "=" * (-len(packed) % 4)
        customer_id = base64.urlsafe_b64decode(packed + padding).decode("utf-8")
    except Exception as exc:  # noqa: BLE001 - any malformed key lands here
        raise LicenceError("That licence key is not one of ours.") from exc
    if not customer_id or not hmac.compare_digest(signature, _sign(customer_id)):
        raise LicenceError("That licence key is not one of ours.")
    return customer_id


def status_of(licence: str, stripe_module) -> LicenceStatus:
    """Live subscription status for a licence.

    `stripe_module` is injected rather than imported at the top so the tests
    never need the package configured, and so a future move to another
    processor changes one call site.

    FAILS OPEN on a Stripe outage, and this is a deliberate asymmetry rather
    than an oversight. The two errors are not the same size: refusing a paid-up
    doctor mid-clinic because a payment provider is having a bad afternoon
    stops patient work, while letting an unpaid one through for the length of
    an outage costs a few claims. `unknown` is set so the caller can say which
    happened rather than reporting a guess as a fact.
    """
    customer_id = customer_of(licence)  # raises on a forged or malformed key
    try:
        subscriptions = stripe_module.Subscription.list(customer=customer_id, limit=10)
    except Exception as exc:  # noqa: BLE001 - Stripe raises a family of these
        # Type only. A Stripe exception can quote the request, and the request
        # names a paying customer.
        logger.error("stripe unreachable: %s", type(exc).__name__)
        return LicenceStatus(active=True, status="unverified", unknown=True)

    for subscription in getattr(subscriptions, "data", []) or []:
        state = subscription.get("status") if isinstance(subscription, dict) else subscription.status
        if state in LIVE_STATUSES:
            return LicenceStatus(active=True, status=state)
    return LicenceStatus(active=False, status="inactive")


def claim(session_id: str, stripe_module) -> str:
    """Turn a completed Stripe Checkout session into a licence key.

    Called once, by the page Stripe redirects back to. The session id is the
    proof of payment: it is minted by Stripe, it names one checkout, and it is
    useless to anyone who did not just complete it — which is why the funnel
    exchanges it here rather than trusting a `?paid=1` in the URL, a string
    anybody can type.
    """
    if not session_id:
        raise LicenceError("No checkout to look up.")
    try:
        session = stripe_module.checkout.Session.retrieve(session_id)
    except Exception as exc:  # noqa: BLE001
        logger.error("stripe checkout lookup failed: %s", type(exc).__name__)
        raise LicenceError("That checkout could not be confirmed.") from exc

    paid = (session.get("payment_status") if isinstance(session, dict) else session.payment_status)
    if paid not in {"paid", "no_payment_required"}:
        raise LicenceError("That checkout has not been paid.")
    customer = session.get("customer") if isinstance(session, dict) else session.customer
    # Stripe returns either an id or an expanded object depending on the call.
    if not isinstance(customer, str):
        customer = getattr(customer, "id", None) or (customer or {}).get("id")
    return mint(customer or "")


def required() -> bool:
    """Whether a licence is enforced at all.

    Off by default, and the switch is an environment variable rather than a
    deploy so the gate can be turned on the day the panel that carries a key
    reaches enough browsers — and turned off again in one step if it turns out
    to be refusing people who have paid.
    """
    return bool(os.environ.get("FORMFILL_REQUIRE_LICENCE"))
