"""The gate on the routes that cost money, and the flag that keeps it off.

Two properties are being pinned here, and the second matters as much as the
first: the gate refuses an unlicensed request when it is ON, and it is
completely inert when it is OFF. It ships off, so deploying it changes nothing
for anyone already installed — which is what makes it safe to put into
production while the Stripe wiring is still being built, and what Chrome's terms
require of the free copies already downloaded.
"""

import os

import pytest
from fastapi.testclient import TestClient

import main
from licence import mint_licence

client = TestClient(main.app)

SECRET = "test-secret-not-a-real-one"

MAP_BODY = {
    "redacted_text": "[PATIENT] seen 12/03/2026 with RIF pain.",
    "fields": [{"label": "Diagnosis", "type": "text", "options": [], "description": None}],
}

# Synthetic, as every fixture in this repo is. Every field PatientRecord
# requires, including `insurer` — a body that fails validation gets a 422 from
# FastAPI BEFORE the route runs, so an incomplete fixture here would test
# nothing and look like an ungated route.
PATIENT = {
    "full_name": "Chua Beng Huat",
    "nric": "S7211043C",
    "dob": "1972-11-04",
    "insurer": "AIA",
    "clinical_text": "Seen 12/03/2026 with RIF pain.",
}


@pytest.fixture
def no_model(monkeypatch):
    """Neither the sweep nor the mapping call, so the route returns a status.

    Every assertion in this file is about the gate, which runs before both. With
    the model left in, an unlicensed request that gets PAST the gate raises out
    of the Anthropic client instead of returning a response — and "it raised"
    and "it was refused" are the two outcomes these tests have to tell apart.
    """
    monkeypatch.setenv("FORMFILL_DISABLE_SWEEP", "1")
    monkeypatch.setattr(main, "map_fields", lambda schema, text: {})


@pytest.fixture
def gate_on(monkeypatch, no_model):
    monkeypatch.setenv("FORMFILL_REQUIRE_LICENCE", "1")
    monkeypatch.setenv("FORMFILL_LICENCE_SECRET", SECRET)


class TestTheGateOff:
    """The shipped default. None of this may change until the owner sets the
    flag, because every install already out there is unlicensed by definition."""

    def test_an_unlicensed_request_is_answered(self, monkeypatch, no_model):
        monkeypatch.delenv("FORMFILL_REQUIRE_LICENCE", raising=False)
        response = client.post("/map-redacted", json=MAP_BODY)
        # Answered, not merely un-refused: every install already in a doctor's
        # browser is unlicensed by definition, and this is the row that says
        # deploying the gate does not break them.
        assert response.status_code == 200

    def test_health_still_answers_without_a_licence(self, monkeypatch):
        # Whatever else is gated, the panel has to be able to ask whether the
        # server is there and whether this version is still supported. A version
        # floor a doctor cannot read is a dead panel with no explanation.
        monkeypatch.setenv("FORMFILL_REQUIRE_LICENCE", "1")
        monkeypatch.setenv("FORMFILL_LICENCE_SECRET", SECRET)
        assert client.get("/health").status_code == 200


class TestTheGateOn:
    def test_a_request_with_no_licence_is_refused_with_402(self, gate_on):
        response = client.post("/map-redacted", json=MAP_BODY)
        assert response.status_code == 402

    def test_a_valid_licence_gets_past_the_gate(self, gate_on):
        # The positive case. A gate that refused everything would satisfy every
        # other test in this class.
        token = mint_licence("sub_123", SECRET, lifetime_days=30)
        response = client.post(
            "/map-redacted", json=MAP_BODY, headers={"Authorization": f"Bearer {token}"}
        )
        assert response.status_code == 200

    def test_an_expired_licence_is_refused(self, gate_on):
        token = mint_licence("sub_123", SECRET, lifetime_days=-1)
        response = client.post(
            "/map-redacted", json=MAP_BODY, headers={"Authorization": f"Bearer {token}"}
        )
        assert response.status_code == 402

    def test_a_forged_licence_is_refused(self, gate_on):
        token = mint_licence("sub_123", "not-the-real-secret", lifetime_days=30)
        response = client.post(
            "/map-redacted", json=MAP_BODY, headers={"Authorization": f"Bearer {token}"}
        )
        assert response.status_code == 402

    def test_the_refusal_says_nothing_about_why(self, gate_on):
        # A refusal detailed enough to debug a forgery is detailed enough to
        # guide one. The doctor gets one sentence; the owner looks the
        # subscription up in Stripe.
        token = mint_licence("sub_123", "not-the-real-secret", lifetime_days=30)
        detail = client.post(
            "/map-redacted", json=MAP_BODY, headers={"Authorization": f"Bearer {token}"}
        ).json()["detail"]
        for leak in ["signature", "expired", "forged", "secret", "claims"]:
            assert leak not in detail.lower()

    def test_the_refusal_never_quotes_the_token(self, gate_on):
        # It is a credential. It must not come back in an error body, which is
        # the one place it would be pasted into a bug report.
        token = mint_licence("sub_123", "not-the-real-secret", lifetime_days=30)
        body = client.post(
            "/map-redacted", json=MAP_BODY, headers={"Authorization": f"Bearer {token}"}
        ).text
        assert token not in body
        assert "sub_123" not in body

    def test_every_model_route_is_gated(self, gate_on):
        # A gate on one door is not a gate. All three of these spend the same
        # money and all three are reachable by `curl`, so leaving any one open
        # makes the others decorative.
        assert client.post("/map-redacted", json=MAP_BODY).status_code == 402
        assert client.post("/map-live", json={"fields": MAP_BODY["fields"], "patient": PATIENT}).status_code == 402
        assert client.post("/map", json={"form_id": "aia_ghs_claim", "patient": PATIENT}).status_code == 402

    def test_the_routes_that_spend_nothing_are_not_gated(self, gate_on):
        # `/parse` is patterns only and `/forms` is a list of schema names —
        # neither reaches a model, so neither has anything to protect. Gating
        # them would break the free local tier the paid one is an upsell on.
        assert client.get("/forms").status_code == 200
        assert client.post("/parse", json={"text": "Patient: Someone", "full_name": "Someone"}).status_code == 200

    def test_a_missing_secret_refuses_rather_than_opens(self, monkeypatch, no_model):
        # The misconfiguration that matters: the flag on, the secret absent. It
        # must fail CLOSED. Failing open here is a gate that looks installed and
        # is not.
        monkeypatch.setenv("FORMFILL_REQUIRE_LICENCE", "1")
        monkeypatch.delenv("FORMFILL_LICENCE_SECRET", raising=False)
        token = mint_licence("sub_123", SECRET, lifetime_days=30)
        response = client.post(
            "/map-redacted", json=MAP_BODY, headers={"Authorization": f"Bearer {token}"}
        )
        assert response.status_code == 402
