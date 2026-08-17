# Five notes for testing the whole form

`patient_details_cases.md` tests the first step — one pasted block into the
demographic fields, patterns only, no model. These five go further: each one is
written to fill a real insurer form end to end, so they exercise the mapping
call, the statuses, the option lists, the date formats and the review gate as
well as the parse.

Every identifier, name, clinic, employer and policy number below is invented.
Repo fixtures are synthetic only, and there is a hard rule against real patient
notes until inference runs in-region.

---

## How to run one

```bash
# the backend, with a key, from the repo root
export ANTHROPIC_API_KEY=...        # never via Claude Code's ! prefix: it is logged
export FORMFILL_SHOW_INTERNAL=1     # only needed for note 4's wizard schema
./.venv/bin/python -m uvicorn main:app --app-dir backend --port 8000
```

Load the extension, open the insurer's form (or any page for a dry run), click
the BreezeFill icon **on that tab**, and point Advanced → Backend URL at
`http://localhost:8000`. Type the patient's name, paste the note, Map.

The demographic tables below were run against `parse_demographics` on
2026-08-16 and are what actually came back. The mapping expectations are what
to **check** — they need a model call, so they are a checklist rather than a
transcript.

**What to look at, in order.** Not the fill rate. A field that came back
`missing` costs the doctor a line of handwriting; a field that came back
confidently wrong is a clinical statement they are about to sign. So read the
"must not" rows first — every one of them is a value that would look perfectly
reasonable in review.

---

## 1 — The complete inpatient surgical claim

**Form:** `aia_ghs_claim`. **Probes:** the happy path, and whether a note that
answers nearly everything actually fills nearly everything. Also the two
mechanical traps on this form — a `DD/MM/YY` field, and a hospital whose name
contains the patient's surname.

```
Chua Beng Huat · S7211043C · 04/11/1972 · 91112233 ·
18 Toa Payoh Lorong 4, Singapore 310018 · Policy GHS-4471902
Insurance: AIA Singapore
Employer: Sunrise Logistics Pte Ltd

First seen 12/03/2026 with 2 days of periumbilical pain migrating to the right
iliac fossa, anorexia and one episode of vomiting. Symptoms began 10/03/2026.
No prior episodes of the same complaint.

O/E T 38.1, tender RIF with rebound, Alvarado 8. CT abdomen 12/03/2026 showed
acute appendicitis with no perforation.

Admitted to Tan Tock Seng Hospital 12/03/2026, discharged 15/03/2026.
Laparoscopic appendicectomy 13/03/2026 by Dr Ong Wei Sheng. Operation code
SF849A, Medisave table 4B. Recovery uneventful, no complications.

MC 14 days from 13/03/2026 to 26/03/2026. Reviewed 20/03/2026, wound clean.
Care ended 20/03/2026, no onward referral.

Dr Tan Mei Ling, MCR M08842B, Family Physician.
Braddell Family Clinic, 22 Braddell Road, Singapore 359915. Tel 62551234.
```

| Demographic | Parsed | Source |
|---|---|---|
| full_name | Chua Beng Huat | header-line |
| nric | S7211043C | header-line |
| dob | 1972-11-04 | header-line |
| phone | 91112233 | header-line |
| address | 18 Toa Payoh Lorong 4, Singapore 310018 | header-line |
| policy_number | GHS-4471902 | header-line |
| insurer | AIA | labelled |

The clinic's own `62551234` and `22 Braddell Road` are not taken: the header
answered both fields first, and the footer's are disqualified by the word
"Clinic" in front of them either way.

**Should fill, `extracted`:** `final_diagnosis` (acute appendicitis),
`admission_period` (12/03/26 to 15/03/26), `hospital_name` (Tan Tock Seng
Hospital), `procedure_date` (13/03/26), `procedures` (laparoscopic
appendicectomy), `operation_code` (SF849A), `operation_table` (4B),
`first_consult_date` (12/03/26), `prior_symptoms`, `duration_before_consult`
(2 days), `company_name` (Sunrise Logistics Pte Ltd), `followup_status`,
`doctor_name_designation`, `clinic_name_address`.

**May be `inferred`:** `icd_code` — K35.80 for acute appendicitis is the kind
of code a clinician reaches without hesitating, which is exactly what
`inferred` is for. It needs a confirm click; that is the design, not a defect.

**Must be `missing`:** `similar_condition_history` ("no prior episodes" is a
statement that there is nothing to report, not a history), `prior_treatment`,
`excision_size` (no excision was performed).

**Two things to look at specifically:**

- **`first_consult_date` and `procedure_date` must read `12/03/26` and
  `13/03/26`**, not `2026`. Both descriptions ask for `DD/MM/YY` because the
  boxes on the printed form are two digits wide. A live run once produced two
  fields in each format on one claim, which is why `_apply_date_format`
  enforces it rather than trusting the prompt.
- **`hospital_name` must read "Tan Tock Seng Hospital" in full.** The patient's
  surname is Tan, and pass 1 of redaction removes each part of the name — so
  without the institution shield the model would be reading
  "[PATIENT] Tock Seng Hospital" and the field would come back wrong or blank.

---

## 2 — The one-line outpatient note

**Form:** `aia_ghs_claim`, the same 21 fields. **Probes:** the core bet. A note
that says almost nothing must produce a form that claims almost nothing.

```
Lim Hui Xian
NRIC S8012345D  DOB 14/03/1978
Policy GHS-88213004 (AIA Singapore)

Seen 02/08/2026. Sore throat 3 days. Dx acute pharyngitis. Rx lozenges. MC 1 day.
```

| Demographic | Parsed | Source |
|---|---|---|
| nric | S8012345D | header-line |
| dob | 1978-03-14 | header-line |
| policy_number | GHS-88213004 | header-line |
| insurer | AIA | header-line |
| full_name | *blank* | — see below |
| phone, address | *blank* | — the note has neither |

`full_name` is blank because the name sits alone on a line with nothing else on
it, and the line under it carries labels rather than bare values, so neither
the line rule nor the block rule fires. It costs nothing in the panel, which
asked for the name at step 1 before this box existed — but it is a real gap in
`POST /parse` used directly.

**Should fill:** `final_diagnosis` (acute pharyngitis), `first_consult_date`
(02/08/26), `prior_symptoms` (sore throat, 3 days), `duration_before_consult`
(3 days), `procedures` or `treatment_rendered` (lozenges).

**Must be `missing` — this is the whole test.** `admission_period`,
`hospital_name`, `procedure_date`, `operation_code`, `operation_table`,
`excision_size`, `cause_of_illness`, `similar_condition_history`,
`prior_treatment`, `company_name`, `doctor_name_designation`,
`clinic_name_address`, `followup_status`.

**If any of those carries a value, that is the bug worth finding.** There was
no admission, no surgery and no named doctor in this note, so a filled hospital
name or operation code is not a stretch of the evidence — it is invention, and
it arrives with a green pill and a quote that will not support it.

---

## 3 — The workplace accident

**Form:** `prudential_medical_report` (overlay, 26 fields). **Probes:** the
accident half of a report form, where the fields come in mutually exclusive
pairs and several ask a yes/no question that the notes answer in prose.

```
Nurul Aisyah Binte Rahman  S8830517D  17/05/1988  98765432
5 Tampines Street 21, Singapore 529391
Insurer: Prudential   Policy PRU-99120034
Occupation: warehouse supervisor, Sunrise Logistics Pte Ltd

Accident at work 03/07/2026 at about 1430h: slipped on a wet loading bay floor
and landed on the left wrist. Brought to A&E the same day. No alcohol involved.

First consulted me 06/07/2026. Dx closed fracture of the left distal radius,
ICD-10-AM S52.501A. X-ray left wrist 03/07/2026 confirmed the fracture.
Injuries are consistent with the mechanism described and caused solely by it.
Not self-inflicted.

Manipulation under anaesthesia and cast applied 06/07/2026 at Mount Alvernia
Hospital, admitted 06/07/2026, discharged 07/07/2026.

MC from 06/07/2026 to 03/08/2026. Unable to lift or carry, so unable to perform
her occupation for that period. Not yet fully recovered; expected return to
work 04/08/2026. No pre-existing illness contributing to the disability.

Dr Tan Mei Ling, MCR M08842B, Family Medicine.
Braddell Family Clinic, 22 Braddell Road, Singapore 359915. Tel 62551234.
```

| Demographic | Parsed | Source |
|---|---|---|
| full_name | Nurul Aisyah Binte Rahman | header-line |
| nric | S8830517D | header-line |
| dob | 1988-05-17 | header-line |
| phone | 98765432 | header-line |
| address | 5 Tampines Street 21, Singapore 529391 | sole-match |
| policy_number | PRU-99120034 | header-line |
| insurer | Prudential | labelled |

**Should fill:** `relates_to_accident` **true** and `relates_to_illness`
**false** — the pair is the point, and both being ticked is a contradiction a
reader would not catch. `accident_or_consult_date` (03/07/2026),
`how_accident_happened`, `injury_details`, `diagnosis` (with S52.501A),
`injury_consistent` (Yes), `caused_solely_by_accident` (Yes), `self_inflicted`
(No), `admission_date` (06/07/2026), `discharge_date` (07/07/2026),
`treatment_performed`, `treatment_dates`, `mc_from` (06/07/2026), `mc_to`
(03/08/2026), `prevents_occupation` (Yes, with the lifting restriction),
`fully_recovered` (No), `return_to_work_date` (04/08/2026),
`occupation_employer`, `specialist_name`, `mcr_no` (M08842B),
`field_of_specialty` (Family Medicine), `medical_institution`.

**Must be `missing`:** `contributing_illness`. The note says there is none, and
a field that reports the absence of something is not the same as a field that
reports something.

**Watch the dates.** `03/07/2026` is 3 July here and 7 March to a CMS exporting
US-format dates, so **every row carrying it should arrive held for review**
with the "check the day and month are the right way round" note, whatever
status it has. `06/07/2026` and its neighbours are held for the same reason.
`17/05/1988` is not, because there is no 17th month. If the accident date
arrives green and unheld, the recheck rule has been lost.

**One distractor.** "No alcohol involved" must not populate `substance_type` on
the AIA medical report, nor lead `self_inflicted` anywhere except No.

---

## 4 — The one with dropdowns

**Form:** `wizard_test_v1` — needs `FORMFILL_SHOW_INTERNAL=1`. **Probes:**
`options`. Five of its fields accept only listed answers, and an answer off the
list is downgraded to `missing` rather than written, so this is the note that
says whether that rule helps or just blanks things.

```
Patient: Goh Siew Lan, S6123456B, 21/06/1961, 91234567
Blk 210 Ang Mo Kio Ave 3 #05-11, Singapore 560210
Great Eastern   Policy GE-88213004

Consultation 09/08/2026. First consulted me for this condition 02/08/2026.

Presented with fever and cough for 4 days, no sore throat, no chest pain, and
a headache she attributes to the fever. O/E T 38.6, crackles right base.
CXR 09/08/2026 right lower lobe consolidation. Dx community-acquired pneumonia.

Given the hypoxia she was admitted the same day through the emergency
department to Ng Teng Fong General Hospital, B1 ward, 4-bedded.
Discharged 13/08/2026.

IV ceftriaxone 1g OD for 4 days, then oral amoxicillin-clavulanate 625mg TDS
for 5 days. Referred to the respiratory clinic for follow-up.

MC 7 days.
```

| Demographic | Parsed | Source |
|---|---|---|
| full_name | Goh Siew Lan | patient-line |
| nric | S6123456B | patient-line |
| dob | 1961-06-21 | patient-line |
| phone | 91234567 | patient-line |
| address | Blk 210 Ang Mo Kio Ave 3 #05-11, Singapore 560210 | sole-match |
| policy_number | GE-88213004 | header-line |
| insurer | Great Eastern | header-line |

**The five option fields, and what each is really asking:**

| Field | Expected | Why it is a test |
|---|---|---|
| `ward_class` | `B1 (4-bedded, air-conditioned)` | The note says "B1 ward, 4-bedded". The answer must be the form's **exact** string — a near-miss like "Ward B1" is `missing`, because the browser matches option text exactly and a value the control will not accept is worse than a blank the doctor sees |
| `symptoms` | Fever and Cough only | Sore throat and chest pain are recorded as **absent**, and a model reading a symptom list rather than the sentence will tick them. The headache is real but not on the list — it must not force "None of the above", and it must not be squeezed into a neighbouring option |
| `emergency_admission` | `Yes` | Stated as "through the emergency department" rather than in the form's words |
| `referred` | `Yes` | Ditto — "referred to the respiratory clinic" |
| `diagnosis_category` | `Respiratory` | Requires reading the diagnosis, not matching a word: pneumonia is never called "respiratory" in the note |

**Also check:** `consult_date` (09/08/2026) and `first_consult_date`
(02/08/2026) must not be the same value. The two are one week apart on purpose
— a schema's `description` exists precisely to draw this distinction, and it is
the field a page's own label ("Date of consultation") cannot draw by itself.
`mc_days` should be `7`, a plain number. `admission_date` 09/08/2026,
`discharge_date` 13/08/2026, `institution` the hospital's full name.

---

## 5 — The one where most answers are "no"

**Form:** `ge_ghs_claim` (13 fields). **Probes:** refusals, on both sides of
the pipeline at once — a note carrying two other people's identifiers, a
previous doctor who *should* be reported, and several fields the note answers
by saying there is nothing to answer.

```
Patient: Sivakumar s/o Raju
IC S7511043B, born 11 October 1975
Contact 81234567. Wife S7605533F, contactable at 91112233.
Insurance: Great Eastern

Seen 03/07/2026. Known hypertension since 2019, on amlodipine 5mg OM.
Presented with central chest tightness on exertion for 2 weeks — first noticed
around 20/06/2026. Previously seen for the same complaint by Dr Lee Kok Wah at
Bishan Medical Centre on 25/06/2026, treated as reflux.

ECG today: T-wave inversion in V4-V6. Troponin pending. Dx unstable angina.
Referred urgently to the cardiology clinic at Tan Tock Seng Hospital today.
No admission from this clinic; the patient was told to attend A&E directly.

No MC issued. Plan: review after cardiology assessment.

Clinic tel 62551234.
```

| Demographic | Parsed | Source |
|---|---|---|
| full_name | Sivakumar s/o Raju | labelled |
| nric | S7511043B | labelled-inline |
| dob | 1975-10-11 | labelled-inline |
| phone | 81234567 | sole-match |
| insurer | Great Eastern | labelled |
| address, policy_number | *blank* | — the note has neither |

**Three identifiers, one patient.** The wife's `S7605533F` and `91112233` and
the clinic's `62551234` are all disqualified by the word in front of them, so
`81234567` is the only candidate left and is taken. Check the details drawer:
if the phone box holds `91112233` or `62551234`, the ownership rule has been
lost, and the value is wrong in a way nothing downstream can catch.

**Should fill:** `diagnosis_and_symptoms` (unstable angina, chest tightness on
exertion), `diagnosis_code` (I20.0, inferred), `onset_and_duration` (2 weeks,
first noticed 20/06/2026), `previous_doctor` (Dr Lee Kok Wah, Bishan Medical
Centre), `previous_treatment_dates` (25/06/2026), `treatment_no_surgery`.

**Must be `missing`:** `operation_date`, `operation_type`, `operation_codes`,
`operation_tables` (no surgery), `hospital_name` (**the patient was not
admitted** — Tan Tock Seng is where they were referred, and a hospital name
written into an admission field is the most plausible-looking wrong answer in
these five), `medical_leave` (the note says none was issued).

**Two traps in the prose:**

- **"Plan: review after cardiology assessment"** is a clinical plan, not an
  insurance plan. `policy_number` must stay blank — "plan" is deliberately
  absent from the label table for exactly this line.
- **"Known hypertension since 2019"** is a pre-existing condition, and it is
  relevant, but it is not the condition being claimed for. It belongs in a
  history field if the form has one; it must not become
  `diagnosis_and_symptoms`.

---

## What these five do not cover

Worth knowing before treating a clean run as a pass.

- **No form in the bank describes the real ClaimEZ page**, so none of this
  tests the enrichment path against the form the pilot actually receives.
- **`wizard_test_v1` is a fixture**, so note 4 tests the option mechanism
  rather than any insurer's real dropdown wording.
- **Nothing here exercises a schema-free page.** Every note is written against
  a schema that exists; a page nothing describes answers its questions from
  its own labels, which is a weaker path and is not measured here.
- **The overlay forms return a PDF**, so note 3's real output is a file to open
  and read, not a screen — check the boxes land under the right headings, which
  a report cannot tell you.
