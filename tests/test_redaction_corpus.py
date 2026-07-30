"""Gate the adversarial corpus offline, so redaction can't regress silently.

The full evidence report (including the pass-3 sweep) is
`scripts/redaction_evidence.py`. This runs the same corpus through passes 1-2
only, so it stays free and deterministic in CI.
"""

from __future__ import annotations

import json
import sys
from datetime import date
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from redaction import PatientRecord, redact  # noqa: E402

CORPUS = Path(__file__).resolve().parent / "fixtures" / "redaction_corpus.json"
CASES = json.loads(CORPUS.read_text(encoding="utf-8"))["cases"]


def _redact_case(case: dict) -> str:
    spec = case["patient"]
    y, m, d = (int(p) for p in spec["dob"].split("-"))
    record = PatientRecord(
        full_name=spec["full_name"],
        nric=spec["nric"],
        dob=date(y, m, d),
        phone=spec.get("phone"),
        address=spec.get("address"),
        policy_number=spec.get("policy_number"),
        insurer="Test",
        clinical_text=case["note"],
    )
    # llm_sweep=None: passes 1-2 only.
    return redact(record).redacted_text.lower()


@pytest.mark.parametrize("case", CASES, ids=[c["id"] for c in CASES])
def test_no_identifier_survives(case: dict):
    """Any leak is a privacy failure. Third-party *names* are the documented
    limit of dictionary+pattern matching and are tagged sweep_only — nothing in
    passes 1-2 knows that "Michelle Yeo" is a person."""
    if case.get("sweep_only"):
        pytest.skip("third-party names require the pass-3 LLM sweep")
    redacted = _redact_case(case)
    leaked = [s for s in case["must_not_survive"] if s.lower() in redacted]
    assert not leaked, f"{case['id']}: identifiers survived redaction: {leaked}"


@pytest.mark.parametrize("case", CASES, ids=[c["id"] for c in CASES])
def test_clinical_content_survives(case: dict):
    """Over-redaction starves the mapping call. A redactor that tokenises
    everything has a perfect leak rate and is useless."""
    redacted = _redact_case(case)
    destroyed = [s for s in case["must_survive"] if s.lower() not in redacted]
    assert not destroyed, f"{case['id']}: clinical content destroyed: {destroyed}"


def test_third_party_identifiers_still_caught_by_pattern_pass():
    """Even without the sweep, a third party's NRIC / phone / email must go —
    those are pattern-matchable and must not depend on an LLM call."""
    case = next(c for c in CASES if c["id"] == "third_party_nric_and_email")
    redacted = _redact_case(case)
    assert not [s for s in case["must_not_survive"] if s.lower() in redacted]
