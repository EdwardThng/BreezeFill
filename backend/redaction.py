"""Redaction module: strips patient identifiers from clinical text before it
reaches the LLM (README section 3).

Design rules:
- Over-redaction is safe; under-redaction is not.
- The redaction map lives in memory for the request session only. Never log it,
  never send it to the LLM.
- Re-merge substitutes tokens with *canonical* values (registered full name,
  DD/MM/YYYY dates), which is what the insurance form wants anyway. Exact
  round-tripping is only guaranteed when the note contains identifiers in
  canonical form.
"""

from __future__ import annotations

import json
import re
from datetime import date
from pathlib import Path
from typing import Callable

from pydantic import BaseModel

# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------


class PatientRecord(BaseModel):
    # Structured demographics — the redaction dictionary AND the direct-copy
    # form values. The LLM never sees these.
    full_name: str
    nric: str
    dob: date
    phone: str | None = None
    address: str | None = None
    policy_number: str | None = None
    insurer: str

    # Unstructured — the messy blob pasted from ClinicAssist.
    clinical_text: str


class RedactionResult(BaseModel):
    redacted_text: str
    # token -> real value, e.g. {"[PATIENT]": "Tan Wei Ming"}
    redaction_map: dict[str, str]


TOKEN_RE = re.compile(r"\[[A-Z][A-Z0-9_]*\]")

# Pass 2 patterns: identifiers NOT in the dictionary (family members, other
# patients). Single optional spaces tolerated inside NRICs.
#
# NOT WRITTEN HERE. They are loaded from a file the browser reads too, because
# the same redaction is about to run in both places and two hand-maintained
# copies of one regex is a leak waiting for somebody to fix only one of them.
# The file lives under extension/ because a Chrome extension can read nothing
# outside its own directory, and this process can read anything.
#
# No fallback, deliberately: a backend that cannot find its patterns must not
# start. Redaction that silently degraded to "no patterns" would pass every
# test that checks the pipeline runs, and remove nothing.
PATTERN_FILE = Path(__file__).resolve().parents[1] / "extension" / "privacy" / "patterns.json"

_SPEC = json.loads(PATTERN_FILE.read_text(encoding="utf-8"))

# field -> (compiled, token base, first counter value)
PATTERN_SPEC: dict[str, tuple[re.Pattern[str], str, int]] = {
    entry["field"]: (
        re.compile(entry["regex"], re.IGNORECASE if entry["ignore_case"] else 0),
        entry["token"],
        entry["start"],
    )
    for entry in _SPEC["patterns"]
}

NRIC_PATTERN = PATTERN_SPEC["nric"][0]
SG_PHONE_PATTERN = PATTERN_SPEC["phone"][0]
EMAIL_PATTERN = PATTERN_SPEC["email"][0]

_MONTHS = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
]


# ---------------------------------------------------------------------------
# Pass 1 — known identifiers (dictionary-based)
# ---------------------------------------------------------------------------


def _flexible_exact(value: str) -> str:
    """Regex for an exact value, tolerant of whitespace runs/line breaks."""
    parts = [re.escape(p) for p in value.split()]
    return r"\b" + r"\s+".join(parts) + r"\b"


def _name_regexes(full_name: str) -> list[str]:
    """Patterns for the registered name: full name (given order and
    surname-last reversal), then individual parts. Parts shorter than 3 chars
    (e.g. surname "He") are matched case-sensitively so we don't eat pronouns;
    longer parts match case-insensitively. Word boundaries throughout —
    "angina" survives a patient surnamed "Ang"."""
    parts = full_name.split()
    patterns = [_flexible_exact(full_name)]
    if len(parts) > 1:
        reversed_name = " ".join(parts[1:] + parts[:1])  # surname-first <-> last
        patterns.append(_flexible_exact(reversed_name))
    for part in parts:
        if len(part) >= 3:
            patterns.append(r"\b" + re.escape(part) + r"\b")
        else:
            # case-sensitive branch handled by caller via (?-i) unavailable in
            # Python; we mark these with a sentinel prefix instead.
            patterns.append("(?CASE)" + r"\b" + re.escape(part) + r"\b")
    return patterns


def _dob_regexes(dob: date) -> list[str]:
    """The common renderings of a date of birth in SG clinical notes."""
    d, m, y = dob.day, dob.month, dob.year
    mon = _MONTHS[m - 1]
    variants = {
        f"{d:02d}/{m:02d}/{y}", f"{d}/{m}/{y}", f"{d:02d}/{m:02d}/{y % 100:02d}",
        f"{d:02d}-{m:02d}-{y}", f"{d}-{m}-{y}",
        f"{d:02d}.{m:02d}.{y}", f"{d}.{m}.{y}",
        f"{y}-{m:02d}-{d:02d}",
        f"{d} {mon[:3]} {y}", f"{d:02d} {mon[:3]} {y}",
        f"{d} {mon} {y}", f"{d:02d} {mon} {y}",
    }
    return [r"\b" + re.escape(v) + r"\b" for v in sorted(variants, key=len, reverse=True)]


def _nric_regex(nric: str) -> str:
    """The patient's own NRIC, tolerant of stray spaces between characters."""
    chars = [re.escape(c) for c in nric.replace(" ", "")]
    return r"\b" + r"\s?".join(chars) + r"\b"


def _phone_regex(phone: str) -> str:
    """The patient's own phone, tolerant of separators and a +65 prefix."""
    digits = re.sub(r"\D", "", phone)
    if digits.startswith("65") and len(digits) == 10:
        digits = digits[2:]
    body = r"[ -]?".join(re.escape(c) for c in digits)
    return r"(?<!\d)(?:\+65[ -]?)?" + body + r"(?!\d)"


def _apply(pattern: str, token: str, text: str, hits: set[str]) -> str:
    flags = re.IGNORECASE
    if pattern.startswith("(?CASE)"):
        pattern, flags = pattern[len("(?CASE)"):], 0
    new_text, n = re.subn(pattern, token, text, flags=flags)
    if n:
        hits.add(token)
    return new_text


def _pass1_known_identifiers(record: PatientRecord, text: str) -> tuple[str, dict[str, str]]:
    canonical_dob = f"{record.dob.day:02d}/{record.dob.month:02d}/{record.dob.year}"
    redaction_map: dict[str, str] = {
        "[PATIENT]": record.full_name,
        "[NRIC]": record.nric.replace(" ", "").upper(),
        "[DOB]": canonical_dob,
    }
    hits: set[str] = set()

    # Most-specific first, so e.g. the NRIC inside an address line is
    # tokenized before the address pattern runs.
    text = _apply(_nric_regex(record.nric), "[NRIC]", text, hits)
    if record.phone:
        redaction_map["[PHONE]"] = record.phone
        text = _apply(_phone_regex(record.phone), "[PHONE]", text, hits)
    if record.policy_number:
        redaction_map["[POLICY_NO]"] = record.policy_number
        text = _apply(_flexible_exact(record.policy_number), "[POLICY_NO]", text, hits)
    for pat in _dob_regexes(record.dob):
        text = _apply(pat, "[DOB]", text, hits)
    if record.address:
        redaction_map["[ADDRESS]"] = record.address
        text = _apply(_flexible_exact(record.address), "[ADDRESS]", text, hits)
    for pat in _name_regexes(record.full_name):
        text = _apply(pat, "[PATIENT]", text, hits)

    # Collapse runs of adjacent [PATIENT] tokens ("Tan Wei Ming" matched
    # part-by-part) into one, keeping re-merge sensible.
    text = re.sub(r"\[PATIENT\](?:\s+\[PATIENT\])+", "[PATIENT]", text)
    return text, redaction_map


# ---------------------------------------------------------------------------
# Pass 2 — pattern-based (identifiers we didn't know about)
# ---------------------------------------------------------------------------


def _pass2_patterns(text: str, redaction_map: dict[str, str]) -> str:
    # Order and numbering both come from the shared file, so the browser's
    # copy cannot drift into tokenising the same text differently.
    for pattern, base, start in PATTERN_SPEC.values():
        counter = start
        seen: dict[str, str] = {}  # verbatim value -> token, dedupe repeats

        def repl(m: re.Match) -> str:
            nonlocal counter
            value = m.group(0)
            if value not in seen:
                token = f"[{base}_{counter}]"
                counter += 1
                seen[value] = token
                redaction_map[token] = value
            return seen[value]

        text = pattern.sub(repl, text)
    return text


# ---------------------------------------------------------------------------
# Pass 3 — LLM sanity sweep (pluggable; wired up in mapping.py)
# ---------------------------------------------------------------------------

# Given already-redacted text, returns verbatim strings that are still
# identifying (names, IDs, phones, addresses). Must only ever be called with
# redacted text and must use a model endpoint approved for the deployment
# region. None = sweep skipped (tests, offline dev).
LlmSweep = Callable[[str], list[str]]


def _pass3_llm_sweep(text: str, redaction_map: dict[str, str], sweep: LlmSweep) -> str:
    counter = 1
    for finding in sweep(text):
        finding = finding.strip()
        if not finding or TOKEN_RE.fullmatch(finding):
            continue
        pattern = _flexible_exact(finding)
        if not re.search(pattern, text, re.IGNORECASE):
            continue
        token = f"[REDACTED_{counter}]"
        counter += 1
        redaction_map[token] = finding
        text = re.sub(pattern, token, text, flags=re.IGNORECASE)
    return text


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


# Institution names routinely contain what is also somebody's surname —
# "Tan Tock Seng Hospital", "Ng Teng Fong General Hospital". Pass 1 redacts
# each part of the patient's name, so a patient surnamed Tan turned that
# hospital into "[PATIENT] Tock Seng Hospital" and the form lost the hospital
# field. These spans are shielded for the duration of the passes and restored
# afterwards. A facility name is not a patient identifier.
#
# Shared with the browser for the same reason the patterns are: this rule
# prevents an over-redaction, and one fixed in Python alone would go on
# costing the form a field in the copy that runs in the doctor's tab.
_INSTITUTION_RE = re.compile(
    _SPEC["shields"][0]["regex"],
    re.IGNORECASE if _SPEC["shields"][0]["ignore_case"] else 0,
)
_SHIELD = "\x00INST{}\x00"


def _shield_institutions(text: str) -> tuple[str, list[str]]:
    spans: list[str] = []

    def take(match: re.Match[str]) -> str:
        spans.append(match.group(0))
        return _SHIELD.format(len(spans) - 1)

    return _INSTITUTION_RE.sub(take, text), spans


def _restore_institutions(text: str, spans: list[str]) -> str:
    for i, span in enumerate(spans):
        text = text.replace(_SHIELD.format(i), span)
    return text


def redact(record: PatientRecord, llm_sweep: LlmSweep | None = None) -> RedactionResult:
    """Run all redaction passes over the clinical text."""
    shielded, spans = _shield_institutions(record.clinical_text)
    text, redaction_map = _pass1_known_identifiers(record, shielded)
    text = _pass2_patterns(text, redaction_map)
    text = _restore_institutions(text, spans)
    if llm_sweep is not None:
        # After restoring, so the sweep sees real institution names and can
        # judge them — it is the pass that understands context.
        text = _pass3_llm_sweep(text, redaction_map, llm_sweep)
    return RedactionResult(redacted_text=text, redaction_map=redaction_map)


def scrub_patterns(text: str) -> str:
    """Pass 2 alone, on a string that is not clinical text and has no
    dictionary behind it.

    For structural strings that arrive from a page — a form field's label — and
    are about to be sent to a model. The extension already scrubs these with
    the same patterns before they leave the browser (`learn/dump.js`), so this
    is the second of two independent applications rather than the only one: a
    label reaches the model only if both miss it.

    The known hole is the one that shapes the whole dumper, and it is not
    closable here: **a name has no shape.** A page that renders "Claim for Tan
    Wei Ming" into a field label defeats this and every regex like it. That is
    why labels are scrubbed twice and prose is not read at all.
    """
    return _pass2_patterns(str(text or ""), {})


def remerge(text: str, redaction_map: dict[str, str]) -> tuple[str, list[str]]:
    """Substitute tokens back to real values. Returns (merged_text,
    unresolved_tokens). Any unresolved token means the field must be flagged
    for manual review — never let a raw [TOKEN] reach a filled PDF."""
    for token, value in redaction_map.items():
        text = text.replace(token, value)
    unresolved = sorted(set(TOKEN_RE.findall(text)))
    return text, unresolved
