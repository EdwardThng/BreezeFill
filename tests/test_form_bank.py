"""The form bank: keys, the PHI guard, and the storage backends.

The bank is the one place in this codebase that keeps bytes between requests,
so the tests that matter most here are the ones proving WHAT it keeps: a blank
insurer form and a description of its boxes, never a patient's claim.
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

from form_bank import (  # noqa: E402
    BlobBank,
    IntakeRefused,
    LocalBank,
    NullBank,
    build_bank,
    display_name_for,
    form_id_for,
    intake_guard,
    key_for,
    key_from_form_id,
)
from mapping import FormField, FormSchema  # noqa: E402


def a_schema(form_id: str = "upload_test") -> FormSchema:
    return FormSchema(
        form_id=form_id,
        pdf_path="bank://test.pdf",
        fill_mode="acroform",
        fields=[
            FormField(
                id="diagnosis",
                pdf_field_name="Text_Diagnosis1",
                type="text",
                source="llm",
                label="Diagnosis",
            )
        ],
    )


class TestTheKeyIsTheFormsOwnBytes:
    def test_the_same_pdf_gets_the_same_key(self) -> None:
        assert key_for(b"%PDF-1.4 pretend") == key_for(b"%PDF-1.4 pretend")

    def test_a_different_pdf_gets_a_different_key(self) -> None:
        # The property the whole cache rests on. Two doctors uploading
        # "claim form.pdf" from two different insurers must not collide, which
        # a filename-based key would do immediately.
        assert key_for(b"%PDF-1.4 aia") != key_for(b"%PDF-1.4 great eastern")

    def test_a_form_id_carries_its_whole_key_back(self) -> None:
        # This is what keeps the upload path stateless: /map and the PDF fill
        # are separate requests that may land on different machines, and the
        # second one finds the form by reading the id rather than by
        # remembering anything.
        key = key_for(b"%PDF-1.4 pretend")
        assert key_from_form_id(form_id_for(key)) == key

    def test_a_hand_authored_form_id_is_not_mistaken_for_an_upload(self) -> None:
        assert key_from_form_id("aia_ghs_claim") is None
        assert key_from_form_id("wizard_test_v1") is None

    def test_a_malformed_upload_id_is_refused_rather_than_looked_up(self) -> None:
        assert key_from_form_id("upload_") is None
        assert key_from_form_id("upload_not-hex-at-all") is None
        assert key_from_form_id("upload_" + "a" * 31) is None
        assert key_from_form_id("upload_../../etc/passwd") is None


class TestTheNameShownInThePicker:
    def test_an_ordinary_filename_becomes_an_ordinary_name(self) -> None:
        assert display_name_for("AIA_GHS_claim.pdf") == "AIA GHS claim"

    def test_a_filename_cannot_smuggle_markup_into_the_page(self) -> None:
        # An uploaded filename is attacker-controlled text in the general case,
        # and this one gets echoed back to the browser AND written into stored
        # JSON.
        assert "<" not in display_name_for("<script>alert(1)</script>.pdf")

    def test_a_nameless_upload_still_gets_a_name(self) -> None:
        assert display_name_for("") == "Uploaded form"
        assert display_name_for(".pdf") == "Uploaded form"


class TestTheGuardThatKeepsThePhiRuleTrue:
    def test_a_blank_form_may_be_banked(self) -> None:
        # The positive case. A guard that refused everything would pass the
        # next test on its own and break the entire feature.
        intake_guard(already_filled=False)

    def test_a_filled_claim_is_refused(self) -> None:
        with pytest.raises(IntakeRefused) as caught:
            intake_guard(already_filled=True)
        # The doctor uploaded the wrong file and needs to be told which one to
        # send instead, not given a generic failure.
        assert "blank form" in str(caught.value)

    def test_the_refusal_never_quotes_what_was_in_the_form(self) -> None:
        with pytest.raises(IntakeRefused) as caught:
            intake_guard(already_filled=True)
        # It cannot: it is handed a boolean and never sees a value. Asserted
        # anyway, because the obvious "improvement" is to name the fields that
        # were filled, and those field values are the patient's claim.
        assert "already has answers" in str(caught.value)


class TestTheLocalBank:
    def test_a_banked_form_comes_back(self, tmp_path: Path) -> None:
        bank = LocalBank(tmp_path)
        key = key_for(b"%PDF-1.4 pretend")
        bank.put(key, a_schema(), b"%PDF-1.4 pretend")

        assert bank.get_pdf(key) == b"%PDF-1.4 pretend"
        recovered = bank.get_schema(key)
        assert recovered is not None
        assert [f.label for f in recovered.fields] == ["Diagnosis"]

    def test_a_form_never_banked_is_a_miss_not_an_error(self, tmp_path: Path) -> None:
        bank = LocalBank(tmp_path)
        assert bank.get_schema(key_for(b"never seen")) is None
        assert bank.get_pdf(key_for(b"never seen")) is None

    def test_a_schema_from_an_older_shape_of_the_code_re_derives(self, tmp_path: Path) -> None:
        # A banked schema that no longer parses must not take the request down
        # with it. Deriving again is slower and correct; refusing is neither.
        bank = LocalBank(tmp_path)
        key = key_for(b"%PDF-1.4 pretend")
        bank.put(key, a_schema(), b"%PDF-1.4 pretend")
        (tmp_path / f"{key}.json").write_text('{"form_id": "x"}', "utf-8")

        assert bank.get_schema(key) is None

    def test_the_bank_directory_is_made_on_first_write(self, tmp_path: Path) -> None:
        bank = LocalBank(tmp_path / "not" / "yet" / "there")
        key = key_for(b"%PDF-1.4 pretend")
        bank.put(key, a_schema(), b"%PDF-1.4 pretend")
        assert bank.get_pdf(key) == b"%PDF-1.4 pretend"


class TestTheBankNeverFailsARequest:
    """Banking is a cache. A doctor holding a form must never be told to come
    back later because a storage call timed out."""

    def test_a_blob_write_that_raises_is_swallowed(self) -> None:
        bank = BlobBank("pretend-token")

        def explode(*args, **kwargs):
            raise OSError("the network is down")

        bank._call = explode
        bank.put(key_for(b"x"), a_schema(), b"%PDF-1.4 pretend")  # must not raise

    def test_a_blob_read_that_raises_is_a_miss(self) -> None:
        bank = BlobBank("pretend-token")

        def explode(*args, **kwargs):
            raise OSError("the network is down")

        bank._call = explode
        assert bank.get_schema(key_for(b"x")) is None
        assert bank.get_pdf(key_for(b"x")) is None

    def test_a_store_that_cannot_be_listed_is_not_re_listed_per_lookup(self) -> None:
        # One slow call must not become one slow call per field.
        bank = BlobBank("pretend-token")
        calls = []

        def explode(*args, **kwargs):
            calls.append(1)
            raise OSError("the network is down")

        bank._call = explode
        bank.get_schema(key_for(b"a"))
        bank.get_schema(key_for(b"b"))
        bank.get_pdf(key_for(b"c"))
        assert len(calls) == 1


class TestChoosingABackend:
    def test_a_local_directory_wins_when_one_is_set(self, monkeypatch, tmp_path) -> None:
        monkeypatch.setenv("BREEZEFILL_FORM_BANK_DIR", str(tmp_path))
        monkeypatch.setenv("BLOB_READ_WRITE_TOKEN", "pretend-token")
        assert isinstance(build_bank(), LocalBank)

    def test_blob_is_used_when_only_a_token_is_set(self, monkeypatch) -> None:
        monkeypatch.delenv("BREEZEFILL_FORM_BANK_DIR", raising=False)
        monkeypatch.setenv("BLOB_READ_WRITE_TOKEN", "pretend-token")
        assert isinstance(build_bank(), BlobBank)

    def test_no_storage_configured_degrades_to_deriving_every_time(self, monkeypatch) -> None:
        # Slower and correct, rather than a failure. This is what runs in the
        # tests and in a fresh checkout.
        monkeypatch.delenv("BREEZEFILL_FORM_BANK_DIR", raising=False)
        monkeypatch.delenv("BLOB_READ_WRITE_TOKEN", raising=False)
        bank = build_bank()
        assert isinstance(bank, NullBank)
        assert bank.get_schema(key_for(b"x")) is None
        bank.put(key_for(b"x"), a_schema(), b"pretend")  # must not raise
