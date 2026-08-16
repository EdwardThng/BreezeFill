# Patient details — seven notes to paste

For testing the **first** step of a claim: one pasted block into the panel's
note box, and what `POST /parse` makes of it. Nothing here reaches a model —
`backend/demographics.py` is patterns only, because the demographics are the
dictionary `redaction.py` scrubs the note with, so a model that split the block
would have read the name before anything existed to remove it.

Every identifier below is invented. Repo fixtures are synthetic only.

Each case was run against a live backend on 2026-08-16; the "Parsed" columns
are what actually came back, not what ought to. Where the two differ, the row
says so.

**How to read the source column.** `patient-line` means a segment of a labelled
compound line. `labelled` means a `Field: value` line. `labelled-inline` means a
label found mid-line, where the value's shape confirmed it. `sole-match` means
no label at all — the shape occurred exactly once in the whole paste, which is
the only reason it was believed. `— (choices)` means two candidates were found
and **neither** was taken; the panel offers them instead.

---

## 1 — The pilot's own header, wrapped, with a clinic footer

Probes: the compound patient line, the wrap rejoin (the line ends in `·`, so
the next physical line continues it), and whether the clinic's own phone and
address under the signature can displace the patient's.

```
Patient: Chua Beng Huat · S7211043C · 04/11/1972 · 91112233 ·
18 Toa Payoh Lorong 4, Singapore 310018 · Policy GHS-4471902
Insurance: AIA Singapore

14/03/2026, 0930h. 2-day history of periumbilical pain migrating to RIF.
Admitted 14/03/2026, laparoscopic appendicectomy 15/03/2026, discharged
17/03/2026. MC 7 days from 15/03/2026.

Dr Tan Mei Ling, MCR M08842B, Family Physician.
Braddell Family Clinic, 22 Braddell Road, Singapore 359915. Tel 62551234.
```

| Field | Parsed | Source |
|---|---|---|
| full_name | Chua Beng Huat | patient-line |
| nric | S7211043C | patient-line |
| dob | 1972-11-04 | patient-line |
| phone | 91112233 | patient-line |
| address | 18 Toa Payoh Lorong 4, Singapore 310018 | patient-line |
| policy_number | GHS-4471902 | patient-line |
| insurer | AIA Singapore | labelled |

All seven, and the clinic's `62551234` and `22 Braddell Road` are correctly not
taken — not because they were rejected, but because the patient line answered
both fields first and the first answer wins. Case 6 removes that protection.

---

## 2 — Mid-line labels, no colons, two numbers offered

Probes: labels read from the middle of a line (`NRIC S8012345D  DOB 14/03/1978`
is two labels and no colons), and the refusal path — a region holding two
candidates yields neither.

```
Name: Lim Hui Xian
NRIC S8012345D  DOB 14/03/1978
HP 9123 4567 / 6123 4567
Policy GHS-88213004 or GH-88213004 (AIA Singapore)
Blk 118 Bishan St 12 #07-21, S570118

Seen 02/08/2026. 3 days sore throat, fever 38.4, odynophagia.
Dx acute tonsillitis. Rx amoxicillin 500mg TDS x 7 days. MC 2 days.
```

| Field | Parsed | Source |
|---|---|---|
| full_name | Lim Hui Xian | labelled |
| nric | S8012345D | labelled-inline |
| dob | 1978-03-14 | labelled-inline |
| phone | *blank* | — (choices: `9123 4567`, `6123 4567`) |
| address | Blk 118 Bishan St 12 #07-21, S570118 | sole-match |
| policy_number | *blank* | — (choices: `GHS-88213004`, `GH-88213004`) |
| insurer | *blank* | — |

Two blanks that are questions rather than misses. **The panel should show both
as pick-lists** — that is the thing to check on screen, since a blank the
doctor cannot account for reads as the product failing to look.

`DOB 14/03/1978` resolving at all is the point of the inline pass: an unlabelled
date is never taken, so without the label this field stays empty.

Note `insurer` is blank although the note says "(AIA Singapore)". Insurer has no
shape, so it is only ever read from a labelled line.

---

## 3 — No labels anywhere, pure prose

Probes: what survives with nothing labelled. Name and date of birth must not.

```
Seen 02/08/2026. 34F, S9012345A, contactable at 98765432, staying at
Blk 5 Marine Terrace #12-34, Singapore 440005.

2/7 fever and cough. O/E T 37.9, chest clear. Dx viral URTI.
Review 09/08/2026 if not better. MC 1 day.
```

| Field | Parsed | Source |
|---|---|---|
| full_name | *blank* | — a name has no shape, and is never guessed |
| nric | S9012345A | sole-match |
| dob | *blank*, with `2026-08-02` and `2026-08-09` suggested | — never taken from unlabelled text |
| phone | 98765432 | sole-match |
| address | Blk 5 Marine Terrace #12-34, Singapore 440005. | sole-match |

The two blanks are the design. Three dates sit in this note and none of them is
a birth date; a shape rule that took one would have taken the consultation date.

The dates are *offered* though, as suggestions the doctor clicks or ignores.
That is the distinction to watch on screen: the box is empty, and underneath it
sits "2 found in the note — pick the patient's". Nothing is pre-selected, so a
consultation date still cannot reach a claim without a deliberate click.

Cosmetic: the address keeps its trailing full stop, because the line is the
value and only the postal code was the evidence.

---

## 4 — A policy number shaped like a mobile, and a two-digit year

Probes: the single nastiest collision in the module. `GHS-88213004` ends in
eight digits opening with an 8, which is a valid Singapore mobile by shape —
and this note carries no real phone number, so nothing else competes for the
box.

```
Patient: Sivakumar s/o Raju
DOB 14/03/78
Policy GHS-88213004 (AIA)
Seen 05/08/2026 for review of hypertension. BP 138/84, well controlled.
Continue amlodipine 5mg OM. No contact number on file. Review in 3 months.
```

| Field | Parsed | Source |
|---|---|---|
| full_name | Sivakumar s/o Raju | labelled |
| dob | *blank* | — `14/03/78` has no four-digit year, so it is not a date |
| phone | *blank* | — the policy digits are part of a longer token |
| policy_number | GHS-88213004 | labelled-inline |

**The phone box must be empty.** If a build ever puts `88213004` there, the
delimiter guard in `PHONE_IN_TEXT` has been loosened — that value would reach a
claim deterministically, skipping both the model and the review step.

The blank date of birth is the one that still has nothing behind it. Every
other case now suggests the dates it found, but `14/03/78` is not a date to
this parser at all — a two-digit year is rejected before it can become a
candidate — so the doctor who wrote the birth date in the note gets the same
empty box as one who never mentioned it. That is the remaining gap, and the
only case here where the note says something the panel does not repeat back.

---

## 5 — Every phone on the page belongs to somebody else

Probes: labels that belong to someone other than the patient. Each of these
resolves to a demographic alias on its own and must not be read, because the
qualifying word in front is exactly what says the value is not the patient's.

```
Patient: Ng Wei Jie
Clinic tel 62551234
Next of kin contact 91112233
Employer name: Sunrise Logistics Pte Ltd
Hospital name: Mount Alvernia Hospital
Plan: review in 2 weeks

Seen 09/08/2026. Right ankle inversion injury at work 08/08/2026.
X-ray no fracture. Dx lateral ligament sprain. MC 3 days.
```

| Field | Parsed | Source |
|---|---|---|
| full_name | Ng Wei Jie | labelled — *not* "Sunrise Logistics", *not* "Mount Alvernia" |
| phone | *blank* | — (choices: `62551234`, `91112233`) |
| policy_number | *blank* | — "Plan:" is deliberately not a policy label |

Five traps, none sprung. `Clinic tel` and `Next of kin contact` are rejected as
labels because a label has to open a field rather than sit mid-phrase; both
numbers then reach the unlabelled pass, where having two of them is what saves
you. **If either number appears in the phone box, that is a real bug.**

`Employer name` and `Hospital name` fail to resolve because only
patient-qualifiers may sit around a demographic label, so they will go to the
model as ordinary form questions instead.

---

## 6 — Two people, two addresses, one clinic number

Probes: the case where the two-candidate rule protects you, next to the case
where it cannot.

```
Patient: Goh Siew Lan
S6123456B, seen together with her husband S6234567C, who is her caregiver.
Blk 210 Ang Mo Kio Ave 3 #05-11, Singapore 560210

Seen 11/08/2026. Follow-up of type 2 diabetes. HbA1c 7.2. Continue metformin.

Clinic address 9 Serangoon Road, Singapore 218000. Tel 62221234.
```

| Field | Parsed | Source |
|---|---|---|
| full_name | Goh Siew Lan | labelled |
| nric | *blank* | — (choices: `S6123456B`, `S6234567C`) |
| address | *blank* | — (choices: the patient's line, the clinic's line) |
| phone | **62221234** | sole-match — **and it is the clinic's number** |

The first two blanks are the module working: two NRICs and two postal-coded
lines, so neither is guessed.

The phone is the one to look at. It is the only number in the note, so the
sole-match rule believes it — and it belongs to the clinic, sitting under the
signature exactly where the docstring says a clinic number sits. Uniqueness is
doing all the work, and here uniqueness is wrong. It lands in the box with the
same green "from the details you entered" treatment as a value the doctor
typed. See the note at the bottom.

---

## 7 — Long-form date, and label wordings that just miss

Probes: the third date rendering, an alias that is one word away from the
table, and the NRIC-inside-a-reference asymmetry.

```
Patient: Rahmat bin Osman
Date of Birth: 3 April 1971
Contact Number: 8123 4567
Policy no.: PRU-99120034
Email rahmat.osman@example.com
Ref REF-S7123456J

Seen 12/08/2026. Chest tightness on exertion x 2 weeks. ECG normal.
Referred to cardiology 12/08/2026.
```

| Field | Parsed | Source |
|---|---|---|
| full_name | Rahmat bin Osman | labelled |
| dob | 1971-04-03 | labelled |
| phone | 8123 4567 | labelled-inline — *not* `labelled`, see below |
| policy_number | PRU-99120034 | labelled |
| nric | S7123456J | sole-match, out of `REF-S7123456J` |
| address | *blank* | — no postal code anywhere |

Three things worth watching here.

**`Contact Number:` is not in the alias table** — `contactno` is, `contactnumber`
is not, so the whole-line rule skips it. The value is recovered anyway, because
the inline pass reads the leading word `Contact` on its own. It resolves through
a route it was not aimed at, which is why the source reads `labelled-inline`. A
CMS that emits `Contact Number` in a position the inline pass cannot see would
lose it silently.

**The value keeps its space** — `8123 4567`, not `81234567`. Fine for a form,
worth knowing if anything downstream compares phone strings.

**`REF-S7123456J` yields an NRIC.** Deliberate: a phone number is never buried
inside a reference, but an NRIC inside one is still the patient's, and refusing
it would lose a correct value to a collision that does not happen. In this note
the reference is the *only* NRIC-shaped thing, so it is taken. Decide whether
you like that on a real CMS export.

The email is ignored — nothing on a claim form asks for it.

---

## Three things these turned up

1. **A lone clinic phone number becomes the patient's** (case 6). The
   sole-match rule cannot tell whose number it is, and the docstring names this
   exact placement — under the signature — as the thing it was written to
   avoid. It only avoids it when a second number is present. The fix is not
   fuzzy: a number preceded by a disqualified label (`Clinic tel`, `Tel` after
   a clinic address line) is *known* not to be the patient's, and could be
   excluded from the unlabelled pass rather than merely not read by the label
   pass.

2. **`Contact Number` misses the alias table** (case 7), and only survives by
   accident of the inline pass. `CLAUDE.md` already records this under the
   demographic-label gotcha; these cases show it recovering rather than
   failing, which is worth knowing before anyone "fixes" it.

3. **A two-digit year yields a silent blank** (case 4), and it is now the only
   silent one. Since dates found in the note are offered as suggestions,
   every other case shows the doctor what it saw; `14/03/78` is rejected
   before it becomes a candidate, so a note that *does* state the birth date
   produces the same empty box as one that never mentioned it. Reading it as
   1978 is a pivot rule, and a pivot is a guess — but a guess offered as a
   suggestion is only ever a click away from being corrected, which is a
   different bargain from a guess written into the field.

## NO LABELS

Chua Beng Huat · S7211043C · 04/11/1972 · 91112233 ·
18 Toa Payoh Lorong 4, Singapore 310018 · Policy GHS-4471902
AIA Singapore

14/03/2026, 0930h. 2-day history of periumbilical pain migrating to RIF.
Admitted 14/03/2026, laparoscopic appendicectomy 15/03/2026, discharged
17/03/2026. MC 7 days from 15/03/2026.

Dr Tan Mei Ling, MCR M08842B, Family Physician.
Braddell Family Clinic, 22 Braddell Road, Singapore 359915. Tel 62551234.