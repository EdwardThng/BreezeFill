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

from datetime import date

import pytest

from demographics import parse_date, parse_demographics
from redaction import PatientRecord, redact


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
        # `sources` and `choices` are metadata about the parse, not values the
        # form can be filled from, so the "nothing was found" assertion is
        # about everything else.
        meta = {"sources", "choices"}
        assert parsed.model_dump(exclude=meta) == {
            k: None for k in parsed.model_dump(exclude=meta)
        }
        assert parsed.choices == {}

    def test_prose_containing_a_colon_is_not_a_label(self) -> None:
        parsed = parse_demographics(
            "Impression: appendicitis. Discussed with patient: agreeable to surgery.\n"
        )
        assert parsed.full_name is None


class TestRefusals:
    def test_two_phone_numbers_means_neither(self) -> None:
        # No labelled line to settle it and nothing naming an owner, so the
        # two are indistinguishable by shape and the field stays blank.
        text = "Reviewed today. Contactable on 91112233 or 98887777.\n"
        assert parse_demographics(text).phone is None

    def test_one_phone_number_in_prose_is_taken(self) -> None:
        assert parse_demographics("Contactable on 91112233.\n").phone == "91112233"

    def test_a_second_nric_in_the_note_blocks_the_guess(self) -> None:
        # Two of them and nothing saying whose is whose. When the note DOES
        # say — "her husband S7106114A" — the other one is disqualified rather
        # than counted; see TestAValueSomebodyElseOwns.
        text = "S7211043C and S7106114A both attended today.\n"
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

    def test_two_policy_prefixes_from_two_insurers_yield_neither(self) -> None:
        # The refusal that survives the dedupe: neither prefix contains the
        # other, so these are two references and not one written twice.
        text = "Policy GHS-88213004 or GE-88213004\n"
        assert parse_demographics(text).policy_number is None

    def test_a_label_followed_by_the_wrong_shape_yields_nothing(self) -> None:
        # The label says which field; the shape says whether the thing after it
        # is really a value for it. Without that check this sentence would
        # contribute a policy number.
        assert parse_demographics("Policy discussed with patient.\n").policy_number is None

    def test_a_qualified_label_is_not_the_patients(self) -> None:
        # "Clinic tel" and "Next of kin phone" are labels for somebody else.
        # The qualifying word in front is what says so, so a label has to open
        # the line or follow a separator to count — and the same word then
        # keeps the number out of the unlabelled pass too, which is why the
        # patient's own number survives here as the only candidate.
        text = "Reviewed today. Contactable on 91112233. Clinic tel 62551234.\n"
        assert parse_demographics(text).phone == "91112233"

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


class TestAnAddressIsFoundByItsPostalCode:
    """A Singapore postal code is a shape, and the module already trusts it.

    `_classify_segment` has used `POSTAL_PATTERN` to call a segment an address
    since the compound-line parser was written. What was missing was the same
    rule for an address written on its own line — which is how a doctor
    actually lays a note out, and how the pilot's own sample writes it.

    Why the value is the whole line rather than the matched shape: unlike every
    other shaped field, the shape is not the value. `S570118` is the evidence
    that the line is an address; the address is the line.
    """

    ADDRESS = "Blk 118 Bishan St 12 #07-21, S570118"

    def test_a_bare_address_line_is_taken(self) -> None:
        parsed = parse_demographics(
            f"NRIC S8012345D  DOB 14/03/1978\n{self.ADDRESS}\n\nSeen 02/08/2026. Sore throat.\n"
        )
        assert parsed.address == self.ADDRESS
        assert parsed.sources["address"] == "sole-match"

    def test_two_addresses_means_neither(self) -> None:
        # The clinic's own address under the doctor's signature, which is the
        # same collision the phone rule exists for. Refusing costs the doctor
        # one line of typing; guessing writes the clinic's address onto the
        # claim as the patient's.
        text = (
            f"{self.ADDRESS}\n\nSeen 02/08/2026. Sore throat.\n"
            "Blk 501 Bishan St 11 #01-02, S570501\n"
        )
        assert parse_demographics(text).address is None

    def test_a_labelled_address_still_wins_and_keeps_its_label_off_the_value(self) -> None:
        # The anchored pass runs first, so this never reaches the postal rule.
        parsed = parse_demographics(f"Address: {self.ADDRESS}\n")
        assert parsed.address == self.ADDRESS
        assert parsed.sources["address"] == "labelled"

    def test_a_label_without_a_colon_does_not_land_in_the_value(self) -> None:
        # LABELLED_LINE needs the colon, so this arrives at the postal rule
        # with the label still attached. The label is not part of the address.
        parsed = parse_demographics(f"Addr {self.ADDRESS}\n")
        assert parsed.address == self.ADDRESS

    def test_an_address_is_never_invented_without_a_postal_code(self) -> None:
        # Positive case asserted alongside the refusal, because a refusal is
        # not evidence of a working rule and both look identical to a test
        # that only checks None.
        assert parse_demographics("Lives in Bishan with her daughter.\n").address is None

    def test_an_nric_is_not_read_as_a_postal_code(self) -> None:
        assert parse_demographics("NRIC S8012345D attended alone.\n").address is None

    def test_a_parsed_address_reaches_the_redaction_dictionary(self) -> None:
        # The point of the fix, and it is not a blank box. Pass 1 removes the
        # address only when the record carries one, and pass 2 has no postal
        # pattern — so an address the parser misses is still in the text when
        # it reaches the model.
        note = f"{self.ADDRESS}\n\nSeen 02/08/2026. Sore throat, fever 38.4.\n"
        parsed = parse_demographics(note)
        assert parsed.address is not None

        result = redact(
            PatientRecord(
                full_name="Tan Wei Ling",
                nric="S8012345D",
                dob=date(1978, 3, 14),
                address=parsed.address,
                insurer="AIA",
                clinical_text=note,
            )
        )
        assert self.ADDRESS not in result.redacted_text
        assert "[ADDRESS]" in result.redacted_text


class TestMoreThanOneCandidateIsOfferedRatherThanDropped:
    """A refusal the doctor cannot see reads as a failure to find anything.

    The parser already knows the difference between "the note does not say"
    and "the note says two things and I will not choose between them". Only
    the first justifies a blank box. The second is a question, and the answer
    belongs to the doctor — so the candidates travel instead of being
    discarded, and the panel asks.

    What this must NOT become: a ranking. Nothing here decides that a mobile
    beats a landline or that the first number wins. The refusal to guess is
    unchanged; the only change is that the evidence for it now reaches the
    person who can settle it.
    """

    SAMPLE = (
        "Tan Wei Ling, F, 47\n"
        "NRIC S8012345D  DOB 14/03/1978\n"
        "HP 9123 4567 / 6123 4567\n"
        "Policy GHS-88213004 or GH-88213004 (AIA Singapore)\n"
        "Blk 118 Bishan St 12 #07-21, S570118\n"
    )

    def test_two_phones_behind_one_label_are_offered(self) -> None:
        parsed = parse_demographics(self.SAMPLE)
        assert parsed.phone is None
        assert parsed.choices["phone"] == ["9123 4567", "6123 4567"]

    def test_one_policy_written_twice_is_not_a_question(self) -> None:
        # `GH-88213004` is `GHS-88213004` with the prefix cut short — same
        # digits, and one prefix contains the other. The doctor was being asked
        # to choose between a policy number and itself.
        parsed = parse_demographics(self.SAMPLE)
        assert parsed.policy_number == "GHS-88213004"
        assert "policy_number" not in parsed.choices

    def test_the_fuller_prefix_survives_whichever_came_first(self) -> None:
        # The one place the first-written rendering does not win, and it is not
        # a ranking: both readings agree about the policy, so keeping the
        # truncated one would put a prefix on a claim that the insurer did not
        # issue, to honour a rule that exists to preserve the doctor's wording.
        parsed = parse_demographics("Policy GH-88213004, also written GHS-88213004\n")
        assert parsed.policy_number == "GHS-88213004"

    def test_two_policies_with_different_digits_are_still_offered(self) -> None:
        parsed = parse_demographics("Policy GHS-88213004 or GHS-77104002\n")
        assert parsed.policy_number is None
        assert parsed.choices["policy_number"] == ["GHS-88213004", "GHS-77104002"]

    def test_a_separator_is_not_part_of_the_reference(self) -> None:
        parsed = parse_demographics("Policy GHS-88213004 (GHS88213004 in the system)\n")
        assert parsed.policy_number == "GHS-88213004"
        assert "policy_number" not in parsed.choices

    def test_candidates_keep_the_order_the_note_wrote_them_in(self) -> None:
        # Not a ranking — but if the doctor is choosing between two numbers,
        # the list should read the way their own note reads.
        assert parse_demographics(self.SAMPLE).choices["phone"][0] == "9123 4567"

    def test_two_phones_in_prose_are_offered_too(self) -> None:
        # Two numbers with nothing to separate them, found by the unlabelled
        # rule rather than the labelled one.
        text = "Reviewed today. Contactable on 91112233 or 62551234.\n"
        parsed = parse_demographics(text)
        assert parsed.phone is None
        assert parsed.choices["phone"] == ["91112233", "62551234"]

    def test_two_addresses_are_offered(self) -> None:
        text = (
            "Blk 118 Bishan St 12 #07-21, S570118\n\nSeen 02/08/2026.\n"
            "Blk 501 Bishan St 11 #01-02, S570501\n"
        )
        parsed = parse_demographics(text)
        assert parsed.address is None
        assert len(parsed.choices["address"]) == 2
        assert parsed.choices["address"][0] == "Blk 118 Bishan St 12 #07-21, S570118"

    def test_one_number_written_two_ways_is_not_two_candidates(self) -> None:
        # The doctor was being asked to choose between a number and itself,
        # and the field stayed blank until they did.
        text = "Contactable at +65 9123 4567 or 9123-4567.\n"
        parsed = parse_demographics(text)
        assert parsed.phone == "+65 9123 4567"
        assert "phone" not in parsed.choices

    def test_the_surviving_rendering_is_the_one_the_note_wrote_first(self) -> None:
        # Not a canonical form: what goes onto the claim should be what the
        # doctor typed, and a list they are choosing from should read like
        # their own note.
        text = "HP 91234567. Also reachable on 9123 4567.\n"
        assert parse_demographics(text).phone == "91234567"

    def test_a_landline_starting_65_is_not_mistaken_for_a_country_code(self) -> None:
        # `6512 3456` opens with the country code's own digits. Stripping them
        # would leave six digits, which would collide with any other number in
        # the note that happens to start 65.
        text = "Reviewed today. Home 6512 3456. Also on 6534 5678.\n"
        parsed = parse_demographics(text)
        assert parsed.phone is None
        assert parsed.choices["phone"] == ["6512 3456", "6534 5678"]

    def test_two_different_numbers_are_still_two_candidates(self) -> None:
        # The dedupe must not become a merge: these are genuinely two numbers
        # and the refusal to choose between them is the point.
        text = "Contactable on 91112233. Second number 62551234.\n"
        parsed = parse_demographics(text)
        assert parsed.phone is None
        assert parsed.choices["phone"] == ["91112233", "62551234"]

    def test_one_nric_written_two_ways_is_not_two_candidates(self) -> None:
        text = "IC s8012345d on the card, S 8012345 D in the system.\n"
        parsed = parse_demographics(text)
        assert parsed.nric == "S8012345D"
        assert "nric" not in parsed.choices

    def test_a_field_that_resolved_is_never_also_a_question(self) -> None:
        parsed = parse_demographics("HP 9123 4567\n")
        assert parsed.phone == "9123 4567"
        assert "phone" not in parsed.choices

    def test_a_note_that_says_nothing_asks_nothing(self) -> None:
        # A blank because the note is silent stays a blank. Offering an empty
        # choice would turn every unfilled field into a question.
        parsed = parse_demographics("Seen today. Sore throat, settling.\n")
        assert parsed.choices == {}

    def test_a_name_is_never_offered_as_a_choice(self) -> None:
        # A name has no shape, so there are no candidates to offer and no way
        # to build a list that is not a guess about which words are a name.
        text = "Chua Beng Huat attended with Tan Wei Ling today.\n"
        assert "full_name" not in parse_demographics(text).choices

    # Written relative to today rather than as literals: every assertion here
    # turns on how old a date is, so a hard-coded year would start failing on
    # a date nobody chose.
    @staticmethod
    def _years_ago(years: int) -> str:
        today = date.today()
        try:
            return today.replace(year=today.year - years).strftime("%d/%m/%Y")
        except ValueError:  # 29 February
            return date(today.year - years, 2, 28).strftime("%d/%m/%Y")

    def test_a_recent_date_is_the_consultation_and_is_not_offered(self) -> None:
        # The refusal that must survive: a clinical note is nothing but dates —
        # consultation, admission, discharge, MC — and none of them is a birth
        # date, so not one is ever written into the field. They are not even
        # offered, because inside the clinical window a date is describing the
        # episode being claimed for.
        text = (
            f"Seen {self._years_ago(0)}, first consult {self._years_ago(1)}, "
            f"review {self._years_ago(0)}.\n"
        )
        parsed = parse_demographics(text)
        assert parsed.dob is None
        assert "dob" not in parsed.choices

    def test_an_old_date_is_offered_because_nothing_else_is_that_old(self) -> None:
        # The other side. A note does not carry decade-old dates unless it is
        # saying when someone was born, so the blank stops being silent — the
        # doctor is shown what the note said and clicks, or ignores it.
        # No dob label anywhere — "born" is one, and would send these down the
        # labelled route instead, which believes what the note claims.
        text = (
            f"47F. Records go back to {self._years_ago(47)}. "
            f"Seen {self._years_ago(0)} for review.\n"
        )
        parsed = parse_demographics(text)
        assert parsed.dob is None
        assert parsed.choices["dob"] == [self._iso_years_ago(47)]

    @staticmethod
    def _iso_years_ago(years: int) -> str:
        today = date.today()
        try:
            return today.replace(year=today.year - years).isoformat()
        except ValueError:
            return date(today.year - years, 2, 28).isoformat()

    def test_a_lone_old_date_is_offered_rather_than_filled(self) -> None:
        # Everywhere else a single candidate IS the answer — one NRIC in the
        # note is the patient's NRIC. A date is the exception however old it
        # is: nothing SAID this was a birth date, so it is offered and never
        # recorded. This is why `offer` takes a minimum.
        parsed = parse_demographics(f"Longstanding asthma since {self._years_ago(40)}.\n")
        assert parsed.dob is None
        assert parsed.choices["dob"] == [self._iso_years_ago(40)]

    def test_a_date_with_no_year_is_never_a_birth_date(self) -> None:
        # "seen 2/8" is how a doctor writes this year, and a birth date written
        # that way could not be read anyway — the century is exactly what is
        # missing. Neither the pattern nor parse_date accepts one, so this is
        # the same judgement arrived at by a different route.
        parsed = parse_demographics("Seen 2/8, review 9/8. MC from 15/3.\n")
        assert parsed.dob is None
        assert "dob" not in parsed.choices

    def test_a_date_of_birth_that_resolved_is_not_also_a_question(self) -> None:
        # The note states one, so the dates in the clinical text below it are
        # not a question about it.
        text = "DOB: 14/03/1978\nSeen 02/08/2026, review 09/08/2026.\n"
        parsed = parse_demographics(text)
        assert parsed.dob == "1978-03-14"
        assert "dob" not in parsed.choices

    def test_two_dates_behind_a_dob_label_are_offered(self) -> None:
        # ...but a labelled region is different: both candidates are stated to
        # be the date of birth, so the doctor is choosing between two claims
        # the note actually makes.
        # ISO, not as written: the panel's date input holds nothing else, and
        # a JS copy of the day-first rule that drifted from the Python one is
        # exactly the leak `parse_date` exists to prevent.
        parsed = parse_demographics("DOB 14/03/1978 or 15/03/1978\n")
        assert parsed.dob is None
        assert parsed.choices["dob"] == ["1978-03-14", "1978-03-15"]


class TestTheInsurer:
    """The one demographic whose values are a closed list.

    Everything else here is found by shape or by label. An insurer has no shape
    — "Great Eastern" and "Tan Wei Ling" are the same thing to a regex — but it
    does have a vocabulary, and a vocabulary answers the same question: is the
    thing in front of me a value for this field, or just words.

    So the risk moves. It is no longer "will it find one", it is "will it find
    one that is not there", because this field is copied onto the claim without
    the model ever seeing it and shows up green as something the doctor
    entered. Most of the tests below are refusals for that reason.
    """

    def test_an_insurer_named_in_prose_is_taken(self) -> None:
        parsed = parse_demographics("Seen 02/08/2026, sore throat. Covered by AIA.\n")
        assert parsed.insurer == "AIA"
        assert parsed.sources["insurer"] == "sole-match"

    def test_a_variation_is_written_the_way_the_repo_writes_it(self) -> None:
        # The schema for this insurer says "Great Eastern". A value that
        # disagreed with it would read as a second insurer to anything
        # comparing the two.
        text = "Insured under Great Eastern Life Assurance.\n"
        assert parse_demographics(text).insurer == "Great Eastern"

    def test_one_insurer_written_two_ways_is_one_insurer(self) -> None:
        # Both spellings canonicalise before the count is taken, so this is a
        # value rather than a question. Also pins the longest-first ordering:
        # "AIA Singapore" must match whole rather than leaving " Singapore".
        text = "AIA Singapore policy, verified with AIA on 02/08.\n"
        assert parse_demographics(text).insurer == "AIA"

    def test_two_insurers_are_offered_rather_than_guessed(self) -> None:
        text = "Prudential rejected the earlier claim; now covered by NTUC Income.\n"
        parsed = parse_demographics(text)
        assert parsed.insurer is None
        assert parsed.choices["insurer"] == ["Prudential", "Income"]

    def test_a_labelled_insurer_beats_one_mentioned_in_the_note(self) -> None:
        text = "Insurer: Singlife\nPreviously with Aviva.\n"
        parsed = parse_demographics(text)
        assert parsed.insurer == "Singlife"
        assert parsed.sources["insurer"] == "labelled"

    def test_a_label_with_no_colon_still_reads(self) -> None:
        parsed = parse_demographics("NRIC S8012345D  Insurer MSIG\n")
        assert parsed.insurer == "MSIG"

    def test_an_insurer_in_a_compound_patient_line(self) -> None:
        # Without the insurer rule this segment has no digits, which is the
        # test for a name — and the name slot is already taken, so it was
        # dropped silently.
        text = "Patient: Tan Wei Ling · S8012345D · 14/03/1978 · Cigna\n"
        parsed = parse_demographics(text)
        assert parsed.full_name == "Tan Wei Ling"
        assert parsed.insurer == "Cigna"

    def test_an_insurer_the_list_does_not_know_is_kept_as_written(self) -> None:
        # The list is the insurers a GP meets most, not every insurer there is.
        # A labelled line is the doctor stating the answer, and dropping it for
        # being off the list would turn a correct value into a blank.
        text = "Insurer: Pacific Cross Insurance\n"
        parsed = parse_demographics(text)
        assert parsed.insurer == "Pacific Cross Insurance"

    @pytest.mark.parametrize(
        "text",
        [
            # The institution case, and the reason "Raffles" alone is not a
            # variation: half the notes in Singapore name a hospital.
            "Referred to Raffles Hospital A&E for review.\n",
            "Seen at Raffles Medical, Bishan.\n",
            # The English-word case.
            "Discussed income protection and MC entitlement.\n",
            # The policy-prefix case: GE- is a Great Eastern policy, but "GE"
            # is not a name and matching it here would fill the field from a
            # string that is already the policy number.
            "Policy GE-88213004, patient to verify cover.\n",
            # The pasted-email case. "Fwd:" is not FWD Insurance.
            "Fwd: referral letter attached.\n",
        ],
    )
    def test_a_word_that_only_looks_like_an_insurer_is_refused(self, text: str) -> None:
        parsed = parse_demographics(text)
        assert parsed.insurer is None
        assert "insurer" not in parsed.choices

    def test_the_canonical_names_match_the_schemas(self) -> None:
        # A parsed insurer and a schema's `insurer` are two answers to one
        # question, and they are compared by string. Drift here is invisible
        # until something reads them side by side.
        import json
        from pathlib import Path

        from demographics import INSURERS

        canonical = {name for name, _ in INSURERS}
        schemas = Path(__file__).resolve().parent.parent / "backend" / "schemas"
        for path in schemas.glob("*.json"):
            schema = json.loads(path.read_text(encoding="utf-8"))
            insurer = schema.get("insurer")
            # Internal fixtures name insurers that do not exist.
            if not insurer or schema.get("internal"):
                continue
            assert insurer in canonical, f"{path.name} names an insurer not in INSURERS"


class TestAHeaderNobodyLabelled:
    """A patient block written without `Patient:` in front of it.

    The rule being guarded is one piece, one field. Before this, a block with
    no label was read by the address rule alone — "the line with a postal code
    in it" — so the whole block went into the address box while the NRIC, date
    of birth, phone and policy boxes it was made of sat empty next to it.

    Reading an unlabelled line is a loosening, so the tests that matter are the
    ones showing what still refuses: prose is not a header, and a name is still
    never taken from words alone.
    """

    HEADER = (
        "Chua Beng Huat · S7211043C · 04/11/1972 · 91112233 ·\n"
        "18 Toa Payoh Lorong 4, Singapore 310018 · Policy GHS-4471902\n"
        "AIA Singapore\n"
    )

    def test_every_field_lands_in_its_own_box(self) -> None:
        parsed = parse_demographics(self.HEADER)
        assert parsed.full_name == "Chua Beng Huat"
        assert parsed.nric == "S7211043C"
        assert parsed.dob == "1972-11-04"
        assert parsed.phone == "91112233"
        assert parsed.policy_number == "GHS-4471902"
        assert parsed.insurer == "AIA"

    def test_the_address_is_the_address_and_nothing_else(self) -> None:
        # The whole point. Every one of these was inside the address string.
        parsed = parse_demographics(self.HEADER)
        assert parsed.address == "18 Toa Payoh Lorong 4, Singapore 310018"
        for taken in ("S7211043C", "04/11/1972", "91112233", "GHS-4471902", "Chua"):
            assert taken not in parsed.address

    def test_a_comma_separated_block_reads_the_same_way(self) -> None:
        # The comma is the separator AND a character inside the address, which
        # is why the address is rebuilt from the note's own text rather than
        # from the pieces the split produced.
        text = (
            "Chua Beng Huat, S7211043C, 04/11/1972, 91112233, "
            "18 Toa Payoh Lorong 4, Singapore 310018, Policy GHS-4471902\n"
        )
        parsed = parse_demographics(text)
        assert parsed.full_name == "Chua Beng Huat"
        assert parsed.address == "18 Toa Payoh Lorong 4, Singapore 310018"
        assert parsed.nric == "S7211043C"

    def test_a_labelled_block_written_with_commas_reads_too(self) -> None:
        text = "Patient: Chua Beng Huat, S7211043C, 04/11/1972, 91112233\n"
        parsed = parse_demographics(text)
        assert parsed.full_name == "Chua Beng Huat"
        assert parsed.dob == "1972-11-04"

    @pytest.mark.parametrize(
        "text",
        [
            # One shaped value in a sentence is a coincidence, not a block.
            "08/05/2026. Reviewed. Ongoing epigastric discomfort.\n",
            # Three dates is a treatment history: the count is of different
            # FIELDS, so this is one field however many times it appears.
            "Seen 02/08/2026, first consult 31/07/2026, review 09/08/2026.\n",
            # A number with a word in front of it is not that field's value.
            "Referred to Dr Lim, tel 62551234, on 04/11/2026.\n",
        ],
    )
    def test_prose_is_not_a_header(self, text: str) -> None:
        parsed = parse_demographics(text)
        assert parsed.full_name is None
        assert parsed.address is None

    def test_two_nameless_pieces_yield_no_name(self) -> None:
        # The same refusal every other field makes. A name has no shape, so
        # there is nothing to break the tie with — and a wrong name is the one
        # error redaction cannot recover from, since it is the value the note
        # is scrubbed against.
        text = "Chua Beng Huat · Tan Wei Ling · S7211043C · 91112233\n"
        parsed = parse_demographics(text)
        assert parsed.full_name is None
        assert parsed.nric == "S7211043C"

    def test_a_sentence_is_too_long_to_be_a_name(self) -> None:
        text = "S7211043C · 91112233 · patient reports ongoing epigastric discomfort\n"
        assert parse_demographics(text).full_name is None

    def test_an_address_on_its_own_line_is_unaffected(self) -> None:
        # One field on the line, so it is not a header — the old rule still
        # owns this case and still takes the whole line.
        text = "NRIC: S8012345D\nBlk 118 Bishan St 12 #07-21, S570118\n"
        parsed = parse_demographics(text)
        assert parsed.address == "Blk 118 Bishan St 12 #07-21, S570118"


class TestTheNameIsCheckedNotGuessed:
    """The doctor types the name at step 1, before the paste box exists.

    That is not a convenience, it is the panel's first question, and it is
    asked first because `redaction.py` cannot find a name by shape — nothing
    can be scrubbed of a name nobody supplied. So by the time there is a block
    to parse, the name is already known, and finding it in the block is a
    lookup rather than a judgement.

    What that buys is the case nothing else could settle: two capitalised
    pieces on one header, one of them the patient and one of them somebody
    else.
    """

    HEADER = (
        "Chua Beng Huat · Tan Wei Ling · S7211043C · 04/11/1972 · 91112233 ·\n"
        "18 Toa Payoh Lorong 4, Singapore 310018\n"
    )

    def test_the_piece_that_is_the_name_is_the_one_that_matches(self) -> None:
        parsed = parse_demographics(self.HEADER, known_name="Chua Beng Huat")
        assert parsed.full_name == "Chua Beng Huat"
        # And the other person on the line is not read as anything.
        assert "Tan Wei Ling" not in (parsed.address or "")

    def test_a_surname_written_the_other_way_round_still_matches(self) -> None:
        # A CMS exporting surname-first against a doctor who typed it last, or
        # the reverse. `redaction.py` forgives the same rotation, and for the
        # same reason: they are one person, and a piece that does not match is
        # a piece left in the note.
        for typed in ("Beng Huat Chua", "CHUA BENG HUAT", "Chua  Beng Huat"):
            parsed = parse_demographics(self.HEADER, known_name=typed)
            assert parsed.full_name == "Chua Beng Huat", typed

    def test_a_name_that_matches_nothing_on_the_line_yields_no_name(self) -> None:
        # Neither piece is this patient, so neither is taken — the guess that
        # would have picked one is not reached when a name was supplied.
        parsed = parse_demographics(self.HEADER, known_name="Nurul Aisyah")
        assert parsed.full_name is None
        # Everything else on the line still parses; only the name is withheld.
        assert parsed.nric == "S7211043C"

    def test_without_a_name_it_falls_back_to_reading_one(self) -> None:
        # A caller that is not the panel has nothing to check against, so the
        # fenced guess is still there — and still refuses two candidates.
        assert parse_demographics(self.HEADER).full_name is None
        one_name = "Chua Beng Huat · S7211043C · 04/11/1972 · 91112233\n"
        assert parse_demographics(one_name).full_name == "Chua Beng Huat"


class TestAValueSomebodyElseOwns:
    """The hole the unlabelled pass had, and the word that closes it.

    That pass believes a shape that occurs exactly once. Its own docstring
    names the failure it was written to avoid — the clinic's number under the
    doctor's signature — and it only avoided it when a SECOND number happened
    to be present. One number in the note and the clinic's went onto the claim,
    green, as a value the doctor entered. Uniqueness was doing all the work,
    and uniqueness is not ownership.

    So a value with `clinic`, `next of kin`, `employer`, `husband` and the rest
    in front of it on the same line is dropped before the count is taken. Two
    consequences, and the second is the better one: the wrong value stops being
    taken, and the right value stops being refused for standing next to it.
    """

    def test_a_lone_clinic_number_is_not_the_patients(self) -> None:
        # docs/patient_details_cases.md case 6, and the defect it recorded.
        text = (
            "Patient: Goh Siew Lan\n"
            "Seen 11/08/2026. Follow-up of type 2 diabetes.\n"
            "Clinic address 9 Serangoon Road, Singapore 218000. Tel 62221234.\n"
        )
        parsed = parse_demographics(text)
        assert parsed.phone is None
        assert parsed.address is None
        # And it is not offered either: this is not a value nobody could
        # choose between, it is a value known to belong to somebody else.
        assert "phone" not in parsed.choices

    def test_the_patients_number_survives_the_clinics(self) -> None:
        # The other half. Before, two numbers meant neither, so a note with a
        # clinic footer could not yield a phone at all.
        text = "Reviewed today. Contactable on 91112233. Clinic tel 62551234.\n"
        assert parse_demographics(text).phone == "91112233"

    def test_a_family_members_nric_does_not_block_the_patients(self) -> None:
        # One line, two NRICs, and the note says which is which. Dropping the
        # whole line would lose both, so the disqualification is per value and
        # reads only what sits BEFORE it.
        text = "S6123456B, seen together with her husband S6234567C.\n"
        parsed = parse_demographics(text)
        assert parsed.nric == "S6123456B"
        assert "nric" not in parsed.choices

    @pytest.mark.parametrize(
        "line",
        [
            "Clinic tel 62551234",
            "Next of kin contact 91112233",
            "Employer contact 62551234",
            "Emergency contact 91112233",
            "Caregiver mobile 91112233",
        ],
    )
    def test_the_words_that_disqualify(self, line: str) -> None:
        assert parse_demographics(f"Seen 09/08/2026.\n{line}\n").phone is None

    @pytest.mark.parametrize(
        "line",
        [
            # "Dr" is how an address abbreviates Drive, and a disqualifier that
            # fires on it would blank correct addresses.
            "Blk 5 Bishan Dr #01-02, Singapore 570118",
            # "surgery" is a procedure in every other note.
            "For surgery. Contactable on 91112233",
        ],
    )
    def test_a_word_from_ordinary_notes_does_not_disqualify(self, line: str) -> None:
        parsed = parse_demographics(f"{line}\n")
        assert parsed.address is not None or parsed.phone is not None

    def test_a_labelled_value_is_never_disqualified(self) -> None:
        # The doctor wrote it against the field, on a line that also says
        # "Clinic". They said this is the patient's NRIC, so it is: only the
        # unlabelled pass reads ownership, because only the unlabelled pass is
        # guessing whose value it found.
        text = "Clinic visit today  NRIC S8012345D\n"
        parsed = parse_demographics(text)
        assert parsed.nric == "S8012345D"
        assert parsed.sources["nric"] == "labelled-inline"
