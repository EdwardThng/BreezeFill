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
- A name is never guessed from prose. It comes from a labelled line, or from
  the one piece of a patient header that no other field claimed — and only
  when that header has already proved what it is by yielding two other fields,
  and only when the words are capitalised the way a name is. Two candidate
  names means neither.
- One piece, one field. A header block is cut into pieces and each piece is
  claimed once, so a value read as an NRIC cannot also be part of the address.
  This is not tidiness: the address rule used to take the whole line, which
  put the patient's NRIC, birth date, phone and policy number into the address
  box on any block nobody had labelled.

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

# The insurers a Singapore GP actually bills, and what a note calls them.
#
# An insurer is the one demographic with no shape and no infinite range: there
# are a few dozen of them, they are spelled the same way every time, and the
# list changes about once a year. So it is a vocabulary, and a vocabulary is a
# shape — which is what lets this field be found in prose at all.
#
# The canonical name on the left is what goes on the form, and for an insurer
# whose form is in the bank it is **the same string as that schema's
# `insurer`** — a value that disagreed with the schema would look like two
# insurers to anything comparing them.
#
# THE RULE FOR ADDING A VARIATION: a variation that is also an ordinary English
# word, or the first word of an institution's name, must be qualified. Bare
# "Income" matches "discussed income protection"; bare "Raffles" matches
# "Raffles Hospital A&E", which is in half the notes in Singapore; bare "GE"
# matches the policy prefix `GE-88213`; bare "FWD" matches the `Fwd:` on a
# pasted email. Each of those writes a wrong insurer onto a claim
# deterministically, under a green "from the details you entered" badge — the
# model never sees this field and cannot disagree with it.
#
# Plan names (PruShield, IncomeShield, HealthShield Gold Max) identify an
# insurer just as well and are deliberately absent: mapping a plan to its
# insurer is a fact about the market rather than about the words on the page,
# and one that goes stale without anything failing.
INSURERS: tuple[tuple[str, tuple[str, ...]], ...] = (
    # The seven Integrated Shield insurers, which is what a GP meets most.
    ("AIA", ("AIA", "AIA Singapore")),
    (
        "Great Eastern",
        ("Great Eastern", "Great Eastern Life", "Great Eastern Life Assurance"),
    ),
    ("HSBC Life", ("HSBC Life", "HSBC Insurance", "HSBC Life Singapore")),
    ("Income", ("Income Insurance", "NTUC Income")),
    (
        "Prudential",
        ("Prudential", "Prudential Assurance", "Prudential Singapore"),
    ),
    ("Raffles Health Insurance", ("Raffles Health Insurance",)),
    ("Singlife", ("Singlife", "Singapore Life", "Singlife with Aviva")),
    # Rebranded, and kept as their own names rather than rewritten to the new
    # ones. A note saying "Aviva" is echoed back as Aviva: restating it as
    # Singlife would put a word on the claim that the doctor did not write and
    # may not agree with.
    ("Aviva", ("Aviva", "Aviva Singapore")),
    ("AXA", ("AXA", "AXA Insurance", "AXA Singapore")),
    # The commercial and international insurers behind employer panels and
    # expatriate cover.
    ("Aetna", ("Aetna", "Aetna International")),
    ("Allianz", ("Allianz", "Allianz Partners")),
    ("Bupa", ("Bupa", "Bupa Global")),
    ("China Life", ("China Life",)),
    ("China Taiping", ("China Taiping",)),
    ("Chubb", ("Chubb", "Chubb Insurance")),
    ("Cigna", ("Cigna", "Cigna Healthcare")),
    ("Etiqa", ("Etiqa", "Etiqa Insurance")),
    ("FWD", ("FWD Insurance", "FWD Singapore")),
    ("Henner", ("Henner", "Henner Group")),
    ("Liberty", ("Liberty Insurance",)),
    ("Manulife", ("Manulife", "Manulife Singapore")),
    ("MSIG", ("MSIG", "MSIG Insurance")),
    ("QBE", ("QBE", "QBE Insurance")),
    ("Sompo", ("Sompo", "Sompo Insurance")),
    ("Tokio Marine", ("Tokio Marine", "Tokio Marine Life")),
)

# Normalised variation -> the name that goes on the form.
_INSURER_BY_VARIATION = {
    " ".join(variation.lower().split()): canonical
    for canonical, variations in INSURERS
    for variation in variations
}

# Longest variation first, so "Great Eastern Life" wins over "Great Eastern"
# and "AIA Singapore" over "AIA". Both collapse to one canonical name anyway —
# what the ordering buys is that the match covers the whole phrase, so the
# leftover " Life" cannot read as anything else.
INSURER_PATTERN = re.compile(
    r"\b(?:"
    + "|".join(
        r"\s+".join(re.escape(word) for word in variation.split())
        for variation in sorted(_INSURER_BY_VARIATION, key=len, reverse=True)
    )
    + r")\b",
    re.IGNORECASE,
)

# A Singapore postal code, which is what makes an address segment an address.
POSTAL_PATTERN = re.compile(r"\bSingapore\s*\d{6}\b|\bS\d{6}\b|(?<!\d)\d{6}(?!\d)")

# An address label that survived LABELLED_LINE because it carried no colon.
_ADDRESS_LABEL_PREFIX = re.compile(
    rf"^(?:{'|'.join(LABELS['address'])})\s*[:.\-]?\s+", re.I
)

# The fields a label may introduce ANYWHERE in a line, each with the shape its
# value has to take. The name is deliberately absent: it has no shape, so there
# would be nothing to confirm a guess against.
#
# The insurer used to be absent for the same reason and is not any more. Its
# shape is a closed vocabulary rather than a pattern — `INSURER_PATTERN` matches
# a name off the list and nothing else — which answers the same question a
# regex answers for an NRIC: is the thing after this label really a value for
# this field.
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
    "insurer": INSURER_PATTERN,
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

    # Before the name rule, because an insurer's name has no digits in it
    # either — "Patient: Tan Wei Ling · S8012345D · AIA" ends with a segment
    # that is a perfectly good name by every test but this one.
    insurer = _canonical_insurer(text)
    if insurer:
        return "insurer", insurer

    # Anything left with no digits in it is the name. A segment with digits
    # that matched none of the rules above is unidentified, and stays that way.
    if not re.search(r"\d", text):
        return "full_name", text
    return None


# The separators inside a header block, in two strengths.
#
# A HARD separator is one a doctor only ever types between fields: a middot, a
# pipe, a semicolon, an em dash, or the two-space gap they leave when lining a
# block up. Splitting on these is always safe.
#
# A SOFT separator is a comma or a full stop, and both appear INSIDE values as
# freely as they appear between them — "Lorong 4, Singapore 310018" is one
# address written with a comma in it, and every sentence of the clinical note
# ends in a full stop. They are used only inside a line already proved to be a
# header (see `_header_pieces`), and the address rule below puts back what they
# cut in half.
_HARD_SEP = re.compile(r"\s*[·|;]\s*|\s{2,}|\s+—\s+")
_SOFT_SEP = re.compile(r"\s*,\s*|\.\s+")

# A name is at most this many words. A longer run of words with no digits in it
# is a sentence, not somebody's name. Six rather than four because a Malay name
# written in full — "Muhammad Nur Iskandar Bin Abdullah" — is five.
MAX_NAME_WORDS = 6

# The particles that sit inside a name in lower case and are still part of it.
_NAME_PARTICLES = {"bin", "binte", "bte", "b", "s/o", "d/o", "a/l", "a/p",
                   "van", "von", "de", "del", "der", "di", "da", "la", "le"}


def _looks_like_a_name(text: str) -> bool:
    """Words that could be somebody's name, rather than a phrase.

    Capitalisation is the whole test, and it is a better one than length: a
    name is written with capitals in every note ever typed, and the leftover
    piece this has to reject — "patient reports ongoing epigastric discomfort"
    — is a sentence fragment in lower case. Word count alone cannot separate
    them, because a Malay name in full is as long as a short sentence.

    The cost, stated: a name typed entirely in lower case is not read as one.
    The doctor types the name themselves at step 1 regardless, so this costs a
    prefilled box rather than an answer.
    """
    words = text.split()
    if not (0 < len(words) <= MAX_NAME_WORDS):
        return False
    return all(
        word.lower().strip(".") in _NAME_PARTICLES or word[:1].isupper()
        for word in words
    )

# How many DIFFERENT fields a line must yield before it counts as a patient
# header rather than a line of prose that happens to contain a number.
#
# Two, and they must be different fields: a line naming three dates is a
# treatment history, while a line naming a date and an NRIC is a header. The
# whole point of the count is that the pieces stop being independent guesses —
# one shaped value in a sentence is a coincidence, two of different kinds on
# one line is a block of fields.
MIN_HEADER_FIELDS = 2


def _split_spans(text: str, start: int, end: int, sep: re.Pattern[str]) -> list[tuple[int, int]]:
    """`text[start:end]` cut at every separator, as spans into `text`.

    Spans rather than strings, because the address rule joins neighbouring
    pieces back together and has to give back what the note actually wrote —
    including the comma the split removed.
    """
    spans: list[tuple[int, int]] = []
    cursor = start
    for match in sep.finditer(text, start, end):
        if match.start() > cursor:
            spans.append((cursor, match.start()))
        cursor = match.end()
    if cursor < end:
        spans.append((cursor, end))
    return spans


def _piece_spans(line: str) -> list[tuple[int, int]]:
    """One line cut into the pieces a header block is made of."""
    pieces: list[tuple[int, int]] = []
    for start, end in _split_spans(line, 0, len(line), _HARD_SEP):
        pieces.extend(_split_spans(line, start, end, _SOFT_SEP))
    return [(s, e) for s, e in pieces if line[s:e].strip()]


def _header_pieces(line: str) -> tuple[dict[str, str], list[str]] | None:
    """One line -> the fields it carries, or None if it is not a header line.

    THE RULE THIS EXISTS FOR: a piece belongs to one field. An NRIC that has
    been recognised as an NRIC is not also part of the address, and neither is
    the date of birth, the phone number or the policy number. Before this, the
    address was "the line that has a postal code in it", so a header block
    written without a `Patient:` label put the entire block — name, NRIC, date
    of birth, phone, policy and all — into the address box, while the fields
    those values belonged to sat empty beside it.

    Two things make it safe to read a line nobody labelled:

    - It must yield `MIN_HEADER_FIELDS` different fields before anything is
      taken from it, so a sentence of clinical text is never read as a block.
    - The name is still not guessed from words. It is the ONE leftover piece
      with no digits in it, on a line that has already proved what it is, and
      two such pieces means neither — the same refusal every other field makes.

    Returns the fields found and the name candidates, or None for prose.
    """
    spans = _piece_spans(line)
    classified: list[tuple[int, int, str, str] | None] = []
    found: dict[str, str] = {}

    for start, end in spans:
        piece = line[start:end]
        result = _classify_segment(piece)
        if result is None or result[0] == "full_name":
            # Kept as a hole rather than dropped: the address rule walks back
            # over these, and the name is chosen from among them.
            classified.append(None)
            continue
        field, value = result
        classified.append((start, end, field, value))
        found.setdefault(field, value)

    if len(found) < MIN_HEADER_FIELDS:
        return None

    # The address is the run ENDING at the piece that carries the postal code,
    # extended back over neighbouring pieces that no field claimed and that
    # carry a digit. That is what puts "18 Toa Payoh Lorong 4" back together
    # with "Singapore 310018" after the comma split — and what stops the walk
    # at the name, which has no digits in it.
    for index, item in enumerate(classified):
        if item is None or item[2] != "address":
            continue
        start, end = item[0], item[1]
        back = index - 1
        while back >= 0 and classified[back] is None:
            piece_start, piece_end = spans[back]
            if not re.search(r"\d", line[piece_start:piece_end]):
                break
            start = piece_start
            back -= 1
        found["address"] = line[start:end].strip(" ,.;·|")
        break

    # Whatever is left with no digits in it, once every other field has taken
    # its own piece. Exactly one is a name; two is a question this cannot
    # answer, so it answers neither.
    names = [
        piece
        for (s, e), item in zip(spans, classified)
        if item is None
        and not re.search(r"\d", (piece := line[s:e].strip(" ,.;·|")))
        and _looks_like_a_name(piece)
    ]
    return found, names


def _parse_patient_line(value: str) -> dict[str, tuple[str, str]]:
    """A labelled patient line, which may carry the whole block at once."""
    # Tried first, and on the raw value rather than on `SEGMENT_SPLIT`'s
    # segments: a block written with commas — "Patient: Chua Beng Huat,
    # S7211043C, 04/11/1972" — has no middot and no double space in it, so the
    # segment split sees one segment and the whole block became the name.
    header = _header_pieces(value)
    if header is not None:
        fields, names = header
        found = {field: (found_, "patient-line") for field, found_ in fields.items()}
        # A labelled line names the patient, so its leftover piece is the name
        # without needing the evidence an unlabelled line has to produce.
        if len(names) == 1:
            found.setdefault("full_name", (names[0], "patient-line"))
        return found

    segments = [s for s in SEGMENT_SPLIT.split(value) if s and s.strip()]
    if len(segments) <= 1:
        return {"full_name": (value.strip(), "labelled")}

    found = {}
    for segment in segments:
        classified = _classify_segment(segment)
        if classified is None:
            continue
        field, parsed = classified
        # First segment of a kind wins; a patient line lists one NRIC.
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


def _canonical_insurer(text: str) -> str | None:
    """A string naming a known insurer -> the name this repo writes for it.

    Two readings, in order. The whole string may BE an insurer's name, which is
    what a labelled line usually holds. Failing that, one may sit inside it —
    "AIA Singapore (GHS plan)" is an insurer plus a parenthetical, and the
    parenthetical is not part of the answer.

    Two different insurers inside one string yields None, the same refusal the
    rest of the module makes: nothing here can tell which one the form wants.
    """
    exact = _INSURER_BY_VARIATION.get(" ".join(text.lower().split()))
    if exact:
        return exact
    found = _shaped_candidates("insurer", INSURER_PATTERN, text)
    return found[0] if len(found) == 1 else None


def _normalised(field: str, raw: str) -> str | None:
    """One raw match, in the form the field actually holds, or None if the
    shape matched but the value does not survive validation."""
    if field == "insurer":
        # The name this repo uses, not the one the note wrote: "AIA Singapore"
        # and "AIA" are one insurer, and a schema's `insurer` is the string
        # anything comparing them will compare against.
        return _INSURER_BY_VARIATION.get(" ".join(raw.lower().split()))
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


# A policy number as its two halves: the insurer's prefix and the digits that
# identify the policy. The separator is not one of them — `GHS-88213004`,
# `GHS/88213004` and `GHS88213004` are one reference written three ways.
_POLICY_PARTS = re.compile(r"^([A-Z]{2,5})[-/]?(\d{4,})$")


def _same_policy(a: str, b: str) -> bool:
    """Whether two policy numbers are one reference written two ways.

    Not a key, because sameness here is a relation rather than a canonical
    form: the digits must be identical AND one prefix must extend the other.
    `GH-88213004` and `GHS-88213004` are the same policy with the prefix
    truncated once, which is what a note looks like when someone typed it
    twice; `GE-88213004` and `GHS-88213004` are not, because neither prefix
    contains the other and those are two insurers.

    Requiring the digits to match is what keeps this from merging real
    references. The residual case — two genuinely different policies sharing a
    full digit run, one of whose prefixes extends the other — needs an
    insurer's numbering to collide with another's on the same patient's note,
    which is a different failure from the one being fixed and a much rarer one.
    """
    left, right = _POLICY_PARTS.match(a), _POLICY_PARTS.match(b)
    if not left or not right:
        return False
    if left.group(2) != right.group(2):
        return False
    return left.group(1).startswith(right.group(1)) or right.group(1).startswith(left.group(1))


def _duplicate_index(field: str, value: str, kept: list[str]) -> int | None:
    """Where `value` has already been seen, by this field's idea of sameness."""
    key = _dedupe_key(field, value)
    for index, existing in enumerate(kept):
        if _dedupe_key(field, existing) == key:
            return index
        if field == "policy_number" and _same_policy(existing, value):
            return index
    return None


def _shaped_candidates(
    field: str, pattern: re.Pattern[str], text: str
) -> list[str]:
    """Every distinct value of `field`'s shape in `text`, ready to use.

    Deduplicated AFTER normalising, so `S8012345D` written once in each case
    is one candidate rather than two, and one phone number written two ways is
    one candidate rather than a question. One candidate is the value; more than
    one is a question for the doctor; none is a genuine blank.

    The rendering the note wrote FIRST survives, not a canonical one: the list
    reads the way the note reads, and the value written onto the form is the
    one the doctor typed.

    A policy number is the one exception, and it is not a ranking. When two
    renderings are the same reference and one prefix extends the other, the
    fuller one replaces the shorter — both readings agree about the policy, so
    keeping `GH-88213004` over `GHS-88213004` would put a truncated prefix on
    a claim to honour an ordering rule that exists to preserve the doctor's own
    wording. The wording is the same wording; one of them is just cut short.
    """
    out: list[str] = []
    for raw in _all_matches(pattern, text):
        value = _normalised(field, raw)
        if not value:
            continue
        at = _duplicate_index(field, value, out)
        if at is None:
            out.append(value)
        elif field == "policy_number" and len(value) > len(out[at]):
            out[at] = value
    return out


# How far back a note's own business reaches. Inside this window a date is
# describing the episode being claimed for — the consultation, the admission,
# the discharge, the review, the first consult for this condition, the surgery
# the year before. Outside it, a date in a clinical note is overwhelmingly a
# birth date, because nothing else that old gets written down as a bare date.
#
# Two years rather than one: an episode routinely opens in the previous
# calendar year, and a first-consult date twelve months back is common enough
# that offering it as a birth date would put a plausible wrong answer one click
# away on ordinary notes.
#
# What this costs, stated rather than discovered later: an INFANT's birth date
# is inside the window, so an unlabelled one is not offered. That is the right
# side to fail on — the alternative offers every consultation date on every
# note, which is noise on all of them to catch a birth date on a few — and it
# is recoverable, since a paediatric claim states the date of birth in the
# header where the labelled rules read it directly.
CLINICAL_WINDOW_YEARS = 2


def _birth_date_candidates(text: str) -> list[str]:
    """The dates in the note that could plausibly be a birth date.

    Recency is the only signal available without reading meaning, and it is a
    surprisingly good one: a note's dates cluster around the episode, and a
    birth date does not. So a date inside the clinical window is taken to be
    describing the episode, and only what falls outside it is offered.

    A date with no year at all — "seen 2/8", "MC from 15/3" — never reaches
    here: `DATE_IN_TEXT` requires a year and `parse_date` requires four digits
    of it. That is the same judgement by a different route. A yearless date is
    shorthand, and shorthand is how a doctor writes THIS year, which makes it
    a consultation date; a birth date written that way could not be read
    anyway, since the century is exactly what is missing.

    Filtering rather than ranking, deliberately. The candidate list is evidence
    handed to the doctor, and a list that put the likeliest first would be this
    module deciding after all — quietly, in the one place nobody would look for
    a decision. Either a date could be a birth date or it could not.
    """
    today = date.today()
    try:
        cutoff = today.replace(year=today.year - CLINICAL_WINDOW_YEARS)
    except ValueError:  # 29 February, on a year whose counterpart has none
        cutoff = date(today.year - CLINICAL_WINDOW_YEARS, 2, 28)

    return [
        iso
        for iso in _shaped_candidates("dob", DATE_IN_TEXT, text)
        if date.fromisoformat(iso) <= cutoff
    ]


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
        # A header block is not an address, however many postal codes it
        # contains. `_header_pieces` has already taken the address out of it
        # piece by piece; taking the whole line here as well would be the bug
        # that rule exists to fix, arriving by the back door.
        if _header_pieces(line) is not None:
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

    def offer(field: str, candidates: list[str], minimum: int = 2) -> None:
        """Candidates the parser would not choose between, handed over rather
        than dropped.

        `minimum` is 2 everywhere except the date of birth, and the asymmetry
        follows from what a lone candidate means. For a shaped field a single
        match IS the answer — `record` takes it — so a one-item list could only
        ever be a value pretending to be a question. A date of birth is never
        taken from unlabelled text at all, so its single candidate has nowhere
        else to go: offering it is the only way it reaches the doctor.
        """
        if field not in choices and len(candidates) >= minimum:
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
        if field == "insurer":
            # A known insurer is written the way this repo writes it; an
            # unknown one is kept exactly as the doctor typed it. That last
            # part is the important half: the list is the insurers a GP meets
            # most, not every insurer that exists, and dropping a labelled
            # answer for being off the list would turn a correct value into a
            # blank on the one line where the doctor already said what it is.
            record("insurer", _canonical_insurer(value) or value, "labelled")
            continue
        record(field, value, "labelled")

    # A patient header written without a label in front of it.
    #
    # Third, so anything the doctor labelled still wins. What this adds is the
    # block that names its fields by position rather than by label — the shape
    # every CMS export and every hand-typed header actually uses — and the
    # property that makes it worth having: each piece is claimed by exactly one
    # field, so a value already read as an NRIC, a date of birth, a phone
    # number or a policy number cannot also turn up inside the address.
    for line in _logical_lines(text):
        header = _header_pieces(line)
        if header is None:
            continue
        fields, names = header
        for field, value in fields.items():
            record(field, value, "header-line")
        if len(names) == 1:
            record("full_name", names[0], "header-line")

    # Labels sitting mid-line, which the line-anchored rule above cannot see.
    # Runs after so an explicitly labelled line always wins, and only ever
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
    # The insurer joins them because its vocabulary is as good as a shape: a
    # note that names one insurer and no other has answered the question, and a
    # note that names two — the patient's and the one that declined last time —
    # has not, so it asks. What it cannot do is name one that is not on the
    # list, which is why the labelled line above still wins and still keeps
    # whatever the doctor wrote.
    for field, pattern in (
        ("nric", NRIC_PATTERN),
        ("phone", PHONE_IN_TEXT),
        ("insurer", INSURER_PATTERN),
    ):
        if field in values:
            continue
        candidates = _shaped_candidates(field, pattern, text)
        if len(candidates) == 1:
            record(field, candidates[0], "sole-match")
        else:
            offer(field, candidates)

    # The dates, once nothing has claimed one as the birth date.
    #
    # Still never RECORDED from unlabelled text — that rule is unchanged and is
    # what stops a consultation date being written onto a claim. What changes
    # is that the blank is no longer silent: a note is full of dates, and the
    # doctor is the only one who knows which of them is a birth date, so they
    # are shown the list instead of an empty box with nothing behind it.
    #
    # The hazard is real and is the reason this was refused for so long: every
    # admission, discharge and review date is date-shaped too. It survives
    # being offered because a choice is not a fill — nothing is pre-selected
    # and no candidate reaches the field without a click — and because the
    # clinical dates are now filtered out rather than listed alongside.
    if "dob" not in values:
        offer("dob", _birth_date_candidates(text), minimum=1)

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
