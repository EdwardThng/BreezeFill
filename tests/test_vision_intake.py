"""Reading a scanned blank form by looking at it.

The tests that matter here are the geometry ones. Everything else on this path
has something behind it — a label is checked by the doctor in review, a wrong
type raises in the fill layer — but a box's coordinates rest on the model's
word alone, and a box that is merely fifteen points out produces a perfectly
reasonable answer printed across the wrong line. So `_to_box` refuses a great
deal, and this is where those refusals are pinned.

The forms rendered here are the real scanned insurer forms in
`forms/scans_unsupported/`. They contain no patient.
"""

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

from form_intake import IntakeError, probe_pdf, refusal_for  # noqa: E402
from vision_intake import (  # noqa: E402
    MAX_BOX_AREA,
    RenderedPage,
    _to_box,
    derive_overlay_schema,
    render_pages,
    vision_available,
)

REPO_ROOT = Path(__file__).resolve().parent.parent
SCANS = REPO_ROOT / "forms" / "scans_unsupported"
ONE_PAGE = SCANS / "henner_prior_agreement.pdf"
SEVEN_PAGE = SCANS / "aia_medical_report.pdf"
FILLABLE = REPO_ROOT / "forms" / "ge_ghs_claim.pdf"

A4 = RenderedPage(number=1, jpeg=b"", width_pt=595.0, height_pt=842.0)


class TestRendering:
    def test_a_real_scanned_form_renders_every_page(self) -> None:
        pages = render_pages(SEVEN_PAGE.read_bytes())
        assert [p.number for p in pages] == [1, 2, 3, 4, 5, 6, 7]
        assert all(p.jpeg.startswith(b"\xff\xd8") for p in pages), "not JPEG"

    def test_the_page_size_is_carried_in_points_not_pixels(self) -> None:
        # The boxes come back as fractions of the page and have to become
        # points. Going via pixels would let the render resolution into the
        # geometry, and a later DPI change would silently move every box.
        page = render_pages(ONE_PAGE.read_bytes())[0]
        assert (page.width_pt, page.height_pt) == (595.0, 842.0)

    def test_the_page_cap_stops_a_wrong_upload_costing_a_fortune(self) -> None:
        # Every page is a separate call with an image in it, so a mistakenly
        # uploaded policy document would otherwise be an expensive way to find
        # out it was the wrong file.
        assert len(render_pages(SEVEN_PAGE.read_bytes(), max_pages=2)) == 2


class TestWhichPathAFormTakes:
    def test_a_scan_is_no_longer_a_dead_end_when_a_renderer_is_present(self) -> None:
        assert refusal_for(probe_pdf(ONE_PAGE.read_bytes()), can_render=True) is None

    def test_a_scan_is_still_refused_without_one(self) -> None:
        assert refusal_for(probe_pdf(ONE_PAGE.read_bytes()), can_render=False) is not None

    def test_refusing_is_what_happens_when_nobody_decided(self) -> None:
        # The default is False on purpose. A wrong refusal costs a doctor a
        # form; a wrong acceptance costs them a stamped-on page they cannot
        # see is wrong.
        assert refusal_for(probe_pdf(ONE_PAGE.read_bytes())) is not None

    def test_a_fillable_form_is_accepted_either_way(self) -> None:
        for can_render in (True, False):
            assert refusal_for(probe_pdf(FILLABLE.read_bytes()), can_render=can_render) is None

    def test_this_environment_can_render(self) -> None:
        assert vision_available() is True


class TestTheBoxesThatAreRefused:
    def box(self, **over):
        return _to_box({"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.02, **over}, A4)

    def test_an_ordinary_box_becomes_points_from_the_top_left(self) -> None:
        # The positive case, first. Every refusal below is worthless without
        # it — a function that returned None for everything would pass them all.
        box = self.box()
        assert box is not None
        assert box.page == 1
        assert box.x == pytest.approx(0.1 * 595)
        assert box.y == pytest.approx(0.2 * 842)
        assert box.w == pytest.approx(0.3 * 595)
        assert box.h == pytest.approx(0.02 * 842)

    def test_no_flip_is_applied(self) -> None:
        # overlay_fill measures from the page's TOP-left, which is also how an
        # image is addressed, so the conversion is a multiply. A y-flip here
        # would put every answer the same distance from the wrong edge — and
        # would look plausible on a box near the middle of the page.
        top = _to_box({"x": 0.0, "y": 0.02, "w": 0.5, "h": 0.02}, A4)
        assert top is not None
        assert top.y < 100, "a box near the top of the page must stay near the top"

    def test_a_box_off_the_page_is_refused(self) -> None:
        assert self.box(x=-0.1) is None
        assert self.box(y=-0.1) is None
        assert self.box(x=1.2) is None
        assert self.box(y=1.0) is None

    def test_an_inside_out_box_is_refused(self) -> None:
        assert self.box(w=0) is None
        assert self.box(h=0) is None
        assert self.box(w=-0.2) is None

    def test_a_box_running_a_long_way_past_the_edge_is_refused(self) -> None:
        assert self.box(x=0.9, w=0.5) is None

    def test_a_box_running_a_hair_past_the_edge_is_clamped(self) -> None:
        # Rounding, not a bad answer. A field genuinely at the page edge is
        # ordinary and must not be thrown away over a thousandth.
        box = self.box(x=0.9, w=0.105)
        assert box is not None
        assert box.x + box.w <= 595.0 + 0.001

    def test_a_box_the_size_of_a_section_is_refused(self) -> None:
        # Half the page is a heading or the whole form, not a field. Stamping
        # an answer into one prints it across everything underneath.
        assert self.box(x=0.0, y=0.0, w=0.9, h=0.9) is None
        assert self.box(x=0.0, y=0.0, w=0.9, h=(MAX_BOX_AREA / 0.9) + 0.01) is None

    def test_a_box_too_small_to_write_in_is_refused(self) -> None:
        assert self.box(w=0.001) is None
        assert self.box(h=0.0001) is None

    def test_a_missing_or_unusable_number_is_refused(self) -> None:
        assert _to_box({"x": 0.1, "y": 0.2, "w": 0.3}, A4) is None
        assert _to_box({"x": "left", "y": 0.2, "w": 0.3, "h": 0.02}, A4) is None
        assert _to_box({"x": None, "y": 0.2, "w": 0.3, "h": 0.02}, A4) is None

    def test_infinity_and_nan_are_refused(self) -> None:
        assert self.box(x=float("inf")) is None
        assert self.box(w=float("nan")) is None

    def test_the_box_lands_on_the_page_it_was_found_on(self) -> None:
        page3 = RenderedPage(number=3, jpeg=b"", width_pt=595.0, height_pt=842.0)
        box = _to_box({"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.02}, page3)
        assert box is not None and box.page == 3


class StubVision:
    """The vision call, replaced. Answers a fixed list of boxes per page."""

    def __init__(self, per_page) -> None:
        self.per_page = per_page
        self.calls = 0
        self.images = 0
        self.messages = self

    def create(self, **kwargs):
        self.calls += 1
        content = kwargs["messages"][0]["content"]
        self.images += sum(1 for part in content if part.get("type") == "image")

        class Block:
            type = "text"

            def __init__(self, text):
                self.text = text

        class Response:
            stop_reason = "end_turn"

            def __init__(self, text):
                self.content = [Block(text)]

        return Response(json.dumps({"fields": self.per_page}))


def field(label, **over):
    return {
        "label": label,
        "description": "",
        "type": "text",
        "options": [],
        "x": 0.1,
        "y": 0.2,
        "w": 0.3,
        "h": 0.02,
        **over,
    }


class TestDerivingAnOverlaySchema:
    def test_a_scan_becomes_an_overlay_schema_with_boxes(self) -> None:
        client = StubVision([field("Diagnosis"), field("Date of admission", type="date")])
        schema = derive_overlay_schema(
            ONE_PAGE.read_bytes(), "upload_x", pdf_path="bank://x.pdf", client=client
        )
        assert schema.fill_mode == "overlay"
        assert [f.label for f in schema.fields] == ["Diagnosis", "Date of admission"]
        assert all(f.box is not None for f in schema.fields)

    def test_the_page_image_is_what_is_sent(self) -> None:
        client = StubVision([field("Diagnosis")])
        derive_overlay_schema(
            ONE_PAGE.read_bytes(), "upload_x", pdf_path="bank://x.pdf", client=client
        )
        assert client.images == 1

    def test_one_call_per_page(self) -> None:
        client = StubVision([field("Diagnosis")])
        derive_overlay_schema(
            SEVEN_PAGE.read_bytes(), "upload_x", pdf_path="bank://x.pdf", client=client
        )
        assert client.calls == 7

    def test_a_field_whose_box_was_refused_is_dropped_not_guessed(self) -> None:
        client = StubVision([field("Good"), field("Nonsense", x=5.0)])
        schema = derive_overlay_schema(
            ONE_PAGE.read_bytes(), "upload_x", pdf_path="bank://x.pdf", client=client
        )
        assert [f.label for f in schema.fields] == ["Good"]

    def test_a_field_with_no_label_is_dropped(self) -> None:
        client = StubVision([field(""), field("Diagnosis")])
        schema = derive_overlay_schema(
            ONE_PAGE.read_bytes(), "upload_x", pdf_path="bank://x.pdf", client=client
        )
        assert [f.label for f in schema.fields] == ["Diagnosis"]

    def test_a_form_where_nothing_could_be_located_is_refused(self) -> None:
        # Not "half a schema". Every box on this page failed the geometry
        # check, and a form filled from that is worse than one filled by hand.
        client = StubVision([field("Nonsense", x=5.0)])
        with pytest.raises(IntakeError):
            derive_overlay_schema(
                ONE_PAGE.read_bytes(), "upload_x", pdf_path="bank://x.pdf", client=client
            )

    def test_demographics_are_resolved_from_the_label_not_from_the_model(self) -> None:
        client = StubVision([field("NRIC / FIN"), field("Diagnosis")])
        schema = derive_overlay_schema(
            ONE_PAGE.read_bytes(), "upload_x", pdf_path="bank://x.pdf", client=client
        )
        by_label = {f.label: f for f in schema.fields}
        assert by_label["NRIC / FIN"].source == "demographics.nric"
        assert by_label["Diagnosis"].source == "llm"

    def test_a_checkbox_on_a_scan_carries_no_options(self) -> None:
        # overlay_fill draws an X. There is no export value to set and nowhere
        # to put a chosen string.
        client = StubVision([field("Pre-existing", type="checkbox", options=["Yes", "No"])])
        schema = derive_overlay_schema(
            ONE_PAGE.read_bytes(), "upload_x", pdf_path="bank://x.pdf", client=client
        )
        assert schema.fields[0].options == []

    def test_the_schema_survives_its_own_validator(self) -> None:
        # FormSchema refuses an overlay field with no box at load time, which
        # is what would catch a half-built schema here.
        client = StubVision([field("Diagnosis")])
        schema = derive_overlay_schema(
            ONE_PAGE.read_bytes(), "upload_x", pdf_path="bank://x.pdf", client=client
        )
        assert schema.boxes.keys() == {f.id for f in schema.fields}
