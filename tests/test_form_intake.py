"""Reading an uploaded blank insurer form.

Every PDF used here is one already committed to `forms/`, which makes these
tests unusually load-bearing: `forms/scans_unsupported/` holds five real
insurer forms with no AcroForm fields and no text layer at all, and the
classifier's whole job is to tell them apart from the fillable ones without
being told which is which.
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

from form_intake import (  # noqa: E402
    IntakeError,
    SCANNED_REFUSAL,
    derive_schema,
    probe_pdf,
    read_widgets,
    refusal_for,
)
from pdf_fill import fill_pdf  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent
FILLABLE = REPO_ROOT / "forms" / "ge_ghs_claim.pdf"
DEV_PDF = REPO_ROOT / "forms" / "dev_sample.pdf"
SCANNED = REPO_ROOT / "forms" / "scans_unsupported" / "henner_prior_agreement.pdf"


class TestTellingTheTwoKindsOfFormApart:
    """The split that decides whether an upload can be mapped at all."""

    def test_a_real_fillable_insurer_form_is_recognised_as_fillable(self) -> None:
        probe = probe_pdf(FILLABLE.read_bytes())
        assert probe.fillable
        assert probe.widget_count > 0
        assert probe.has_text_layer

    def test_a_real_scanned_insurer_form_has_neither_fields_nor_text(self) -> None:
        # Not a contrived fixture: this is one of the five forms in the repo
        # that had to be hand-calibrated because there was nothing to read.
        probe = probe_pdf(SCANNED.read_bytes())
        assert not probe.fillable
        assert probe.widget_count == 0
        assert not probe.has_text_layer

    def test_the_fillable_form_is_accepted(self) -> None:
        # The positive case, asserted alongside the refusal below. A refusal is
        # not evidence of a working rule — a classifier that refused everything
        # would pass the next test on its own.
        assert refusal_for(probe_pdf(FILLABLE.read_bytes())) is None

    def test_the_scanned_form_is_refused_and_says_where_to_look_instead(self) -> None:
        refusal = refusal_for(probe_pdf(SCANNED.read_bytes()))
        assert refusal == SCANNED_REFUSAL
        # "Unsupported" tells a doctor holding a form nothing about what to do
        # with it. This refusal has to name the next action.
        assert "insurer" in refusal and "fillable" in refusal

    def test_something_that_is_not_a_pdf_is_refused_without_a_traceback(self) -> None:
        with pytest.raises(IntakeError):
            probe_pdf(b"this is not a PDF at all")


class TestRefusingAClaimSomebodyAlreadyFilledIn:
    """The check the whole storage exception rests on.

    A blank insurer form is a public document and may be kept. A filled one is
    a patient's claim, and nothing in this product may write one down.
    """

    def test_a_blank_form_is_not_mistaken_for_a_filled_one(self) -> None:
        assert probe_pdf(DEV_PDF.read_bytes()).already_filled is False

    def test_a_form_with_answers_in_it_is_detected(self) -> None:
        filled = fill_pdf(DEV_PDF, {"Text_PatientName": "A Synthetic Patient"})
        assert probe_pdf(filled).already_filled is True

    def test_an_unticked_checkbox_is_not_an_answer(self) -> None:
        # /Off is a checkbox in its default state. Reading it as an answer
        # would refuse every blank form carrying a tick box, which is most of
        # them.
        filled = fill_pdf(DEV_PDF, {"Check_PreExisting": False})
        assert probe_pdf(filled).already_filled is False


class TestReadingTheBoxesAndTheirLabels:
    def test_every_widget_is_read_with_a_page_and_a_box(self) -> None:
        widgets, _ = read_widgets(FILLABLE.read_bytes())
        assert len(widgets) > 100
        for widget in widgets:
            assert widget.page >= 1
            x, y, w, h = widget.rect
            assert w > 0 and h > 0

    def test_a_meaningless_field_name_is_rescued_by_the_text_beside_it(self) -> None:
        # This is the whole reason nearby text is collected. Great Eastern's
        # own form calls a box "undefined_2"; what it is for is printed on the
        # page next to it, and nowhere else.
        widgets, _ = read_widgets(FILLABLE.read_bytes())
        by_name = {w.name: w for w in widgets}
        assert "undefined_2" in by_name, "the form's own junk field name is gone"
        assert by_name["undefined_2"].nearby, "nothing was found to name it with"

    def test_pages_with_no_boxes_still_yield_their_text(self) -> None:
        # Page 1 of both real forms is instructions and carries no widgets. Its
        # text is still wanted: a question's wording often sits far from its box.
        _, page_text = read_widgets(FILLABLE.read_bytes())
        assert page_text[1].strip()


class StubClient:
    """Stands in for Anthropic. Records what it was asked, answers a script."""

    def __init__(self, answer_for) -> None:
        self.answer_for = answer_for
        self.prompts: list[str] = []
        self.messages = self

    def create(self, **kwargs):
        prompt = kwargs["messages"][0]["content"]
        self.prompts.append(prompt)
        boxes = self.answer_for(prompt)

        class Block:
            type = "text"

            def __init__(self, text):
                self.text = text

        class Response:
            stop_reason = "end_turn"

            def __init__(self, text):
                self.content = [Block(text)]

        import json

        return Response(json.dumps({"boxes": boxes}))


def _answer(labels_by_ref, **overrides):
    def build(prompt):
        import re

        refs = re.findall(r'ref="(b\d+)"', prompt)
        out = []
        for ref in refs:
            spec = labels_by_ref.get(ref)
            if spec is None:
                out.append({
                    "ref": ref, "label": "", "description": "",
                    "type": "text", "options": [], "include": False,
                })
            else:
                out.append({"ref": ref, "options": [], "description": "", **spec})
        return out

    return build


class TestDerivingASchema:
    def test_only_the_boxes_the_model_included_become_fields(self) -> None:
        client = StubClient(_answer({
            "b0": {"label": "Diagnosis", "type": "text", "include": True},
            "b1": {"label": "For office use", "type": "text", "include": False},
        }))
        schema = derive_schema(
            DEV_PDF.read_bytes(), "upload_x", pdf_path="bank://x.pdf", client=client
        )
        labels = [f.label for f in schema.fields]
        assert "Diagnosis" in labels
        assert "For office use" not in labels

    def test_a_box_the_model_could_not_name_is_dropped(self) -> None:
        # An empty label is the model declining to guess, which the prompt asks
        # for explicitly. A field with a wrong label gets a wrong value written
        # into it and the doctor signs the result.
        client = StubClient(_answer({
            "b0": {"label": "", "type": "text", "include": True},
            "b1": {"label": "Diagnosis", "type": "text", "include": True},
        }))
        schema = derive_schema(
            DEV_PDF.read_bytes(), "upload_x", pdf_path="bank://x.pdf", client=client
        )
        assert [f.label for f in schema.fields] == ["Diagnosis"]

    def test_a_demographic_is_resolved_from_the_label_not_from_the_model(self) -> None:
        # The model names the box. It does not get to decide that a box holds
        # the patient's NRIC — that is the deterministic path, and a value
        # assigned by it reaches the doctor already green.
        client = StubClient(_answer({
            "b0": {"label": "NRIC / FIN", "type": "text", "include": True},
            "b1": {"label": "Diagnosis", "type": "text", "include": True},
        }))
        schema = derive_schema(
            DEV_PDF.read_bytes(), "upload_x", pdf_path="bank://x.pdf", client=client
        )
        by_label = {f.label: f for f in schema.fields}
        assert by_label["NRIC / FIN"].source == "demographics.nric"
        assert by_label["Diagnosis"].source == "llm"

    def test_two_boxes_wanting_one_demographic_yields_neither(self) -> None:
        client = StubClient(_answer({
            "b0": {"label": "Patient Name", "type": "text", "include": True},
            "b1": {"label": "Name of Patient", "type": "text", "include": True},
        }))
        schema = derive_schema(
            DEV_PDF.read_bytes(), "upload_x", pdf_path="bank://x.pdf", client=client
        )
        assert [f.source for f in schema.fields] == ["llm", "llm"]

    def test_the_pdfs_own_type_beats_the_models_opinion_of_it(self) -> None:
        # Writing a string into a checkbox raises in pdf_fill, and the PDF
        # knows which of its boxes are checkboxes. The model does not get a
        # vote it can lose the whole fill with.
        client = StubClient(_answer({
            "b4": {"label": "Pre-existing condition", "type": "text", "include": True},
        }))
        schema = derive_schema(
            DEV_PDF.read_bytes(), "upload_x", pdf_path="bank://x.pdf", client=client
        )
        checkbox = next(f for f in schema.fields if f.pdf_field_name == "Check_PreExisting")
        assert checkbox.type == "checkbox"

    def test_a_checkbox_carries_no_options(self) -> None:
        # A checkbox is a boolean to pdf_fill — it is set to the field's export
        # value or /Off, and there is nowhere to put a chosen string.
        client = StubClient(_answer({
            "b4": {
                "label": "Pre-existing", "type": "checkbox",
                "options": ["Yes", "No"], "include": True,
            },
        }))
        schema = derive_schema(
            DEV_PDF.read_bytes(), "upload_x", pdf_path="bank://x.pdf", client=client
        )
        checkbox = next(f for f in schema.fields if f.pdf_field_name == "Check_PreExisting")
        assert checkbox.options == []

    def test_every_field_keeps_the_pdf_field_name_it_will_be_written_through(self) -> None:
        client = StubClient(_answer({
            "b0": {"label": "Diagnosis", "type": "text", "include": True},
        }))
        schema = derive_schema(
            DEV_PDF.read_bytes(), "upload_x", pdf_path="bank://x.pdf", client=client
        )
        assert all(f.pdf_field_name for f in schema.fields)
        assert schema.fill_mode == "acroform"

    def test_two_boxes_with_the_same_label_still_get_distinct_ids(self) -> None:
        # The ids become the enum the model answers against, so a collision
        # would silently merge two questions into one answer.
        client = StubClient(_answer({
            "b0": {"label": "Date", "type": "date", "include": True},
            "b1": {"label": "Date", "type": "date", "include": True},
        }))
        schema = derive_schema(
            DEV_PDF.read_bytes(), "upload_x", pdf_path="bank://x.pdf", client=client
        )
        ids = [f.id for f in schema.fields]
        assert len(ids) == len(set(ids))

    def test_a_form_nothing_could_be_identified_in_is_refused(self) -> None:
        client = StubClient(_answer({}))
        with pytest.raises(IntakeError):
            derive_schema(
                DEV_PDF.read_bytes(), "upload_x", pdf_path="bank://x.pdf", client=client
            )

    def test_the_page_is_described_one_call_at_a_time(self) -> None:
        client = StubClient(_answer({
            "b0": {"label": "Diagnosis", "type": "text", "include": True},
        }))
        derive_schema(
            FILLABLE.read_bytes(), "upload_x", pdf_path="bank://x.pdf", client=client
        )
        # Three of the four pages carry widgets; page 1 is instructions.
        assert len(client.prompts) == 3
