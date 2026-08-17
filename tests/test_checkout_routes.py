"""Opening a checkout, and turning a paid one into a licence.

`licence.py` covers what a token IS. This covers how one is obtained, which is
the half that talks to Stripe — so Stripe is replaced here by a fake module
inserted into `sys.modules`, because `main._stripe()` imports it inside the
function precisely so it can be absent.

Nothing here needs a Stripe account, a key, or a network call.
"""

from __future__ import annotations

import sys
import types
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

import main  # noqa: E402
from licence import verify_licence  # noqa: E402

SECRET = "test-signing-secret"
client = TestClient(main.app)


class FakeSessions:
    """Stripe's checkout.Session, in the two shapes main.py uses."""

    def __init__(self):
        self.created = None
        self.create_raises = None
        self.retrieve_raises = None
        self.stored = {}

    def create(self, **kwargs):
        if self.create_raises:
            raise self.create_raises
        self.created = kwargs
        return types.SimpleNamespace(url="https://checkout.stripe.com/c/pay/cs_test_1")

    def retrieve(self, session_id):
        if self.retrieve_raises:
            raise self.retrieve_raises
        if session_id not in self.stored:
            raise RuntimeError(f"No such checkout.session: {session_id}")
        return self.stored[session_id]


@pytest.fixture
def stripe(monkeypatch):
    sessions = FakeSessions()
    fake = types.ModuleType("stripe")
    fake.api_key = None
    fake.checkout = types.SimpleNamespace(Session=sessions)
    monkeypatch.setitem(sys.modules, "stripe", fake)
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_not_a_real_key")
    monkeypatch.setenv("STRIPE_PRICE_ID", "price_test_123")
    monkeypatch.setenv("FORMFILL_LICENCE_SECRET", SECRET)
    sessions.module = fake
    return sessions


# ---------------------------------------------------------------------------
# POST /checkout
# ---------------------------------------------------------------------------


def test_checkout_returns_a_stripe_url(stripe):
    response = client.post("/checkout")
    assert response.status_code == 200
    assert response.json()["url"].startswith("https://checkout.stripe.com/")


def test_checkout_asks_for_a_subscription_to_the_configured_price(stripe):
    client.post("/checkout")
    assert stripe.created["mode"] == "subscription"
    assert stripe.created["line_items"] == [{"price": "price_test_123", "quantity": 1}]


def test_the_return_address_is_built_by_the_server_and_carries_the_session(stripe):
    # Never from the request. A client-supplied success_url on a payment flow
    # is an open redirect with a Stripe checkout in front of it — and the
    # placeholder is what lets the page prove the payment afterwards.
    client.post("/checkout")
    assert stripe.created["success_url"].startswith(main.SITE_ORIGIN)
    assert "{CHECKOUT_SESSION_ID}" in stripe.created["success_url"]


def test_checkout_takes_no_body_that_could_change_the_price(stripe):
    # A body is accepted and ignored: there is one plan, and every parameter a
    # caller could send is one a caller could tamper with.
    client.post("/checkout", json={"price": "price_free", "quantity": 99})
    assert stripe.created["line_items"] == [{"price": "price_test_123", "quantity": 1}]


def test_checkout_without_a_key_is_a_503_not_a_crash(monkeypatch):
    monkeypatch.delenv("STRIPE_SECRET_KEY", raising=False)
    monkeypatch.setenv("STRIPE_PRICE_ID", "price_test_123")
    assert client.post("/checkout").status_code == 503


def test_checkout_without_a_price_is_a_503(monkeypatch):
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_x")
    monkeypatch.delenv("STRIPE_PRICE_ID", raising=False)
    assert client.post("/checkout").status_code == 503


def test_a_stripe_failure_does_not_quote_stripe(stripe, caplog):
    stripe.create_raises = RuntimeError("acct_1234 rejected card 4242 for dr@clinic.sg")
    response = client.post("/checkout")
    assert response.status_code == 502
    assert "4242" not in response.text and "dr@clinic.sg" not in response.text
    assert "4242" not in caplog.text and "dr@clinic.sg" not in caplog.text


# ---------------------------------------------------------------------------
# POST /licence/claim
# ---------------------------------------------------------------------------


def _paid(subscription="sub_live_1", status="paid"):
    return {"payment_status": status, "subscription": subscription}


def test_a_paid_session_yields_a_verifiable_licence(stripe):
    stripe.stored["cs_ok"] = _paid()
    response = client.post("/licence/claim", json={"session_id": "cs_ok"})

    assert response.status_code == 200
    claims = verify_licence(response.json()["licence"], SECRET)
    assert claims["sub"] == "sub_live_1"


def test_claiming_twice_returns_a_licence_that_still_works(stripe):
    # A doctor who loses their key revisits the link in their Stripe receipt.
    # The token is derived from the subscription id and the secret, so there is
    # nothing to run out.
    stripe.stored["cs_ok"] = _paid()
    first = client.post("/licence/claim", json={"session_id": "cs_ok"}).json()["licence"]
    second = client.post("/licence/claim", json={"session_id": "cs_ok"}).json()["licence"]
    assert verify_licence(first, SECRET)["sub"] == verify_licence(second, SECRET)["sub"]


def test_an_unpaid_session_yields_nothing(stripe):
    # A session id exists from the moment checkout OPENS. Holding one proves
    # somebody started paying, never that they finished — and this is the whole
    # reason the exchange happens on the server rather than the page trusting a
    # ?paid=1 it was handed.
    stripe.stored["cs_open"] = _paid(status="unpaid")
    response = client.post("/licence/claim", json={"session_id": "cs_open"})
    assert response.status_code == 402
    assert "licence" not in response.text


def test_a_session_id_nobody_minted_is_refused(stripe):
    response = client.post("/licence/claim", json={"session_id": "cs_invented"})
    assert response.status_code == 404
    assert "cs_invented" not in response.text


def test_a_paid_session_with_no_subscription_yields_nothing(stripe):
    # A one-off payment is not a subscription, and a token minted from an empty
    # id would verify against every other empty one.
    stripe.stored["cs_oneoff"] = _paid(subscription=None)
    assert client.post("/licence/claim", json={"session_id": "cs_oneoff"}).status_code == 402


def test_an_expanded_subscription_object_is_accepted(stripe):
    # Stripe returns an id or an object depending on expansion, and a change
    # there must not silently stop issuing licences.
    stripe.stored["cs_exp"] = _paid(subscription=types.SimpleNamespace(id="sub_exp"))
    licence = client.post("/licence/claim", json={"session_id": "cs_exp"}).json()["licence"]
    assert verify_licence(licence, SECRET)["sub"] == "sub_exp"


def test_no_signing_secret_means_no_licence_is_issued(stripe, monkeypatch):
    # THE DANGEROUS DEFAULT, the same one verify_licence guards. An empty
    # string is a valid HMAC key, so signing with it would mint tokens anyone
    # could forge — and they would verify, because the verifier would be using
    # the same empty key.
    monkeypatch.delenv("FORMFILL_LICENCE_SECRET", raising=False)
    stripe.stored["cs_ok"] = _paid()
    assert client.post("/licence/claim", json={"session_id": "cs_ok"}).status_code == 503


def test_the_token_never_appears_in_a_log(stripe, caplog):
    stripe.stored["cs_ok"] = _paid()
    licence = client.post("/licence/claim", json={"session_id": "cs_ok"}).json()["licence"]
    assert licence not in caplog.text


# ---------------------------------------------------------------------------
# /health
# ---------------------------------------------------------------------------


def test_health_reports_whether_subscriptions_are_configured(stripe):
    body = client.get("/health").json()
    assert body["subscriptions"] is True


def test_health_says_false_when_a_piece_is_missing(stripe, monkeypatch):
    # All three or nothing: a deploy with a Stripe key and no signing secret
    # can open a checkout and then fail to issue the licence it was paid for,
    # which is the worst of the partial states.
    monkeypatch.delenv("FORMFILL_LICENCE_SECRET", raising=False)
    assert client.get("/health").json()["subscriptions"] is False


def test_health_never_reveals_a_key(stripe):
    body = client.get("/health").text
    assert "sk_test" not in body and "price_test" not in body and SECRET not in body


def test_the_failure_names_its_type_but_never_its_message(stripe):
    # The type is the one fact that makes a 502 actionable — it separates a
    # wrong key from a wrong price id from a dependency that did not ship — and
    # a class name is not data. The message is still withheld, because a Stripe
    # exception quotes the request that caused it.
    class AuthenticationError(RuntimeError):
        pass

    stripe.create_raises = AuthenticationError("Invalid API Key sk_live_abc123")
    response = client.post("/checkout")

    assert response.status_code == 502
    assert "AuthenticationError" in response.text
    assert "sk_live_abc123" not in response.text
