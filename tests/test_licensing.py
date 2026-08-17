"""Licensing: what a key proves, and what it deliberately does not.

Stripe is injected everywhere it is used, so none of this needs the package
configured or a network call. The fakes below are the smallest thing that
behaves like the two Stripe surfaces this module touches.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

import licensing  # noqa: E402

SECRET = "test-secret-not-a-real-one"
CUSTOMER = "cus_TestOnly123"


@pytest.fixture(autouse=True)
def secret(monkeypatch):
    monkeypatch.setenv("BREEZEFILL_LICENCE_SECRET", SECRET)


class FakeSubscriptions:
    def __init__(self, statuses, raises=None):
        self.statuses = statuses
        self.raises = raises
        self.calls = []

    def list(self, customer, limit=10):
        self.calls.append(customer)
        if self.raises:
            raise self.raises
        return type("Page", (), {"data": [{"status": s} for s in self.statuses]})()


class FakeStripe:
    def __init__(self, statuses=(), raises=None, session=None, session_raises=None):
        self.Subscription = FakeSubscriptions(statuses, raises)
        outer = self

        class Session:
            @staticmethod
            def retrieve(session_id):
                outer.retrieved = session_id
                if session_raises:
                    raise session_raises
                return session

        self.checkout = type("Checkout", (), {"Session": Session})()
        self.retrieved = None


# ---------------------------------------------------------------------------
# The key itself
# ---------------------------------------------------------------------------


def test_a_minted_licence_round_trips_to_its_customer():
    assert licensing.customer_of(licensing.mint(CUSTOMER)) == CUSTOMER


def test_a_licence_cannot_be_forged_from_a_guessed_customer_id():
    # The whole point of signing it. Anyone can guess a `cus_` id; nobody can
    # produce the HMAC without the server secret, so a doctor cannot mint a
    # colleague's key or their own.
    packed = licensing.mint(CUSTOMER).split(".")[0]
    with pytest.raises(licensing.LicenceError):
        licensing.customer_of(f"{packed}.{'0' * 32}")


def test_a_licence_signed_with_a_different_secret_is_refused(monkeypatch):
    # Rotating BREEZEFILL_LICENCE_SECRET invalidates every key in the field.
    # That is the intended behaviour and the reason it is worth asserting:
    # rotating it is a support event, not a silent one.
    stale = licensing.mint(CUSTOMER)
    monkeypatch.setenv("BREEZEFILL_LICENCE_SECRET", "a-different-secret")
    with pytest.raises(licensing.LicenceError):
        licensing.customer_of(stale)


@pytest.mark.parametrize(
    "junk",
    ["", "   ", "bf_", "bf_nodot", "sk_live_something", "bf_!!!.0000", "bf_.0000"],
)
def test_malformed_keys_are_refused_rather_than_crashing(junk):
    # A panel sends whatever the doctor pasted, including a Stripe key pasted
    # into the wrong box. None of it may reach a traceback.
    with pytest.raises(licensing.LicenceError):
        licensing.customer_of(junk)


def test_issuing_needs_a_secret(monkeypatch):
    # A server with no secret configured must refuse to mint rather than sign
    # with the empty string, which would make every key forgeable by anyone
    # who noticed.
    monkeypatch.delenv("BREEZEFILL_LICENCE_SECRET", raising=False)
    with pytest.raises(licensing.LicenceError):
        licensing.mint(CUSTOMER)


# ---------------------------------------------------------------------------
# What Stripe says about it
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("state", ["active", "trialing"])
def test_a_paid_up_subscription_is_active(state):
    stripe = FakeStripe(statuses=[state])
    status = licensing.status_of(licensing.mint(CUSTOMER), stripe)
    assert status.active is True
    assert status.unknown is False
    assert stripe.Subscription.calls == [CUSTOMER]


@pytest.mark.parametrize("state", ["canceled", "past_due", "unpaid", "incomplete_expired"])
def test_a_lapsed_subscription_is_not(state):
    # The signature still verifies — a cancelled customer's key is a real key.
    # Only the live status can say it has stopped, which is why the HMAC is
    # never the whole check.
    status = licensing.status_of(licensing.mint(CUSTOMER), FakeStripe(statuses=[state]))
    assert status.active is False
    assert status.unknown is False


def test_a_customer_with_no_subscriptions_is_not_active():
    status = licensing.status_of(licensing.mint(CUSTOMER), FakeStripe(statuses=[]))
    assert status.active is False


def test_one_live_subscription_among_several_is_enough():
    # A clinic that cancelled once and resubscribed has both on the customer.
    status = licensing.status_of(
        licensing.mint(CUSTOMER), FakeStripe(statuses=["canceled", "active"])
    )
    assert status.active is True


def test_stripe_being_down_lets_a_paid_doctor_keep_working():
    # THE DELIBERATE ASYMMETRY. Refusing a paid-up doctor mid-clinic because a
    # payment provider is having a bad afternoon stops patient work; letting an
    # unpaid one through for the length of an outage costs a few claims. It is
    # reported as `unknown` so nothing downstream can present the guess as a
    # verified fact.
    status = licensing.status_of(
        licensing.mint(CUSTOMER), FakeStripe(raises=RuntimeError("boom"))
    )
    assert status.active is True
    assert status.unknown is True
    assert status.status == "unverified"


def test_an_outage_still_does_not_excuse_a_forged_key():
    # Failing open applies to "we could not ask Stripe", never to "this key was
    # not signed by us". A forged key is refused before any network call, so an
    # outage cannot be used as a way in.
    with pytest.raises(licensing.LicenceError):
        licensing.status_of("bf_bogus.0000", FakeStripe(raises=RuntimeError("boom")))


def test_no_stripe_error_detail_reaches_the_caller(caplog):
    # A Stripe exception can quote the request, and the request names a paying
    # customer. Type only, the same rule clinical text follows.
    licensing.status_of(
        licensing.mint(CUSTOMER),
        FakeStripe(raises=RuntimeError("card 4242 for Dr Tan Mei Ling")),
    )
    assert "Tan Mei Ling" not in caplog.text
    assert "4242" not in caplog.text


# ---------------------------------------------------------------------------
# Claiming one after checkout
# ---------------------------------------------------------------------------


def test_a_paid_checkout_yields_a_working_licence():
    stripe = FakeStripe(session={"payment_status": "paid", "customer": CUSTOMER})
    licence = licensing.claim("cs_test_123", stripe)
    assert licensing.customer_of(licence) == CUSTOMER
    assert stripe.retrieved == "cs_test_123"


def test_an_unpaid_checkout_yields_nothing():
    # The session id exists the moment checkout opens, so having one proves
    # somebody started paying, not that they finished.
    stripe = FakeStripe(session={"payment_status": "unpaid", "customer": CUSTOMER})
    with pytest.raises(licensing.LicenceError):
        licensing.claim("cs_test_123", stripe)


def test_an_expanded_customer_object_is_accepted_too():
    # Stripe hands back an id or an object depending on the call, and a change
    # in expansion must not silently stop issuing licences.
    stripe = FakeStripe(session={"payment_status": "paid", "customer": {"id": CUSTOMER}})
    assert licensing.customer_of(licensing.claim("cs_test_123", stripe)) == CUSTOMER


def test_an_unknown_session_is_refused_without_leaking_why():
    stripe = FakeStripe(session_raises=RuntimeError("No such session: cs_evil"))
    with pytest.raises(licensing.LicenceError) as caught:
        licensing.claim("cs_evil", stripe)
    assert "cs_evil" not in str(caught.value)


def test_no_session_id_is_refused_before_stripe_is_called():
    stripe = FakeStripe(session={"payment_status": "paid", "customer": CUSTOMER})
    with pytest.raises(licensing.LicenceError):
        licensing.claim("", stripe)
    assert stripe.retrieved is None


# ---------------------------------------------------------------------------
# The switch
# ---------------------------------------------------------------------------


def test_the_gate_is_off_unless_switched_on(monkeypatch):
    # Off by default: shipping this module must not stop a single doctor
    # working until somebody decides it should.
    monkeypatch.delenv("FORMFILL_REQUIRE_LICENCE", raising=False)
    assert licensing.required() is False
    monkeypatch.setenv("FORMFILL_REQUIRE_LICENCE", "1")
    assert licensing.required() is True
