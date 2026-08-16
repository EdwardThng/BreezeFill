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

# A date as it appears inside running text, in any of the renderings a note
# uses. Only a candidate — `parse_date` still decides whether it is a plausible
# birth date.
DATE_IN_TEXT = re.compile(
    r"\b\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}\b"
    r"|\b\d{4}-\d{1,2}-\d{1,2}\b"
    r"|\b\d{1,2}\s+[A-Za-z]{3,9}\.?\s+\d{4}\b"
)


# Policy and member numbers: letters-dash-digits, or a long digit run. Kept
# tighter than redaction.py's blunt digit rule because this one assigns a
# value to a field rather than blanking it.
POLICY_PATTERN = re.compile(r"\b[A-Z]{2,5}[-/]?\d{4,}\b")

# A phone number that is a phone number, and not the tail of something else.
#
# `SG_PHONE_PATTERN` guards against a longer DIGIT run — `(?<!\d)` and `(?!\d)`
# — which is all redaction needs, because redaction blanks what it matches and
# over-matching there costs nothing. This module assigns a value to a field, so
# it has to answer a harder question: is this run a number in its own right, or
# part of a larger token?
#
# `Policy GHS-88213004` is the case that matters. Its tail is eight digits
# opening with an 8, so it is a valid Singapore mobile by shape, and the
# unlabelled-prose pass below would have written the patient's policy number
# into their phone box — deterministically, bypassing the model and the review
# step, on any note carrying one such policy number and no phone.
#
# So a phone must be delimited by something that is not identifier material:
# not a letter, not a digit, and not one of the connectors that bind a
# reference together. Read the whole token first; if the digits are only part
# of it, they are not a phone number.
#
# Deliberately NOT applied to `NRIC_PATTERN`, and the asymmetry is the point: a
# phone number is never embedded inside a reference, but an NRIC inside one
# (`REF-S8012345D`) is still the patient's NRIC, and refusing it would lose a
# correct value to avoid a collision that does not happen.
_TOKEN_CHAR = r"[A-Za-z0-9\-/#]"
PHONE_IN_TEXT = re.compile(
    rf"(?<!{_TOKEN_CHAR}){SG_PHONE_PATTERN.pattern}(?!{_TOKEN_CHAR})"
)

# A Singapore postal code, which is what makes an address segment an address.
POSTAL_PATTERN = re.compile(r"\bSingapore\s*\d{6}\b|\bS\d{6}\b|(?<!\d)\d{6}(?!\d)")

# An address label that survived LABELLED_LINE because it carried no colon.
_ADDRESS_LABEL_PREFIX = re.compile(
    rf"^(?:{'|'.join(LABELS['address'])})\s*[:.\-]?\s+", re.I
)

# The fields a label may introduce ANYWHERE in a line, each with the shape its
# value has to take. Name and insurer are deliberately absent: they have no
# shape, so there would be nothing to confirm a guess against.
#
# Address is absent for a different reason, and it is not "no shape" — it has
# one, and `_sole_address` uses it. It is absent because this pass returns the
# matched shape as the value, and for an address the shape is the postal code
# while the value is the whole line.
SHAPED_FIELDS = {
    "nric": NRIC_PATTERN,
    "phone": PHONE_IN_TEXT,
    "policy_number": POLICY_PATTERN,
    "dob": DATE_IN_TEXT,
}

# Longest alias, in words: "date of birth".
MAX_LABEL_WORDS = 3


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

    # field -> the candidates found where the parser refused BECAUSE there was
    # more than one. Never populated for a field that resolved, and never for
    # a field with no shape.
    #
    # The distinction this carries is the whole point: "the note does not say"
    # and "the note says two things and nothing here can choose between them"
    # both produced an empty box, and only the first of them should. A blank
    # the doctor cannot account for reads as the product failing to look.
    #
    # It is emphatically NOT a ranking. Nothing decides that a mobile beats a
    # landline or that the first match wins — the refusal to guess is
    # unchanged, and all that travels is the evidence behind it, to the one
    # person who can settle it.
    choices: dict[str, list[str]] = {}


def _normalise_label(raw: str) -> str:
    return re.sub(r"[^a-z]", "", raw.lower())


# Words that may sit around a demographic label while it still means the
# patient's own field. Everything NOT on this list disqualifies the label, and
# that direction is the safety property: `Hospital name`, `Doctor's name`,
# `Employer name` and `Name of attending physician` all fail to resolve, so
# they go to the model as ordinary questions instead of being answered with the
# patient's name.
_PATIENT_QUALIFIERS = (
    "patient", "patients", "patientsown", "thepatient", "ofpatient",
    "ofthepatient", "the", "please", "enter",
)


def demographic_field_for_label(label: str) -> str | None:
    """A form control's label -> the demographic field it asks for, or None.

    The vocabulary is `LABELS`, the same table the note parser uses, so the two
    cannot drift. What differs is the direction of the question: the parser
    asks "what field does this line of a note announce", and this asks "what
    field does this box on an insurer's form want".

    Matching is exact against the alias table once a patient-qualifier has been
    stripped. Nothing fuzzy, and deliberately so — the value written here does
    not pass the model and is not derived from the note, so a mismatch puts the
    patient's NRIC in a box asking for something else, with a green
    "From the details you entered" badge above it. A miss costs one field the
    doctor types by hand; a false match is a wrong identifier on a claim.
    """
    text = _normalise_label(label)
    if not text:
        return None

    # Strip patient-qualifiers from either end, longest first, until nothing
    # more comes off — "Patient's Full Name" and "Name of the Patient" both
    # reduce to "name", while "Hospital name" reduces to itself.
    changed = True
    while changed and text:
        changed = False
        for qualifier in sorted(_PATIENT_QUALIFIERS, key=len, reverse=True):
            if text.startswith(qualifier) and len(text) > len(qualifier):
                text = text[len(qualifier):]
                changed = True
                break
            if text.endswith(qualifier) and len(text) > len(qualifier):
                text = text[: -len(qualifier)]
                changed = True
                break

    return _LABEL_LOOKUP.get(text)


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


def _logical_lines(text: str) -> list[str]:
    """Rejoin a patient block that wrapped.

    A long header line arrives wrapped as often as not — docs/test_notes.md
    itself breaks mid-block, right after the phone number — and the half that
    ends up on the second physical line carries no label, so a strictly
    line-based parser drops the address and the policy number silently.

    Only a line ending in a segment separator is continued. That character is
    the author saying more follows; without it, joining lines would swallow the
    clinical note into the patient block.
    """
    lines: list[str] = []
    for line in text.splitlines():
        if lines and re.search(r"[·|;,—-]\s*$", lines[-1]):
            lines[-1] = f"{lines[-1].rstrip()} {line.strip()}"
            continue
        lines.append(line)
    return lines


def _label_positions(line: str) -> list[tuple[int, int, str]]:
    """Every known label in a line, as (start, end, field).

    Found by normalising 1–3 word windows rather than by matching a fixed
    pattern, so "DOB", "D.O.B", "Date of Birth" and "dateOfBirth" all resolve
    to the same field without the alias table carrying every spelling.
    """
    words = [(m.start(), m.end(), m.group(0)) for m in re.finditer(r"[A-Za-z]+", line)]
    found: list[tuple[int, int, str]] = []
    used_until = -1

    for i in range(len(words)):
        if words[i][0] < used_until:
            continue
        # A LABEL HAS TO START A FIELD, not sit in the middle of a phrase.
        #
        # Without this, "Clinic tel 62551234" reads as the patient's phone —
        # the clinic's own number, under the doctor's signature, written onto
        # a claim as the patient's. The qualifying word in front is exactly
        # what says it is not theirs, and the same shape catches "Next of kin
        # phone" and "Emergency contact".
        #
        # So the label must open the line or follow a separator: a comma, a
        # bullet, a pipe, a bracket, or the two-space gap a doctor leaves when
        # putting two fields on one line.
        before = line[:words[i][0]]
        if before and not re.search(r"(?:[,;·|(\[\t]|\s{2,}|^)\s*$", before):
            continue
        # Longest window first: "date of birth" must win over a bare "date".
        for take in range(min(MAX_LABEL_WORDS, len(words) - i), 0, -1):
            window = words[i : i + take]
            field = _LABEL_LOOKUP.get(_normalise_label("".join(w[2] for w in window)))
            if field and field in SHAPED_FIELDS:
                found.append((window[0][0], window[-1][1], field))
                used_until = window[-1][1]
                break
    return found


def _labelled_anywhere(line: str) -> dict[str, str]:
    """Fields introduced by a label sitting anywhere in the line.

    Doctors do not write in one format. `NRIC S8012345D  DOB 14/03/1978` puts
    two labels on one line with no colon after either; the line-anchored rule
    sees neither, and the shape-only fallback cannot supply a date of birth
    because a clinical note is full of dates. So a label is read wherever it
    appears — but ONLY for fields whose value has a shape, and only when the
    value that follows actually has it.

    That is the whole safety argument. The label says which field; the shape
    says whether the thing after it is really a value for that field. A label
    followed by something of the wrong shape yields nothing rather than a
    guess, so `Policy discussed with patient` contributes no policy number.

    A region carrying MORE than one candidate yields nothing either, for the
    same reason `_sole_match` refuses: `HP 9123 4567 / 6123 4567` names two
    numbers and nothing here can tell which one the form wants.
    """
    labels = _label_positions(line)
    found: dict[str, str] = {}
    choices: dict[str, list[str]] = {}

    for index, (_, end, field) in enumerate(labels):
        # The value runs to the next label, or to the end of the line.
        stop = labels[index + 1][0] if index + 1 < len(labels) else len(line)
        region = line[end:stop]

        candidates = _shaped_candidates(field, SHAPED_FIELDS[field], region)
        if len(candidates) == 1:
            found.setdefault(field, candidates[0])
        elif len(candidates) > 1:
            # Unchanged: nothing is chosen here. What changes is that the
            # candidates survive, so the panel can ask instead of showing a
            # blank the doctor cannot account for.
            choices.setdefault(field, candidates)

    return found, choices


def _all_matches(pattern: re.Pattern[str], text: str) -> list[str]:
    """Distinct matches, in the order the note wrote them.

    Ordered rather than a set because these reach the doctor as a list to
    choose from, and a list of their own note's values should read the way
    their note does. Deduplicated because the same number written twice is one
    candidate, not two.
    """
    seen: list[str] = []
    for match in pattern.finditer(text):
        value = match.group(0).strip()
        if value and value not in seen:
            seen.append(value)
    return seen


def _normalised(field: str, raw: str) -> str | None:
    """One raw match, in the form the field actually holds, or None if the
    shape matched but the value does not survive validation."""
    if field == "nric":
        cleaned = raw.replace(" ", "").upper()
        return cleaned if NRIC_PATTERN.fullmatch(cleaned) else None
    if field == "dob":
        # ISO, because that is what the field holds and what the panel's date
        # input accepts. A candidate offered to the doctor has to be a value
        # they can pick, not a string someone still has to convert.
        return parse_date(raw)
    return raw


def _dedupe_key(field: str, value: str) -> str:
    """What makes two candidates the same identifier rather than two of them.

    Only phone needs one. Every other shaped field arrives from `_normalised`
    in a single canonical form already — an NRIC uppercased and stripped of
    spaces, a date as ISO — so equal values are equal strings. A phone number
    is deliberately kept as the note wrote it, because that is what the doctor
    reads back and what goes onto the form, and the renderings of one number
    are exactly the ones a note mixes: `+65 9123 4567`, `9123-4567`, `91234567`.

    Without this the two-candidate rule fired on a single number written twice
    — the doctor was asked to choose between one number and itself, and the
    field stayed blank until they did. The refusal to guess is unchanged; what
    changes is that one number is no longer mistaken for two.
    """
    if field != "phone":
        return value
    digits = re.sub(r"\D", "", value)
    # +65 is a country code, not part of the number — but only when what
    # remains is a whole Singapore one. `6512 3456` is a landline whose own
    # first two digits are 65, and stripping those would leave six digits and
    # collide with any other 65-prefixed number in the note.
    if len(digits) == 10 and digits.startswith("65"):
        digits = digits[2:]
    return digits


def _shaped_candidates(
    field: str, pattern: re.Pattern[str], text: str
) -> list[str]:
    """Every distinct value of `field`'s shape in `text`, ready to use.

    Deduplicated AFTER normalising, so `S8012345D` written once in each case
    is one candidate rather than two, and one phone number written two ways is
    one candidate rather than a question. One candidate is the value; more than
    one is a question for the doctor; none is a genuine blank.

    The FIRST rendering survives, not a canonical one: the list reads the way
    the note reads, and the value written onto the form is the one the doctor
    typed.
    """
    out: list[str] = []
    seen: set[str] = set()
    for raw in _all_matches(pattern, text):
        value = _normalised(field, raw)
        if not value:
            continue
        key = _dedupe_key(field, value)
        if key in seen:
            continue
        seen.add(key)
        out.append(value)
    return out


def _address_lines(text: str) -> list[str]:
    """Every line carrying a Singapore postal code, in order.

    The same rule as `_sole_match`, with one difference that matters: for every
    other shaped field the shape *is* the value, and here it is only the
    evidence. `S570118` is what proves the line is an address; the address is
    the whole line, which is also what `_classify_segment` returns for the
    compound-line form.

    Two candidates yields neither, for the reason the phone rule does: a note
    carries the clinic's own address under the doctor's signature about as
    often as it carries its phone number, and writing that onto a claim as the
    patient's is the failure this module exists to avoid. The caller decides —
    one line is the address, more than one is a question for the doctor.
    """
    lines: list[str] = []
    for line in _logical_lines(text):
        if not POSTAL_PATTERN.search(line):
            continue
        # A label with no colon never reached LABELLED_LINE, so it is still
        # attached. It introduces the address; it is not part of it.
        cleaned = _ADDRESS_LABEL_PREFIX.sub("", line.strip()).strip()
        if cleaned and cleaned not in lines:
            lines.append(cleaned)
    return lines


def parse_demographics(text: str) -> ParsedDemographics:
    """The whole pasted block -> a draft PatientRecord.

    Never raises: unparseable input is an empty result, which the doctor fills
    in by hand exactly as they do today.
    """
    text = str(text or "")
    values: dict[str, str] = {}
    sources: dict[str, str] = {}
    choices: dict[str, list[str]] = {}

    def record(field: str, value: str, source: str) -> None:
        if field not in values and value:
            values[field] = value
            sources[field] = source

    def offer(field: str, candidates: list[str]) -> None:
        """More than one candidate: hand them over rather than dropping them."""
        if field not in choices and len(candidates) > 1:
            choices[field] = candidates

    for line in _logical_lines(text):
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

    # Labels sitting mid-line, which the line-anchored rule above cannot see.
    # Runs second so an explicitly labelled line always wins, and only ever
    # fills fields still empty.
    for line in _logical_lines(text):
        line_found, line_choices = _labelled_anywhere(line)
        for field, value in line_found.items():
            record(field, value, "labelled-inline")
        for field, candidates in line_choices.items():
            offer(field, candidates)

    # Whatever the labels did not supply, and only where a shape is unique.
    # Not the name (no shape), and not the date of birth (a note is full of
    # dates, so the shape cannot tell which one is a birth date — and a list of
    # every date in the note would invite the doctor to pick a consultation
    # date as a birth date, which is why `dob` is offered as a choice only from
    # a region a label already said was a date of birth).
    for field, pattern in (("nric", NRIC_PATTERN), ("phone", PHONE_IN_TEXT)):
        if field in values:
            continue
        candidates = _shaped_candidates(field, pattern, text)
        if len(candidates) == 1:
            record(field, candidates[0], "sole-match")
        else:
            offer(field, candidates)

    if "address" not in values:
        candidates = _address_lines(text)
        if len(candidates) == 1:
            record("address", candidates[0], "sole-match")
        else:
            offer("address", candidates)

    # A field that resolved is not also a question. An earlier pass may have
    # answered something a later one found two candidates for — the value
    # wins, exactly as `record` makes the first one win.
    choices = {f: c for f, c in choices.items() if f not in values}

    return ParsedDemographics(**values, sources=sources, choices=choices)
