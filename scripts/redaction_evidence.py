"""Measure redaction against a ground-truth corpus, and print the evidence.

Redaction is the load-bearing privacy control: the whole argument for sending
anything to an LLM at all is that identifiers are gone first. "The unit tests
pass" is not evidence of that. This measures two rates that pull in opposite
directions:

  LEAK RATE  — identifiers that survived. Any leak is a privacy failure.
  OVER-REDACTION — clinical content destroyed. Not a privacy problem, but it
  starves the mapping call, so a redactor that tokenises everything scores a
  perfect leak rate and is useless.

    python scripts/redaction_evidence.py            # passes 1-2, offline, free
    python scripts/redaction_evidence.py --sweep    # adds pass 3 (API calls)

Passes 1-2 are dictionary and pattern based, so they cannot catch a third
party's *name* — nothing tells them "Michelle Yeo" is a person. Those cases
are tagged sweep_only in the corpus and are expected to leak without --sweep.
That expectation is itself the finding: without the sweep, third-party names
reach the model.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

from redaction import PatientRecord, redact  # noqa: E402

CORPUS = ROOT / "tests" / "fixtures" / "redaction_corpus.json"


def load_cases() -> list[dict]:
    return json.loads(CORPUS.read_text(encoding="utf-8"))["cases"]


def build_record(spec: dict, note: str) -> PatientRecord:
    y, m, d = (int(p) for p in spec["dob"].split("-"))
    return PatientRecord(
        full_name=spec["full_name"],
        nric=spec["nric"],
        dob=date(y, m, d),
        phone=spec.get("phone"),
        address=spec.get("address"),
        policy_number=spec.get("policy_number"),
        insurer="Test",
        clinical_text=note,
    )


def run(use_sweep: bool) -> int:
    from mapping import llm_sweep

    cases = load_cases()
    leaks: list[tuple[str, str]] = []
    over: list[tuple[str, str]] = []
    expected_leaks: list[tuple[str, str]] = []

    print(f"corpus: {len(cases)} cases   sweep: {'on' if use_sweep else 'off'}\n")

    for case in cases:
        record = build_record(case["patient"], case["note"])
        result = redact(record, llm_sweep=llm_sweep if use_sweep else None)
        redacted = result.redacted_text
        lowered = redacted.lower()

        case_leaks = [s for s in case["must_not_survive"] if s.lower() in lowered]
        case_over = [s for s in case["must_survive"] if s.lower() not in lowered]

        # A sweep_only case leaking without the sweep is the documented
        # limitation of passes 1-2, not a regression.
        if case.get("sweep_only") and not use_sweep:
            expected_leaks += [(case["id"], s) for s in case_leaks]
            case_leaks = []

        leaks += [(case["id"], s) for s in case_leaks]
        over += [(case["id"], s) for s in case_over]

        mark = "FAIL" if (case_leaks or case_over) else "ok  "
        print(f"  {mark} {case['id']:32} [{case['category']}]")
        for s in case_leaks:
            print(f"         LEAK          {s!r}")
        for s in case_over:
            print(f"         OVER-REDACTED {s!r}")

    checked_ids = sum(len(c["must_not_survive"]) for c in cases)
    checked_clin = sum(len(c["must_survive"]) for c in cases)
    print(f"\n{'=' * 62}")
    print(f"identifiers checked : {checked_ids:3}   leaked        : {len(leaks)}")
    print(f"clinical strings    : {checked_clin:3}   over-redacted : {len(over)}")
    if expected_leaks:
        print(f"\nknown gap, passes 1-2 only ({len(expected_leaks)}): third-party names")
        for cid, s in expected_leaks:
            print(f"  {cid}: {s!r}")
        print("  -> these reach the model unless the LLM sweep is enabled.")

    return 1 if (leaks or over) else 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--sweep", action="store_true", help="include pass 3 (costs API calls)")
    raise SystemExit(run(ap.parse_args().sweep))
