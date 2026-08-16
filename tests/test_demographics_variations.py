"""Thirty headers, written the way a GP actually types one.

The existing suite tests the module's rules. This one tests its *inputs*: the
same seven values, arrived at thirty different ways, because the pilot does not
write the way the fixtures do and neither does any CMS. Most of these carry no
labels at all, and several carry no punctuation either — a doctor lining a
header up with spaces or tabs is not writing a delimited record, they are
typing.

Every identifier is synthetic.

---------------------------------------------------------------------------
How to read a case
---------------------------------------------------------------------------

`want` is what the field should hold. `blank` is what it must NOT hold — a
field listed there is one where a value would be wrong, not merely absent, and
those are the assertions worth having. `xfail` marks a case the parser gets
wrong today, with the reason; those are a to-do list rather than a description
of correct behaviour, so they are written as the right answer and marked, not
softened to match what happens.

Two things are absent from `want` throughout, and neither is an oversight:

- **A date of birth alone on an unlabelled line is offered, never recorded.**
  A note is full of dates and only a header says which one is a birth date.
- **A name in lower case is not read as a name.** Capitalisation is what
  separates "chua beng huat" from a sentence fragment, and the doctor types
  the name at step 1 regardless, so this costs a prefilled box.
"""

from __future__ import annotations

import pytest

from demographics import parse_demographics

FIELDS = ("full_name", "nric", "dob", "phone", "address", "policy_number", "insurer")


RAW: list[dict] = []


def case(cid, probe, note, want, blank=(), xfail=None):
    RAW.append({"id": cid, "probe": probe, "note": note, "want": want,
                "blank": blank, "xfail": xfail})
    return pytest.param(cid, note, want, blank, id=cid, marks=(
        [pytest.mark.xfail(reason=xfail, strict=True)] if xfail else []
    ))


CASES = [
    # -- no punctuation: whitespace is the only separator -------------------
    case(
        "space-run",
        "the whole header space-separated",
        "Tan Wei Ling S8012345D 14/03/1978 91234567\n",
        {"full_name": "Tan Wei Ling", "nric": "S8012345D",
         "dob": "1978-03-14", "phone": "91234567"},
    ),
    case(
        "space-run-address",
        "space-separated, with the address on the end",
        "Tan Wei Ling S8012345D 14/03/1978 91234567 "
        "Blk 118 Bishan St 12 #07-21 S570118\n",
        {"full_name": "Tan Wei Ling", "nric": "S8012345D", "dob": "1978-03-14",
         "phone": "91234567", "address": "Blk 118 Bishan St 12 #07-21 S570118"},
    ),
    case(
        "tabs",
        "a CMS export, tab-separated",
        "Tan Wei Ling\tS8012345D\t14/03/1978\t91234567\n",
        {"full_name": "Tan Wei Ling", "nric": "S8012345D",
         "dob": "1978-03-14", "phone": "91234567"},
    ),
    case(
        "one-per-line",
        "one value per line, nothing labelled",
        "Tan Wei Ling\nS8012345D\n14/03/1978\n91234567\n",
        {"full_name": "Tan Wei Ling", "nric": "S8012345D",
         "dob": "1978-03-14", "phone": "91234567"},
    ),
    case(
        "double-space",
        "two-space gaps, the way a header lines up",
        "Tan Wei Ling  S8012345D  14/03/1978  91234567\n",
        {"full_name": "Tan Wei Ling", "nric": "S8012345D",
         "dob": "1978-03-14", "phone": "91234567"},
    ),
    # -- how the name arrives ----------------------------------------------
    case(
        "title",
        "a title in front of the name",
        "Mr Chua Beng Huat  S7211043C  04/11/1972\n",
        {"full_name": "Mr Chua Beng Huat", "nric": "S7211043C", "dob": "1972-11-04"},
    ),
    case(
        "all-caps",
        "the whole header in capitals, as a CMS emits it",
        "CHUA BENG HUAT  S7211043C  04/11/1972  91112233\n",
        {"full_name": "CHUA BENG HUAT", "nric": "S7211043C",
         "dob": "1972-11-04", "phone": "91112233"},
    ),
    case(
        "name-after-nric",
        "the NRIC first and the name after it",
        "S7211043C  CHUA BENG HUAT  04/11/1972\n",
        {"full_name": "CHUA BENG HUAT", "nric": "S7211043C", "dob": "1972-11-04"},
    ),
    case(
        "comma-reversed",
        "surname first, separated by a comma",
        "Chua, Beng Huat  S7211043C  04/11/1972\n",
        {"full_name": "Chua, Beng Huat", "nric": "S7211043C", "dob": "1972-11-04"},
    ),
    case(
        "malay-name",
        "bin in the middle of the name",
        "Muhammad Nur Iskandar Bin Abdullah  S8830517D  17/05/1988\n",
        {"full_name": "Muhammad Nur Iskandar Bin Abdullah",
         "nric": "S8830517D", "dob": "1988-05-17"},
    ),
    case(
        "indian-name",
        "s/o in the middle of the name",
        "Sivakumar s/o Raju  S7511043B  11/10/1975\n",
        {"full_name": "Sivakumar s/o Raju", "nric": "S7511043B", "dob": "1975-10-11"},
    ),
    case(
        "punctuated-name",
        "an apostrophe and a hyphen in the name",
        "Nur-Aisyah D'Cruz  S9012345A  02/02/1990\n",
        {"full_name": "Nur-Aisyah D'Cruz", "nric": "S9012345A", "dob": "1990-02-02"},
    ),
    case(
        "age-and-sex",
        "age and sex jammed onto the name",
        "Chua Beng Huat 53M  S7211043C  04/11/1972\n",
        {"nric": "S7211043C", "dob": "1972-11-04"},
        # The name piece has a digit in it, so it is not a name candidate.
        # Documented rather than fixed: the doctor typed the name at step 1.
        blank=("full_name",),
    ),
    case(
        "sex-comma-age",
        "the `F, 47` style on its own line",
        "Tan Wei Ling, F, 47\nS8012345D  14/03/1978\n",
        {"nric": "S8012345D", "dob": "1978-03-14"},
        blank=("full_name",),
    ),
    # -- the identifiers, written every way --------------------------------
    case(
        "lowercase-nric",
        "an NRIC typed in lower case",
        "tan wei ling  s8012345d  14/03/1978\n",
        {"nric": "S8012345D", "dob": "1978-03-14"},
        blank=("full_name",),
    ),
    case(
        "fin",
        "a work-pass holder's FIN rather than an NRIC",
        "Rahman Bin Ismail  G1234567X  20/06/1985  81234567\n",
        {"full_name": "Rahman Bin Ismail", "nric": "G1234567X",
         "dob": "1985-06-20", "phone": "81234567"},
    ),
    case(
        "date-written-out",
        "the date of birth in long form",
        "Rahmat bin Osman  S7123456J  3 April 1971\n",
        {"full_name": "Rahmat bin Osman", "nric": "S7123456J", "dob": "1971-04-03"},
    ),
    case(
        "date-single-digits",
        "single-digit day and month",
        "Tan Wei Ling  S8012345D  4/3/1978\n",
        {"full_name": "Tan Wei Ling", "nric": "S8012345D", "dob": "1978-03-04"},
    ),
    case(
        "date-dashes",
        "a date written with dashes",
        "Tan Wei Ling  S8012345D  14-03-1978\n",
        {"full_name": "Tan Wei Ling", "nric": "S8012345D", "dob": "1978-03-14"},
    ),
    case(
        "date-iso",
        "a date the CMS exported as ISO",
        "Tan Wei Ling  S8012345D  1978-03-14\n",
        {"full_name": "Tan Wei Ling", "nric": "S8012345D", "dob": "1978-03-14"},
    ),
    case(
        "phone-country-code",
        "a phone with +65 in front",
        "Tan Wei Ling  S8012345D  +65 9123 4567\n",
        {"full_name": "Tan Wei Ling", "nric": "S8012345D", "phone": "+65 9123 4567"},
    ),
    case(
        "phone-dash",
        "a phone written with a dash",
        "Tan Wei Ling  S8012345D  9123-4567\n",
        {"full_name": "Tan Wei Ling", "nric": "S8012345D", "phone": "9123-4567"},
    ),
    # -- separators a doctor reaches for -----------------------------------
    case(
        "pipes",
        "pipe separators",
        "Chua Beng Huat | S7211043C | 04/11/1972 | 91112233\n",
        {"full_name": "Chua Beng Huat", "nric": "S7211043C",
         "dob": "1972-11-04", "phone": "91112233"},
    ),
    case(
        "hyphens",
        "spaced hyphens as separators",
        "Chua Beng Huat - S7211043C - 04/11/1972 - 91112233\n",
        {"full_name": "Chua Beng Huat", "nric": "S7211043C",
         "dob": "1972-11-04", "phone": "91112233"},
    ),
    case(
        "slashes",
        "slashes as separators",
        "Chua Beng Huat / S7211043C / 04/11/1972\n",
        {"full_name": "Chua Beng Huat", "nric": "S7211043C", "dob": "1972-11-04"},
    ),
    case(
        "wrapped-without-a-separator",
        "a header that wrapped with nothing to say so",
        "Chua Beng Huat  S7211043C  04/11/1972\n"
        "18 Toa Payoh Lorong 4 Singapore 310018\n",
        {"full_name": "Chua Beng Huat", "nric": "S7211043C", "dob": "1972-11-04",
         "address": "18 Toa Payoh Lorong 4 Singapore 310018"},
    ),
    # -- the rest of the note gets in the way ------------------------------
    case(
        "abbreviated-labels",
        "the abbreviations a GP actually types",
        "Pt: Chua Beng Huat\nIC: S7211043C\nHP: 91112233\nDOB: 04/11/1972\n",
        {"full_name": "Chua Beng Huat", "nric": "S7211043C",
         "phone": "91112233", "dob": "1972-11-04"},
    ),
    case(
        "header-then-consultation",
        "a header with a whole consultation under it",
        "Chua Beng Huat  S7211043C  04/11/1972  91112233\n\n"
        "Seen 14/03/2026. 2/7 fever cough. T 38.2 BP 128/76 HR 92.\n"
        "Dx URTI. Rx paracetamol 1g QDS. MC 2 days from 14/03/2026.\n",
        {"full_name": "Chua Beng Huat", "nric": "S7211043C",
         "dob": "1972-11-04", "phone": "91112233"},
    ),
    case(
        "child-and-mother",
        "a child's note that carries the mother's details too",
        "Child: Tan Jia Hui  T1512345E  08/09/2015\n"
        "Mother: Tan Wei Ling  S8012345D  91234567\n",
        {"nric": "T1512345E", "dob": "2015-09-08"},
        # The number belongs to the mother, and the line says so.
        blank=("phone",),
    ),
    case(
        "insurer-unlabelled",
        "the insurer and policy on their own line, no labels",
        "Chua Beng Huat  S7211043C  04/11/1972\n"
        "Great Eastern  Policy GE-88213004\n",
        {"full_name": "Chua Beng Huat", "nric": "S7211043C", "dob": "1972-11-04",
         "insurer": "Great Eastern", "policy_number": "GE-88213004"},
    ),
]


@pytest.mark.parametrize("cid, note, want, blank", CASES)
def test_a_header_a_doctor_would_type(cid, note, want, blank):
    parsed = parse_demographics(note)
    for field, expected in want.items():
        assert getattr(parsed, field) == expected, field
    for field in blank:
        assert getattr(parsed, field) is None, field


def test_no_case_writes_a_value_into_the_wrong_field():
    """Across all thirty, nothing lands somewhere it does not belong.

    Separate from the per-case assertions because it is a different question.
    Those ask whether a value was found; this asks whether a value that WAS
    found could be read as belonging to another field — an NRIC inside the
    address, a policy number in the phone box — which is the failure that
    reaches a signed claim rather than an empty box.
    """
    for entry in RAW:
        # A case already known broken fails this for the reason its own xfail
        # names, and would report the same defect twice under two headings.
        if entry["xfail"]:
            continue
        cid, parsed = entry["id"], parse_demographics(entry["note"])
        others = {f: getattr(parsed, f) for f in FIELDS if f != "address"}
        if parsed.address:
            for field, value in others.items():
                if value and field != "full_name":
                    assert value not in parsed.address, f"{cid}: {field} inside address"
        if parsed.phone and parsed.policy_number:
            assert parsed.phone not in parsed.policy_number, cid
