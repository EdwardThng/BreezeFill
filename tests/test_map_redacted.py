"""POST /map-redacted — the route that is never given a patient's identifiers.

The extension redacts in the browser now, so this endpoint receives a note
that already reads `[PATIENT] presents with…` and no PatientRecord at all.
These tests are about what that changes, and every one of them is about
something the server must NOT do: fill a demographic field it was not given,
re-merge a token it has no map for, or hand back what its own backstop caught.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import main
from mapping import FieldAnswer
from main import app

client = TestClient(app)

FIELDS = [
    {"label": "Patient name", "type": "text"},
    {"label": "Diagnosis of all conditions treated", "type": "text"},
    {"label": "Date of admission", "type": "date"},
]

REDACTED = (
    "[PATIENT], NRIC [NRIC], DOB [DOB]. Admitted 14/03/2026 with acute "
    "appendicitis. Laparoscopic appendicectomy 15/03/2026."
)


@pytest.fixture
def stub_llm(monkeypatch: pytest.MonkeyPatch):
    """Answers keyed by the slug the live schema builds, with the sweep off."""

    def fake_map_fields(schema, text, client=None, model=None):
        fake_map_fields.saw = text
        answers = {}
        for field in schema.fields:
            if "diagnosis" in field.id:
                answers[field.id] = FieldAnswer(
                    value="Acute appendicitis",
                    status="extracted",
                    source="[PATIENT] presented with acute appendicitis",
                )
            elif "admission" in field.id:
                answers[field.id] = FieldAnswer(
                    value="14/03/2026", status="extracted", source="Admitted 14/03/2026"
                )
        return answers

    fake_map_fields.saw = None
    monkeypatch.setattr(main, "map_fields", fake_map_fields)
    monkeypatch.setenv("FORMFILL_DISABLE_SWEEP", "1")
    return fake_map_fields


def post(text: str = REDACTED, fields=None):
    return client.post(
        "/map-redacted", json={"fields": fields or FIELDS, "redacted_text": text}
    )


class TestItIsNeverGivenIdentifiers:
    def test_the_request_has_nowhere_to_put_a_patient_record(self, stub_llm) -> None:
        # Not "the extension chooses not to send one" — the model has no field
        # for it, so a caller that tried would be refused by validation.
        body = {"fields": FIELDS, "redacted_text": REDACTED, "patient": {"full_name": "Chua Beng Huat"}}
        response = client.post("/map-redacted", json=body)
        assert response.status_code == 200
        # Accepted and ignored: pydantic drops what the model does not declare.
        assert "Chua Beng Huat" not in json.dumps(response.json())

    def test_a_demographic_row_comes_back_blank_and_says_what_it_needs(self, stub_llm) -> None:
        rows = post().json()["fields"]
        name_row = next(r for r in rows if r["fill_from"] == "full_name")
        assert name_row["value"] is None
        assert name_row["status"] == "demographic"

    def test_only_demographic_rows_carry_fill_from(self, stub_llm) -> None:
        rows = post().json()["fields"]
        for row in rows:
            if row["status"] == "demographic":
                assert row["fill_from"]
            else:
                assert row["fill_from"] is None


class TestItDoesNotReMerge:
    def test_tokens_travel_back_out_untouched(self, stub_llm) -> None:
        # The map stayed in the panel, so the server cannot substitute — and
        # must not blank the row for containing a token either, which is what
        # the PDF path does when re-merge fails.
        rows = post().json()["fields"]
        diagnosis = next(r for r in rows if "diagnosis" in r["field_id"])
        assert diagnosis["source"] == "[PATIENT] presented with acute appendicitis"
        assert diagnosis["value"] == "Acute appendicitis"


class TestTheBackstop:
    def test_an_identifier_the_browser_missed_never_reaches_the_model(self, stub_llm) -> None:
        # The one real risk of redacting in the browser: a shape the JS copy
        # misses. It reaches this process — that is the bug — and the second
        # pass stops it there.
        leaked = "[PATIENT] attended with S6234567C, who is her caregiver."
        post(leaked)
        assert "S6234567C" not in stub_llm.saw
        assert "[NRIC_" in stub_llm.saw

    def test_what_the_backstop_caught_is_not_handed_back(self, stub_llm) -> None:
        # Returning it would put the identifier on the wire a second time, to
        # no purpose: the caller cannot use a map it did not build.
        leaked = "[PATIENT] attended with S6234567C."
        body = json.dumps(post(leaked).json())
        assert "S6234567C" not in body

    def test_the_backstop_reads_the_same_file_the_browser_does(self) -> None:
        # If these two ever diverge the backstop stops being a backstop: it
        # would miss exactly what the browser missed.
        shared = Path(main.__file__).resolve().parents[1] / "extension" / "privacy" / "patterns.json"
        assert shared.exists()
        from redaction import PATTERN_FILE

        assert PATTERN_FILE == shared


class TestTheGuardsItKeeps:
    def test_a_page_with_no_labels_is_refused(self, stub_llm) -> None:
        assert post(fields=[{"label": "  ", "type": "text"}]).status_code == 422

    def test_too_many_questions_is_refused_rather_than_truncated(self, stub_llm) -> None:
        many = [{"label": f"Question {i}", "type": "text"} for i in range(main.MAX_LIVE_FIELDS + 1)]
        assert post(fields=many).status_code == 413

    def test_no_api_key_is_a_503_the_panel_can_explain(self, monkeypatch) -> None:
        def boom(*args, **kwargs):
            raise TypeError("Could not resolve authentication method")

        monkeypatch.setattr(main, "map_fields", boom)
        monkeypatch.setenv("FORMFILL_DISABLE_SWEEP", "1")
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        assert post().status_code == 503

    def test_nothing_is_stored(self, stub_llm) -> None:
        # Two identical requests, no id, nothing to fetch afterwards.
        first = post().json()
        second = post().json()
        assert first == second
        assert "claim_id" not in json.dumps(first)


def _version(text: str) -> list[int]:
    """A version as numbers, so 0.10.0 sorts after 0.9.0.

    Lexical comparison gets that pair backwards, which is the mistake that
    turns a kill switch into a switch that kills the wrong builds.
    """
    return [int(part) for part in text.split(".")]


class TestTheKillSwitch:
    """The one gap redacting in the browser cannot close by itself.

    Chrome updates an extension on its own schedule and a store review takes
    days, so a redaction bug cannot be fixed in minutes the way a server one
    can. What the server can do is refuse the old build — and a panel that
    cannot map cannot send a note it redacted badly.
    """

    def test_health_publishes_the_oldest_build_it_will_answer(self) -> None:
        body = client.get("/health").json()
        assert body["min_extension_version"] == main.MIN_EXTENSION_VERSION

    def test_the_shipped_extension_is_not_already_disowned(self) -> None:
        # A floor above the version in the manifest would refuse every install
        # on the day it shipped.
        #
        # NECESSARY BUT NOT SUFFICIENT, and believing otherwise cost a day of
        # outage. The manifest is what the repo BUILDS; what doctors RUN is what
        # the store publishes, and the two are different numbers whenever an
        # upload is pending. This assertion was green throughout 2026-08-16 and
        # 17 while every public install was being refused. The test below is the
        # one that actually guards the users.
        manifest = json.loads(
            (Path(main.__file__).resolve().parents[1] / "extension" / "manifest.json").read_text()
        )
        installed = _version(manifest["version"])
        assert installed >= _version(main.MIN_EXTENSION_VERSION)

    @pytest.mark.xfail(
        strict=True,
        reason=(
            "KNOWN AND CHOSEN, 2026-08-17: the floor is 0.3.0 and the store still "
            "publishes 0.2.1, so every public install is refused. The owner chose to "
            "publish 0.3.0 rather than lower the floor, because 0.2.1 is the build "
            "that sends identifiers to the server. strict=True means this FAILS THE "
            "SUITE the moment it starts passing — update PUBLISHED_EXTENSION_VERSION "
            "when the upload goes live, then delete this marker."
        ),
    )
    def test_the_floor_never_exceeds_the_build_doctors_actually_have(self) -> None:
        # THE INVARIANT THAT MATTERS. Chrome hands out the published build; the
        # published build asks /health whether it is still supported; a floor
        # above it means every panel refuses to send before it does anything.
        assert _version(main.PUBLISHED_EXTENSION_VERSION) >= _version(main.MIN_EXTENSION_VERSION)

    def test_the_guard_would_actually_catch_an_inversion(self) -> None:
        # The mechanism, proved separately — because the assertion above is
        # currently expected to fail, and an xfail proves nothing about whether
        # the comparison works. Without this, a typo that made `_version` return
        # a constant would look exactly like the outage.
        assert _version("0.2.1") < _version("0.3.0")
        assert not _version("0.2.1") >= _version("0.3.0")
        # Numeric, not lexical: "0.10.0" is newer than "0.9.0" and a string
        # comparison says the opposite.
        assert _version("0.10.0") > _version("0.9.0")
        assert _version("0.3.0") >= _version("0.3.0")
