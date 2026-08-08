"""Paste-block parsing (backend/demographics.py).

Two things are being guarded here, and only one of them is "does it find the
value". The other is that it declines to find one when the evidence is thin —
a wrong NRIC or a neighbour's phone number gets written onto a claim and
signed, while a blank costs the doctor a line of typing. Every test named
"refuses" or "leaves" is that second guarantee.

The fixtures follow docs/test_notes.md, because that is the shape the pilot
actually pastes. Every identifier here is synthetic.
"""

from __future__ import annotations

import pytest

from demographics import parse_date, parse_demographics


# The header format used throughout docs/test_notes.md: the whole patient
# block on one labelled line, middot-separated.
CASE_1 = """\
Patient: Chua Beng Huat · S7211043C · 04/11/1972 · 91112233 ·
18 Toa Payoh Lorong 4, Singapore 310018 · Policy GHS-4471902

14/03/2026, 0930h. 53M, previously well, presents with 2-day history of
periumbilical pain migrating to right iliac fossa.

Referred to Mount Elizabeth Hospital, admitted same day 14/03/2026.
MC 7 days from 15/03/2026 to 21/03/2026.

Dr Tan Mei Ling, MCR M08842B, Family Physician.
Braddell Family Clinic, 22 Braddell Road, Singapore 359915. Tel 62551234.
"""

# The other common shape: one label per line, as a CMS exports it.
LABELLED_BLOCK = """\
Name: Nurul Aisyah Binte Rahman
NRIC: S8830517D
DOB: 17/05/1988
Mobile: 98765432
Address: 5 Tampines Street 21, Singapore 529391
Policy No: GE-88213
Insurer: Great Eastern

02/04/2026. 37F presents day 4 of fever.
"""


class TestCompoundPatientLine:
    """The pilot's own format: everything on one line after 'Patient:'."""

    def test_every_segment_lands_in_its_own_field(self) -> None:
        parsed = parse_demographics(CASE_1)
        assert parsed.full_name == "Chua Beng Huat"
        assert parsed.nric == "S7211043C"
        assert parsed.dob == "1972-11-04"
        assert parsed.phone == "91112233"
        assert parsed.address == "18 Toa Payoh Lorong 4, Singapore 310018"
        assert parsed.policy_number == "GHS-4471902"

    def test_the_clinic_phone_under_the_signature_is_not_the_patient_s(self) -> None:
        # "Tel 62551234" is the clinic's. The patient line already answered
        # this, and the sole-match fallback must not get a second vote.
        assert parse_demographics(CASE_1).phone == "91112233"

    def test_consultation_dates_are_not_a_date_of_birth(self) -> None:
        # The note carries five dates after the patient line. Only the one in
        # the patient block is a DOB, and nothing else may become one.
        assert parse_demographics(CASE_1).dob == "1972-11-04"

    def test_a_wrapped_patient_line_keeps_its_tail(self) -> None:
        # CASE_1 wraps after the phone number, exactly as docs/test_notes.md
        # renders it, so the address and policy number arrive on a second
        # physical line with no label of their own.
        parsed = parse_demographics(CASE_1)
        assert parsed.address == "18 Toa Payoh Lorong 4, Singapore 310018"
        assert parsed.policy_number == "GHS-4471902"

    def test_the_note_is_not_swallowed_into_the_patient_line(self) -> None:
        # The other side of continuation: a line that does not end in a
        # separator ends the block. Otherwise the first sentence of the note
        # becomes a demographic.
        parsed = parse_demographics(
            "Patient: Foo Sok Cheng\n08/05/2026. Reviewed. Ongoing epigastric discomfort.\n"
        )
        assert parsed.full_name == "Foo Sok Cheng"
        assert parsed.address is None
        assert parsed.dob is None

    def test_a_patient_line_with_only_a_name_is_only_a_name(self) -> None:
        parsed = parse_demographics("Patient: Lim Hwee Kiat\n")
        assert parsed.full_name == "Lim Hwee Kiat"
        assert parsed.nric is None


class TestLabelledLines:
    def test_one_label_per_line(self) -> None:
        parsed = parse_demographics(LABELLED_BLOCK)
        assert parsed.full_name == "Nurul Aisyah Binte Rahman"
        assert parsed.nric == "S8830517D"
        assert parsed.dob == "1988-05-17"
        assert parsed.phone == "98765432"
        assert parsed.address == "5 Tampines Street 21, Singapore 529391"
        assert parsed.policy_number == "GE-88213"
        assert parsed.insurer == "Great Eastern"
        assert parsed.sources["full_name"] == "labelled"

    @pytest.mark.parametrize(
        "line",
        [
            "NRIC / FIN: S8830517D",
            "IC No: S8830517D",
            "nric- S8830517D",
            "NRIC: s8830517d",
            "NRIC: S 8830517 D",
        ],
    )
    def test_nric_label_and_format_variants(self, line: str) -> None:
        assert parse_demographics(line).nric == "S8830517D"

    def test_a_clinical_plan_line_is_not_an_insurance_plan(self) -> None:
        # "Plan:" is the single most common labelled line in a GP's note and
        # it is never an insurer. It is deliberately absent from LABELS.
        parsed = parse_demographics("Plan: review 2/52 if no better\n")
        assert parsed.insurer is None
        assert parsed.model_dump(exclude={"sources"}) == {
            k: None for k in parsed.model_dump(exclude={"sources"})
        }

    def test_prose_containing_a_colon_is_not_a_label(self) -> None:
        parsed = parse_demographics(
            "Impression: appendicitis. Discussed with patient: agreeable to surgery.\n"
        )
        assert parsed.full_name is None


class TestRefusals:
    def test_two_phone_numbers_means_neither(self) -> None:
        # No labelled line to settle it: the patient's and the clinic's are
        # indistinguishable by shape, so the field stays blank.
        text = "Reviewed today. Contactable on 91112233. Clinic tel 62551234.\n"
        assert parse_demographics(text).phone is None

    def test_one_phone_number_in_prose_is_taken(self) -> None:
        assert parse_demographics("Contactable on 91112233.\n").phone == "91112233"

    def test_a_second_nric_in_the_note_blocks_the_guess(self) -> None:
        # Case 6's shape: a note that mentions a family member.
        text = "Patient S7211043C attended with her husband S7106114A.\n"
        assert parse_demographics(text).nric is None

    def test_a_lone_nric_in_prose_is_taken(self) -> None:
        parsed = parse_demographics("Patient S7211043C attended alone.\n")
        assert parsed.nric == "S7211043C"
        assert parsed.sources["nric"] == "sole-match"

    def test_a_name_is_never_guessed_from_prose(self) -> None:
        # The whole reason this module exists rather than an LLM call: a name
        # has no shape. If it is not labelled, it is not found.
        text = "Chua Beng Huat attended today with epigastric discomfort.\n"
        assert parse_demographics(text).full_name is None

    def test_a_date_of_birth_is_never_guessed_from_prose(self) -> None:
        assert parse_demographics("Seen 14/03/2026, review 24/03/2026.\n").dob is None

    def test_an_empty_paste_is_an_empty_result_not_an_error(self) -> None:
        for text in ("", "   \n\n", None):  # type: ignore[arg-type]
            assert parse_demographics(text).full_name is None


class TestParseDate:
    @pytest.mark.parametrize(
        ("text", "expected"),
        [
            ("04/11/1972", "1972-11-04"),
            ("4/11/1972", "1972-11-04"),
            ("04-11-1972", "1972-11-04"),
            ("04.11.1972", "1972-11-04"),
            ("1972-11-04", "1972-11-04"),
            ("4 Nov 1972", "1972-11-04"),
            ("4 November 1972", "1972-11-04"),
        ],
    )
    def test_renderings(self, text: str, expected: str) -> None:
        assert parse_date(text) == expected

    def test_day_comes_first(self) -> None:
        # Singapore writes DD/MM. Reading 03/04/1971 as 4 March would put a
        # wrong birth date on a claim, and it would look entirely plausible.
        assert parse_date("03/04/1971") == "1971-04-03"

    @pytest.mark.parametrize(
        "text",
        ["31/02/1972", "not a date", "2026-13-01", "04/11/2099", "0930h"],
    )
    def test_implausible_or_malformed_is_none(self, text: str) -> None:
        assert parse_date(text) is None


class TestLabelsAnywhereInALine:
    """Doctors do not write in one format.

    The line-anchored rule needs `Label: value` at the start of a line. Real
    notes put two fields on one line, drop the colon, or both. A label is
    therefore read wherever it appears — but only for fields whose value has a
    shape, and only when what follows actually has it.
    """

    SAMPLE = (
        "Tan Wei Ling, F, 47\n"
        "NRIC S8012345D  DOB 14/03/1978\n"
        "HP 9123 4567 / 6123 4567\n"
        "Policy GHS-88213004 or GH-88213004 (AIA Singapore)\n"
        "\n"
        "Seen 02/08/2026. Dx acute tonsillitis.\n"
        "First consult for this episode 31/07/2026.\n"
    )

    def test_two_labels_on_one_line_without_colons(self) -> None:
        parsed = parse_demographics(self.SAMPLE)
        assert parsed.nric == "S8012345D"
        assert parsed.dob == "1978-03-14"

    def test_the_consultation_dates_are_not_mistaken_for_a_birth_date(self) -> None:
        # The note carries three dates. Only the one behind a DOB label is
        # taken; a date of birth is still never read out of loose prose.
        assert parse_demographics(self.SAMPLE).dob == "1978-03-14"

    def test_two_values_behind_one_label_yields_neither(self) -> None:
        # "HP 9123 4567 / 6123 4567" names two numbers and nothing here can
        # tell which the form wants. Same refusal as unlabelled prose.
        assert parse_demographics(self.SAMPLE).phone is None
        assert parse_demographics(self.SAMPLE).policy_number is None

    def test_a_label_followed_by_the_wrong_shape_yields_nothing(self) -> None:
        # The label says which field; the shape says whether the thing after it
        # is really a value for it. Without that check this sentence would
        # contribute a policy number.
        assert parse_demographics("Policy discussed with patient.\n").policy_number is None

    def test_a_qualified_label_is_not_the_patients(self) -> None:
        # "Clinic tel" and "Next of kin phone" are labels for somebody else.
        # The qualifying word in front is what says so, so a label has to open
        # the line or follow a separator to count.
        text = "Reviewed today. Contactable on 91112233. Clinic tel 62551234.\n"
        assert parse_demographics(text).phone is None

    def test_a_label_after_a_separator_still_counts(self) -> None:
        parsed = parse_demographics("Pt details, NRIC S8012345D, DOB 14/03/1978\n")
        assert parsed.nric == "S8012345D"
        assert parsed.dob == "1978-03-14"

    def test_an_explicitly_labelled_line_still_wins(self) -> None:
        # The line-anchored pass runs first; this one only fills what is empty.
        parsed = parse_demographics("NRIC: S7211043C\nOther ref NRIC S8012345D\n")
        assert parsed.nric == "S7211043C"
        assert parsed.sources["nric"] == "labelled"

    def test_a_name_is_still_never_guessed(self) -> None:
        # Name and address have no shape, so there is nothing to confirm a
        # guess against and they are excluded from this pass entirely.
        assert parse_demographics(self.SAMPLE).full_name is None


class TestAPolicyNumberIsNotAPhoneNumber:
    """A digit run inside a larger token is not a number in its own right.

    `GHS-88213004` ends in eight digits opening with an 8, which is a valid
    Singapore mobile by shape. Reading only the digits wrote the patient's
    policy number into their phone box — and demographics are copied onto the
    form deterministically, so it bypassed the model and the review confirm
    both.
    """

    def test_a_policy_number_does_not_become_a_phone(self) -> None:
        parsed = parse_demographics("Policy GHS-88213004\n")
        assert parsed.policy_number == "GHS-88213004"
        assert parsed.phone is None

    def test_the_same_holds_when_the_policy_line_is_labelled(self) -> None:
        parsed = parse_demographics("Policy no: AIA-91234567\n")
        assert parsed.policy_number == "AIA-91234567"
        assert parsed.phone is None

    def test_a_real_phone_beside_a_policy_number_is_still_found(self) -> None:
        # And this is now BETTER than before the token rule: the policy tail
        # used to count as a second phone candidate, so the sole-match refused
        # a phone the note stated plainly.
        parsed = parse_demographics(
            "Tan Wei Ling\nPolicy GHS-88213004 (AIA)\nHP 9123 4567\n"
        )
        assert parsed.phone == "9123 4567"
        assert parsed.policy_number == "GHS-88213004"

    def test_a_reference_that_merely_contains_a_phone_shape_is_not_one(self) -> None:
        assert parse_demographics("Ref 88213004-01 filed.\n").phone is None

    def test_an_nric_inside_a_reference_is_still_the_nric(self) -> None:
        # The asymmetry is deliberate. A phone number is never embedded in a
        # reference; an NRIC in one is still the patient's, and refusing it
        # would lose a correct value to avoid a collision that does not happen.
        assert parse_demographics("Case REF-S8012345D\n").nric == "S8012345D"

    def test_an_ordinary_phone_is_untouched(self) -> None:
        for text, expected in (
            ("HP 9123 4567\n", "9123 4567"),
            ("Contactable on 91112233.\n", "91112233"),
            ("Tel: +65 9123 4567\n", "+65 9123 4567"),
        ):
            assert parse_demographics(text).phone == expected
