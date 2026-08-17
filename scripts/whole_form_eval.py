"""Run thirty whole-note claims through a live backend and score the answers.

Not a test suite, and the difference matters. `tests/` is deterministic: the
LLM is stubbed, so a green run means the code did what it was told. This runs
the real mapping call, so a green run means the MODEL did what it was told on
this occasion. Two runs will not agree exactly, and a case that flips between
them is itself the finding.

What it measures is the thing the pytest suite structurally cannot: whether a
note a doctor would plausibly write produces a claim a doctor could plausibly
sign. Every case is written around one question the note answers badly, or
answers by saying there is nothing to answer, or answers somewhere other than
where the form asks.

    ./.venv/bin/python scripts/whole_form_eval.py            # all thirty
    ./.venv/bin/python scripts/whole_form_eval.py --only 4 7 # a few
    ./.venv/bin/python scripts/whole_form_eval.py --verbose  # every row

Needs a backend on :8000 with ANTHROPIC_API_KEY set, and
FORMFILL_SHOW_INTERNAL=1 for the wizard cases.

---------------------------------------------------------------------------
How a case is scored
---------------------------------------------------------------------------

`fills`   - the field must carry a value. A blank is a miss.
`blank`   - the field must NOT carry one. A value is a FAULT, and these are
            the assertions the whole exercise exists for: a blank costs the
            doctor a line of handwriting, a confident wrong answer is a
            clinical statement they sign.
`equals`  - the value must be exactly this. For option lists and date formats,
            where "close" is the same as wrong because the browser matches
            option text exactly.
`holds`   - the row must come back needing review, whatever its status.
`forbid`  - this string must appear in NO value on the form. Redaction leaks
            and other people's identifiers.
`forbid_in` - {field: [strings]}. Scoped, for when the string is legitimate
            elsewhere: "no sore throat" belongs in a findings field and must
            not be ticked in a symptom list, and a form-wide scan cannot tell
            those apart.

Every identifier below is invented. Repo fixtures are synthetic only.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

BASE = "http://localhost:8000"

# A patient record needs these four whatever the note says, so each case
# supplies them and the parse fills in the rest. That is also the real flow:
# the doctor types the name, corrects what the parse found, and maps.
CASES: list[dict] = []


def case(cid, probe, form, patient, note, **checks):
    CASES.append({"id": cid, "probe": probe, "form": form,
                  "patient": patient, "note": note, **checks})


CBH = {"full_name": "Chua Beng Huat", "nric": "S7211043C",
       "dob": "1972-11-04", "insurer": "AIA"}
LHX = {"full_name": "Lim Hui Xian", "nric": "S8012345D",
       "dob": "1978-03-14", "insurer": "AIA"}
NAR = {"full_name": "Nurul Aisyah Binte Rahman", "nric": "S8830517D",
       "dob": "1988-05-17", "insurer": "Prudential"}
GSL = {"full_name": "Goh Siew Lan", "nric": "S6123456B",
       "dob": "1961-06-21", "insurer": "Great Eastern"}
SVR = {"full_name": "Sivakumar s/o Raju", "nric": "S7511043B",
       "dob": "1975-10-11", "insurer": "Great Eastern"}

# ---------------------------------------------------------------------------
# AIA Group H&S claim — 21 questions, the form the pilot meets most
# ---------------------------------------------------------------------------

case(
    1, "the complete inpatient surgical claim: does a note that answers "
       "everything fill everything, in the format the boxes want",
    "aia_ghs_claim", CBH,
    """First seen 12/03/2026 with 2 days of periumbilical pain migrating to the
right iliac fossa. Symptoms began 10/03/2026. No prior episodes.
CT abdomen 12/03/2026: acute appendicitis, no perforation.
Admitted to Tan Tock Seng Hospital 12/03/2026, discharged 15/03/2026.
Laparoscopic appendicectomy 13/03/2026. Operation code SF849A, Medisave 4B.
MC 14 days from 13/03/2026. Care ended 20/03/2026, no onward referral.""",
    fills=["final_diagnosis", "admission_period", "hospital_name",
           "procedures", "operation_code", "operation_table"],
    equals={"first_consult_date": "12/03/26", "procedure_date": "13/03/26",
            "operation_code": "SF849A", "operation_table": "4B"},
    blank=["excision_size", "prior_treatment"],
)

case(
    2, "the one-line note: a form must not claim what the note does not say",
    "aia_ghs_claim", LHX,
    """Seen 02/08/2026. Sore throat 3 days. Dx acute pharyngitis.
Rx lozenges. MC 1 day.""",
    fills=["final_diagnosis"],
    blank=["admission_period", "hospital_name", "procedure_date",
           "operation_code", "operation_table", "excision_size",
           "similar_condition_history", "prior_treatment", "company_name",
           "doctor_name_designation", "clinic_name_address"],
)

case(
    3, "day surgery with no overnight stay: an admission PERIOD that does not "
       "exist must not be manufactured from a procedure date",
    "aia_ghs_claim", CBH,
    """Seen 04/05/2026. Sebaceous cyst right shoulder, enlarging over 3 months.
Excision under local anaesthesia 04/05/2026 in the clinic procedure room.
Lesion measured 2.5 cm. Sent for histology. Not admitted. MC 2 days.""",
    fills=["final_diagnosis", "procedures", "excision_size"],
    blank=["admission_period", "hospital_name"],
)

case(
    4, "referred to a hospital but NOT admitted: the likeliest plausible-"
       "looking wrong answer on the whole form",
    "aia_ghs_claim", CBH,
    """Seen 11/06/2026. Central chest tightness on exertion for 2 weeks.
ECG: T-wave inversion V4-V6. Dx unstable angina.
Referred urgently to the cardiology clinic at Tan Tock Seng Hospital today.
Not admitted from here; advised to attend A&E directly. No MC issued.""",
    fills=["final_diagnosis"],
    blank=["admission_period", "hospital_name", "procedure_date",
           "operation_code"],
)

case(
    5, "a genuine history of the same condition: the field that case 2 must "
       "leave blank is the one this must fill",
    "aia_ghs_claim", CBH,
    """Seen 09/07/2026 with recurrent right renal colic. Dx ureteric calculus.
Had the same condition in March 2023, passed a stone spontaneously after
conservative management at this clinic. CT KUB 09/07/2026: 6mm distal stone.
Admitted Tan Tock Seng Hospital 09/07/2026, ureteroscopy 10/07/2026,
discharged 11/07/2026.""",
    fills=["similar_condition_history", "final_diagnosis", "admission_period"],
)

case(
    6, "another doctor treated it first: prior_treatment wants a name, a date "
       "and a clinic, and the note gives all three",
    "aia_ghs_claim", CBH,
    """Seen 18/04/2026. Persistent cough 6 weeks.
Previously treated by Dr Lee Kok Wah at Bishan Medical Centre, first
consultation 02/04/2026, given a course of antibiotics without response.
CXR 18/04/2026: right middle lobe infiltrate. Dx atypical pneumonia.
Rx clarithromycin 500mg BD 10 days. MC 5 days.""",
    fills=["prior_treatment", "final_diagnosis"],
    blank=["operation_code", "excision_size"],
)

case(
    7, "two conditions, one claim: the principal diagnosis is the one that "
       "caused the admission, not the one mentioned first",
    "aia_ghs_claim", CBH,
    """Known type 2 diabetes on metformin, and hypertension on amlodipine.
Presented 22/05/2026 with 3 days of fever and dysuria. Urine culture E. coli.
Dx acute pyelonephritis. Admitted Tan Tock Seng Hospital 22/05/2026 for IV
antibiotics, discharged 26/05/2026. Diabetes stable throughout.""",
    fills=["final_diagnosis", "admission_period"],
    forbid=["diabetes mellitus is the final diagnosis"],
)

case(
    8, "the note already writes dates as DD/MM/YY: the century must not be "
       "invented back in",
    "aia_ghs_claim", CBH,
    """First consulted me 07/02/26 for progressive left knee pain.
MRI 09/02/26: medial meniscal tear. Arthroscopic partial meniscectomy 14/02/26
at Tan Tock Seng Hospital, admitted 14/02/26, discharged 15/02/26.""",
    equals={"first_consult_date": "07/02/26", "procedure_date": "14/02/26"},
)

# ---------------------------------------------------------------------------
# Great Eastern Group H&S claim — 13 questions
# ---------------------------------------------------------------------------

case(
    9, "surgery with codes: GE asks for operation codes and Medisave tables "
       "as separate fields from the operation itself",
    "ge_ghs_claim", GSL,
    """Seen 03/03/2026. Symptomatic gallstones, RUQ pain after meals for 3 months.
US abdomen 03/03/2026: multiple gallstones, no duct dilatation.
Laparoscopic cholecystectomy 10/03/2026 at Ng Teng Fong General Hospital.
Operation code SF801C, Medisave table 5A. MC 10 days (10/03/26 to 19/03/26).""",
    fills=["operation_type", "operation_codes", "operation_tables",
           "hospital_name", "medical_leave"],
    equals={"operation_date": "10/03/2026"},
)

case(
    10, "no surgery at all: every operation field must stay empty while the "
        "treatment field fills",
    "ge_ghs_claim", GSL,
    """Seen 12/04/2026. Acute gastroenteritis after a meal out, 2 days of
vomiting and loose stools. Mildly dehydrated. IV hydration in clinic, oral
rehydration salts, hyoscine PRN. Reviewed 14/04/2026, improving. MC 3 days.""",
    fills=["treatment_no_surgery", "diagnosis_and_symptoms"],
    blank=["operation_date", "operation_type", "operation_codes",
           "operation_tables", "hospital_name"],
)

case(
    11, "medical leave stated as a period: the field wants the days AND the "
        "dates, not one or the other",
    "ge_ghs_claim", GSL,
    """Seen 05/06/2026. Right ankle sprain, inversion injury while walking.
X-ray no fracture. Tubigrip, analgesia, advised RICE.
MC 4 days from 05/06/2026 to 08/06/2026.""",
    fills=["medical_leave", "diagnosis_and_symptoms"],
    blank=["operation_date", "previous_doctor"],
)

case(
    12, "the note says no MC was issued: reporting an absence is not the "
        "same as reporting a value",
    "ge_ghs_claim", GSL,
    """Seen 19/06/2026 for review of stable hypothyroidism.
TSH 2.1, within range. Continue levothyroxine 75mcg OM.
No medical leave issued. Review in 6 months.""",
    blank=["medical_leave", "operation_date", "operation_type", "hospital_name"],
)

case(
    13, "an onset with no date: 'since childhood' is an answer, and inventing "
        "a date for it is not",
    "ge_ghs_claim", GSL,
    """Seen 24/06/2026. Lifelong eczema, worse since childhood, flaring for the
past fortnight over both antecubital fossae. Dx atopic dermatitis, flare.
Rx betamethasone valerate 0.1% BD 2 weeks, emollient regularly.""",
    fills=["onset_and_duration", "diagnosis_and_symptoms"],
    forbid=["since 2020", "since 2019"],
)

case(
    14, "a referral in and a treatment history: two fields that only differ "
        "by whose treatment is being described",
    "ge_ghs_claim", GSL,
    """Referred by Dr Lee Kok Wah of Bishan Medical Centre, 5 Bishan Street 12,
Singapore 570501, seen there on 01/07/2026 and 08/07/2026 for the same
complaint. Seen by me 15/07/2026. Dx lumbar disc prolapse L4/L5.
MRI 15/07/2026 confirms. Conservative management, physiotherapy referral.""",
    fills=["previous_doctor", "previous_treatment_dates",
           "diagnosis_and_symptoms"],
    blank=["operation_date", "operation_type"],
)

# ---------------------------------------------------------------------------
# Prudential medical report — 26 questions, accident and illness in one form
# ---------------------------------------------------------------------------

case(
    15, "an accident: the two report-type checkboxes are mutually exclusive "
        "and both being ticked is a contradiction nobody would catch",
    "prudential_medical_report", NAR,
    """Accident at work 03/07/2026 at about 1430h: slipped on a wet loading bay
floor and landed on the left wrist. First consulted me 06/07/2026.
Dx closed fracture of the left distal radius, ICD-10-AM S52.501A.
Manipulation under anaesthesia and cast 06/07/2026 at Mount Alvernia Hospital,
admitted 06/07/2026, discharged 07/07/2026.
MC from 06/07/2026 to 03/08/2026. Not yet fully recovered.""",
    fills=["how_accident_happened", "injury_details", "diagnosis"],
    equals={"relates_to_accident": True, "relates_to_illness": False,
            "mc_from": "06/07/2026", "mc_to": "03/08/2026",
            "admission_date": "06/07/2026", "discharge_date": "07/07/2026"},
)

case(
    16, "an illness, on the same form: the inverse of case 15",
    "prudential_medical_report", NAR,
    """Seen 14/05/2026 with 3 weeks of increasing breathlessness and ankle
swelling. No injury, no fall, no accident of any kind.
Echocardiogram 16/05/2026: ejection fraction 35%. Dx dilated cardiomyopathy.
Started on bisoprolol and ramipril. Referred to cardiology.""",
    equals={"relates_to_illness": True, "relates_to_accident": False},
    blank=["admission_date", "discharge_date"],
)

case(
    17, "the note rules out alcohol and self-harm: a stated NO must not "
        "become a filled field",
    "prudential_medical_report", NAR,
    """Accident 21/08/2026: fell from a step ladder while changing a light bulb
at home. No alcohol involved, no drugs. Not self-inflicted.
Dx closed fracture of the right fifth metatarsal. Walking boot, analgesia.
First consulted me 21/08/2026. MC from 21/08/2026 to 04/09/2026.""",
    fills=["how_accident_happened", "self_inflicted"],
    blank=["contributing_illness"],
    forbid=["ladder-related alcohol"],
)

case(
    18, "a pre-existing illness that genuinely prolongs recovery: the field "
        "case 17 must leave blank is the one this must fill",
    "prudential_medical_report", NAR,
    """Accident 02/09/2026: tripped on a kerb, landed on the right shoulder.
Dx right proximal humerus fracture, undisplaced.
Known poorly controlled type 2 diabetes, HbA1c 9.4, which will slow bone
healing and prolong the period of disability. Usual recovery would be about
8 weeks; expect 12 to 14 weeks in her case.
MC from 02/09/2026 to 30/09/2026, to be extended.""",
    fills=["contributing_illness", "how_accident_happened", "injury_details"],
)

case(
    19, "a full recovery with a return-to-work date: three fields that a "
        "model tends to answer as one sentence",
    "prudential_medical_report", NAR,
    """Accident 04/02/2026: minor road traffic accident, whiplash injury.
Dx cervical strain. Physiotherapy for 4 weeks.
Reviewed 09/03/2026: fully recovered, no residual restriction.
Returned to work 10/03/2026. MC from 04/02/2026 to 09/03/2026.""",
    fills=["fully_recovered", "return_to_work_date"],
    equals={"mc_from": "04/02/2026", "mc_to": "09/03/2026"},
)

case(
    20, "no hospital admission on an accident claim: admission and discharge "
        "must not borrow the accident date",
    "prudential_medical_report", NAR,
    """Accident 11/10/2026 at home: scalded the left forearm with hot water.
Superficial partial thickness burn, about 3% total body surface area.
Dressed in clinic, reviewed every 2 days. Not admitted at any point.
MC from 11/10/2026 to 18/10/2026.""",
    fills=["injury_details", "treatment_performed"],
    blank=["admission_date", "discharge_date"],
)

# ---------------------------------------------------------------------------
# The wizard fixture — the only schema with option lists
# ---------------------------------------------------------------------------

case(
    21, "an option written the form's way: the easy one, and the baseline for "
        "the three that follow",
    "wizard_test_v1", GSL,
    """Consultation 09/08/2026. First consulted me for this on 02/08/2026.
Fever and cough 4 days. CXR right lower lobe consolidation.
Dx community-acquired pneumonia. Admitted through the emergency department to
Ng Teng Fong General Hospital on 09/08/2026, B1 (4-bedded, air-conditioned).
Discharged 13/08/2026. Referred to the respiratory clinic. MC 7 days.""",
    equals={"ward_class": "B1 (4-bedded, air-conditioned)",
            "emergency_admission": "Yes", "referred": "Yes",
            "diagnosis_category": "Respiratory", "mc_days": "7"},
)

case(
    22, "the same ward in the doctor's words: 'B1 ward, 4-bedded' has to "
        "become the form's own string or the browser will not accept it",
    "wizard_test_v1", GSL,
    """Consultation 09/08/2026, first consulted 09/08/2026.
Dx community-acquired pneumonia. Admitted the same day to Ng Teng Fong General
Hospital, B1 ward, 4-bedded, air-conditioned. Discharged 13/08/2026.
Not an emergency admission — arranged directly from clinic. No referral.
MC 5 days.""",
    equals={"ward_class": "B1 (4-bedded, air-conditioned)",
            "emergency_admission": "No", "referred": "No"},
)

case(
    23, "a ward the form does not offer: an off-list answer is missing, never "
        "the nearest option",
    "wizard_test_v1", GSL,
    """Consultation 09/08/2026, first consulted 09/08/2026.
Dx community-acquired pneumonia. Admitted 09/08/2026 to Mount Alvernia
Hospital in a private two-bedded room. Discharged 12/08/2026.
Emergency admission via A&E. MC 5 days.""",
    blank=["ward_class"],
    equals={"emergency_admission": "Yes"},
)

case(
    24, "symptoms recorded as ABSENT: a checkbox list is where a model reads "
        "the words rather than the sentence",
    "wizard_test_v1", GSL,
    """Consultation 15/08/2026, first consulted 15/08/2026.
Fever and cough for 3 days. Explicitly no sore throat, no chest pain and no
breathlessness. Also complains of headache.
Dx influenza-like illness. Rx paracetamol. No admission. MC 2 days.""",
    fills=["symptoms"],
    blank=["ward_class", "admission_date", "discharge_date"],
    # Scoped to the symptom list. The same words belong in the findings field,
    # where "explicitly no sore throat" is the correct clinical record.
    forbid_in={"symptoms": ["Sore throat", "Chest pain", "Breathlessness",
                            "None of the above"]},
)

case(
    25, "none of the listed symptoms: the list has an option for exactly this "
        "and it must be used rather than left blank",
    "wizard_test_v1", GSL,
    """Consultation 18/08/2026, first consulted 18/08/2026.
Presented with painless macroscopic haematuria for 2 days. No fever, no cough,
no sore throat, no chest pain, no breathlessness.
Dx haematuria for investigation. Referred to urology. No MC.""",
    equals={"symptoms": "None of the above", "referred": "Yes"},
    blank=["ward_class", "admission_date"],
)

case(
    26, "an outpatient consultation on a form that asks about admission: the "
        "three admission fields must all stay empty together",
    "wizard_test_v1", GSL,
    """Consultation 20/08/2026, first consulted for this 06/08/2026.
Follow-up of eczema. Improving on topical steroid. Continue emollient.
Seen and discharged from clinic the same morning. No MC.""",
    blank=["ward_class", "admission_date", "discharge_date", "institution",
           "emergency_admission"],
)

# ---------------------------------------------------------------------------
# Henner prior agreement — a form about a FUTURE admission
# ---------------------------------------------------------------------------

case(
    27, "a planned admission with estimated costs: the only form here that "
        "asks what WILL happen rather than what did",
    "henner_prior_agreement", CBH,
    """Planning elective right inguinal hernia repair.
Proposed admission to Mount Elizabeth Hospital, 3 Mount Elizabeth,
Singapore 228510, on 12/09/2026 for 2 days.
Open mesh repair under general anaesthesia. Pre-operative bloods and ECG.
Estimated hospital charges SGD 8,500. Estimated surgeon and anaesthetist fees
SGD 4,200. Other expenses SGD 600. Not an extension of an existing stay.""",
    fills=["place_of_hospitalisation", "operation_and_treatment",
           "hospital_charges", "physicians_fees", "other_expenses",
           "number_of_days"],
    equals={"date_of_admission": "12/09/2026"},
)

case(
    28, "the same form with no costs quoted: three money fields that must "
        "stay empty rather than be estimated",
    "henner_prior_agreement", CBH,
    """Planning elective right inguinal hernia repair at Mount Elizabeth
Hospital on 12/09/2026, expected stay 2 days. Open mesh repair under general
anaesthesia. Costs not yet quoted by the hospital.""",
    fills=["place_of_hospitalisation", "operation_and_treatment"],
    blank=["hospital_charges", "physicians_fees", "other_expenses"],
)

# ---------------------------------------------------------------------------
# Redaction, seen from the far end
# ---------------------------------------------------------------------------

case(
    29, "the patient's surname is also the hospital's: no token may survive "
        "into a value, and the hospital must keep its name",
    "aia_ghs_claim", CBH,
    """Chua Beng Huat seen 12/03/2026. Admitted to Tan Tock Seng Hospital
12/03/2026 under Dr Ong. Appendicectomy 13/03/2026. Discharged 15/03/2026.
Patient Chua was counselled about wound care before discharge.""",
    fills=["hospital_name"],
    forbid=["[PATIENT]", "[NRIC]", "[DOB]", "[PHONE]", "[REDACTED"],
)

case(
    30, "somebody else's identifiers in the note: they are tokenised on the "
        "way in and must not come back out in any field",
    "aia_ghs_claim", CBH,
    """Seen 14/03/2026 with his wife S7605533F, who is his caregiver and can be
reached on 91112233. Her email is wife@example.com.
Dx acute cholecystitis. Admitted Tan Tock Seng Hospital 14/03/2026,
laparoscopic cholecystectomy 15/03/2026, discharged 17/03/2026.""",
    fills=["final_diagnosis", "admission_period"],
    forbid=["S7605533F", "91112233", "wife@example.com", "[NRIC_", "[PHONE_",
            "[EMAIL_"],
)


# ---------------------------------------------------------------------------
# Running one
# ---------------------------------------------------------------------------


def post(path: str, body: dict, timeout: int = 240) -> dict:
    request = urllib.request.Request(
        f"{BASE}{path}",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read())


def run_case(spec: dict) -> dict:
    """Parse, map, score. The parse is real rather than skipped: a demographic
    the parse missed is a demographic the mapping call is missing too."""
    result = {"id": spec["id"], "probe": spec["probe"], "faults": [],
              "misses": [], "notes": []}
    try:
        parsed = post("/parse", {"text": spec["note"],
                                 "full_name": spec["patient"]["full_name"]})
    except (urllib.error.URLError, OSError) as exc:
        result["faults"].append(f"parse failed: {type(exc).__name__}")
        return result

    patient = {k: v for k, v in parsed.items()
               if k not in ("sources", "choices") and v}
    patient.update(spec["patient"])          # the doctor's corrections win
    patient["clinical_text"] = spec["note"]

    try:
        mapped = post("/map", {"form_id": spec["form"], "patient": patient})
    except urllib.error.HTTPError as exc:
        result["faults"].append(f"map HTTP {exc.code}: {exc.read()[:120]!r}")
        return result
    except (urllib.error.URLError, OSError) as exc:
        result["faults"].append(f"map failed: {type(exc).__name__}")
        return result

    rows = {r["field_id"]: r for r in mapped["fields"]}
    result["rows"] = rows

    def value_of(field):
        row = rows.get(field)
        return None if row is None else row["value"]

    for field in spec.get("fills", []):
        if field not in rows:
            result["faults"].append(f"{field}: not a field on this form")
        elif value_of(field) in (None, "", False):
            result["misses"].append(f"{field}: blank, expected a value")

    for field in spec.get("blank", []):
        if field not in rows:
            result["faults"].append(f"{field}: not a field on this form")
        elif value_of(field) not in (None, "", False):
            result["faults"].append(
                f"{field}: {value_of(field)!r} — must be blank")

    for field, expected in spec.get("equals", {}).items():
        if field not in rows:
            result["faults"].append(f"{field}: not a field on this form")
            continue
        got = value_of(field)
        if got != expected:
            bucket = "misses" if got in (None, "", False) else "faults"
            result[bucket].append(f"{field}: {got!r}, wanted {expected!r}")

    for field in spec.get("holds", []):
        if field in rows and not rows[field]["needs_review"]:
            result["faults"].append(f"{field}: not held for review")

    haystack = " ".join(str(r["value"]) for r in mapped["fields"] if r["value"])
    for banned in spec.get("forbid", []):
        if banned.lower() in haystack.lower():
            result["faults"].append(f"leaked {banned!r} into a value")

    for field, banned_list in spec.get("forbid_in", {}).items():
        got = str(value_of(field) or "")
        for banned in banned_list:
            if banned.lower() in got.lower():
                result["faults"].append(f"{field}: contains {banned!r}")

    filled = sum(1 for r in mapped["fields"]
                 if r["value"] not in (None, "", False))
    result["filled"] = filled
    result["total"] = len(mapped["fields"])
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", nargs="*", type=int)
    parser.add_argument("--verbose", action="store_true")
    parser.add_argument("--workers", type=int, default=5)
    args = parser.parse_args()

    todo = [c for c in CASES if not args.only or c["id"] in args.only]
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        results = list(pool.map(run_case, todo))

    clean = 0
    for r in sorted(results, key=lambda r: r["id"]):
        state = "FAULT" if r["faults"] else ("miss " if r["misses"] else "ok   ")
        if not r["faults"] and not r["misses"]:
            clean += 1
        counts = f"{r.get('filled', 0)}/{r.get('total', 0)}"
        print(f"{state} {r['id']:>2}  {counts:>7}  {r['probe'][:64]}")
        for fault in r["faults"]:
            print(f"          FAULT  {fault}")
        for miss in r["misses"]:
            print(f"          miss   {miss}")
        if args.verbose and r.get("rows"):
            for fid, row in r["rows"].items():
                if row["value"] not in (None, "", False):
                    print(f"                 {row['status'][:4]} {fid:26} "
                          f"{str(row['value'])[:56]!r}")

    faults = sum(len(r["faults"]) for r in results)
    print(f"\n{clean}/{len(results)} clean, {faults} faults, "
          f"{sum(len(r['misses']) for r in results)} misses")
    return 1 if faults else 0


if __name__ == "__main__":
    sys.exit(main())
