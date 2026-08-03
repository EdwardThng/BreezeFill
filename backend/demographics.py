"""Pull structured demographics out of one pasted block, without a model.

The doctor pastes the whole consultation into a single box. Something has to
turn that into the PatientRecord fields, and that something must not be an LLM:
`redaction.py` pass 1 uses the demographics AS THE DICTIONARY to scrub the
note, because a name has no shape for a regex to find. Send the block to a
model to split it and the name has already reached the model before any
dictionary exists — and the note can no longer be scrubbed of it either. The
ordering is the privacy model, not a preference.

So: patterns only, reusing the ones in redaction.py so there is one definition
of what an NRIC looks like rather than two that can drift.

---------------------------------------------------------------------------
What this refuses to do
---------------------------------------------------------------------------

Precision over coverage, the same bet the rest of the product makes. A blank
field costs the doctor one line of typing; a wrong NRIC or a neighbour's phone
number gets written onto a claim and signed. So:

- A labelled line ("NRIC: S1234567D") is always believed.
- A shape found in unlabelled prose is believed ONLY if it occurs exactly once
  in the whole paste. A note quoting the clinic's own phone number under the
  doctor's signature is the common case here, and two candidates means neither
  is returned.
- A date of birth is never taken from unlabelled text at all. A clinical note
  is full of dates — consultation, admission, discharge, MC — and every one of
  them is date-shaped.
- A name is never guessed from anything. It comes from a labelled line, or
  from the segment of a labelled patient line that no other rule claimed, or
  not at all.

Everything found is shown back to the doctor as an editable field. Nothing
here is a final answer; it is a first draft of one.
"""

from __future__ import annotations

import re
from datetime import date

from pydantic import BaseModel

from redaction import EMAIL_PATTERN, NRIC_PATTERN, SG_PHONE_PATTERN

# The doctor labels a line, or they do not. Synonyms are the ones a Singapore
# GP's CMS or a hand-typed header actually uses.
#
# Deliberately absent: "plan". A clinical note's "Plan: review 2/52" is not an
# insurance plan, and one wrong entry here poisons a field the doctor then has
# to notice and undo.
LABELS: dict[str, tuple[str, ...]] = {
    "full_name": ("name", "patient", "patientname", "fullname", "ptname", "pt"),
    "nric": ("nric", "fin", "nricfin", "nricno", "ic", "icno", "idno", "identitycard"),
    "dob": ("dob", "dateofbirth", "birthdate", "born"),
    "phone": ("phone", "tel", "telephone", "mobile", "hp", "handphone", "contact", "contactno"),
    "address": ("address", "addr", "residentialaddress"),
    "policy_number": (
        "policy", "policyno", "policynumber", "policy#", "memberno", "certificateno",
    ),
    "insurer": ("insurer", "insurance", "insurancecompany"),
}

_LABEL_LOOKUP = {alias: field for field, aliases in LABELS.items() for alias in aliases}

# "NRIC: S1234567D", "D.O.B - 14/03/1971". Anything longer than a short phrase
# before the colon is prose that happens to contain one, not a label.
LABELLED_LINE = re.compile(r"^\s*([A-Za-z][A-Za-z .#/]{0,23})\s*[:\-–]\s*(.+?)\s*$")

# Separators used when a whole patient block is written on one line, which is
# how the pilot's own test notes are laid out:
#   Patient: Chua Beng Huat · S7211043C · 04/11/1972 · 91112233 · 18 Toa Payoh
SEGMENT_SPLIT = re.compile(r"\s*[·|;]\s*|\s{2,}|\s+—\s+")

# Policy and member numbers: letters-dash-digits, or a long digit run. Kept
# tighter than redaction.py's blunt digit rule because this one assigns a
# value to a field rather than blanking it.
POLICY_PATTERN = re.compile(r"\b[A-Z]{2,5}[-/]?\d{4,}\b")

# A Singapore postal code, which is what makes an address segment an address.
POSTAL_PATTERN = re.compile(r"\bSingapore\s*\d{6}\b|\bS\d{6}\b|(?<!\d)\d{6}(?!\d)")

_MONTHS = {
    m: i + 1
    for i, name in enumerate(
        [
            "january", "february", "march", "april", "may", "june",
            "july", "august", "september", "october", "november", "december",
        ]
    )
    for m in (name, name[:3])
}

_DATE_PATTERNS = (
    # Singapore writes day first. 03/04/1971 is 3 April, never 4 March.
    re.compile(r"^(?P<d>\d{1,2})[/.\-](?P<m>\d{1,2})[/.\-](?P<y>\d{4})$"),
    re.compile(r"^(?P<y>\d{4})-(?P<m>\d{1,2})-(?P<d>\d{1,2})$"),
    re.compile(r"^(?P<d>\d{1,2})\s+(?P<mon>[A-Za-z]{3,9})\.?\s+(?P<y>\d{4})$"),
)


class ParsedDemographics(BaseModel):
    """A draft PatientRecord. Every field is optional: not finding something is
    a normal outcome, and the doctor completes it."""

    full_name: str | None = None
    nric: str | None = None
    # ISO, because the panel puts it straight into <input type="date">.
    dob: str | None = None
    phone: str | None = None
    address: str | None = None
    policy_number: str | None = None
    insurer: str | None = None
    # field -> how it was found: "labelled", "patient-line", or "sole-match".
    # Shown to nobody; it is here so a test can assert WHY a value was taken,
    # and so a future panel can mark guesses differently from labelled values.
    sources: dict[str, str] = {}


def _normalise_label(raw: str) -> str:
    return re.sub(r"[^a-z]", "", raw.lower())


def parse_date(text: str) -> str | None:
    """One date string -> ISO, or None if it is not a plausible birth date."""
    value = text.strip().rstrip(".,")
    for pattern in _DATE_PATTERNS:
        match = pattern.match(value)
        if not match:
            continue
        parts = match.groupdict()
        month = (
            _MONTHS.get(parts["mon"].lower())
            if parts.get("mon")
            else int(parts["m"])
        )
        if not month:
            return None
        try:
            parsed = date(int(parts["y"]), month, int(parts["d"]))
        except ValueError:
            return None
        # A birth date in the future, or before anyone alive, is a misparse —
        # far more likely a consultation date or a typo than a real DOB.
        if not (date(1900, 1, 1) <= parsed <= date.today()):
            return None
        return parsed.isoformat()
    return None


def _classify_segment(segment: str) -> tuple[str, str] | None:
    """One segment of a compound patient line -> (field, value)."""
    text = segment.strip().strip(",.")
    if not text:
        return None

    if NRIC_PATTERN.fullmatch(text):
        return "nric", text.replace(" ", "").upper()
    iso = parse_date(text)
    if iso:
        return "dob", iso
    if SG_PHONE_PATTERN.fullmatch(text):
        return "phone", text
    if EMAIL_PATTERN.fullmatch(text):
        return None  # nothing on the form asks for it

    # "Policy GHS-4471902" — drop the word, keep the number.
    stripped = re.sub(r"^(policy|member|certificate)\s*(no\.?|number|#)?\s*[:.]?\s*", "", text, flags=re.I)
    if POLICY_PATTERN.fullmatch(stripped.strip()):
        return "policy_number", stripped.strip()

    if POSTAL_PATTERN.search(text):
        return "address", text

    # Anything left with no digits in it is the name. A segment with digits
    # that matched none of the rules above is unidentified, and stays that way.
    if not re.search(r"\d", text):
        return "full_name", text
    return None


def _parse_patient_line(value: str) -> dict[str, tuple[str, str]]:
    """A labelled patient line, which may carry the whole block at once."""
    segments = [s for s in SEGMENT_SPLIT.split(value) if s and s.strip()]
    found: dict[str, tuple[str, str]] = {}
    if len(segments) <= 1:
        return {"full_name": (value.strip(), "labelled")}

    for segment in segments:
        classified = _classify_segment(segment)
        if classified is None:
            continue
        field, parsed = classified
        # First segment of a kind wins; a patient line does not list two NRICs.
        found.setdefault(field, (parsed, "patient-line"))
    return found


def _sole_match(pattern: re.Pattern[str], text: str) -> str | None:
    """A shape found in unlabelled prose, but only when there is exactly one
    candidate. Two distinct phone numbers in a note (the patient's and the
    clinic's, which sits under the doctor's signature) means neither is safe to
    assume, so neither is returned."""
    matches = {m.group(0).strip() for m in pattern.finditer(text)}
    return matches.pop() if len(matches) == 1 else None


def parse_demographics(text: str) -> ParsedDemographics:
    """The whole pasted block -> a draft PatientRecord.

    Never raises: unparseable input is an empty result, which the doctor fills
    in by hand exactly as they do today.
    """
    values: dict[str, str] = {}
    sources: dict[str, str] = {}

    def record(field: str, value: str, source: str) -> None:
        if field not in values and value:
            values[field] = value
            sources[field] = source

    for line in str(text or "").splitlines():
        match = LABELLED_LINE.match(line)
        if not match:
            continue
        field = _LABEL_LOOKUP.get(_normalise_label(match.group(1)))
        if not field:
            continue
        value = match.group(2).strip()

        if field == "full_name":
            for name, (parsed, source) in _parse_patient_line(value).items():
                record(name, parsed, source)
            continue
        if field == "dob":
            iso = parse_date(value)
            if iso:
                record("dob", iso, "labelled")
            continue
        if field == "nric":
            cleaned = value.replace(" ", "").upper()
            if NRIC_PATTERN.fullmatch(cleaned):
                record("nric", cleaned, "labelled")
            continue
        record(field, value, "labelled")

    # Whatever the labels did not supply, and only where a shape is unique.
    # Not the name (no shape), not the date of birth (a note is full of dates),
    # not the address (no reliable shape once the postal code is absent).
    if "nric" not in values:
        found = _sole_match(NRIC_PATTERN, text)
        if found:
            record("nric", found.replace(" ", "").upper(), "sole-match")
    if "phone" not in values:
        found = _sole_match(SG_PHONE_PATTERN, text)
        if found:
            record("phone", found, "sole-match")

    return ParsedDemographics(**values, sources=sources)
