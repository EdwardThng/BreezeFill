# BreezeFill — revised data flow

Designed in conversation, 2026-08-04. This replaces the current panel flow
(auto-parse on paste → Map → review → Fill). Nothing here changes what the
product promises: anything the model inferred is still confirmed by the doctor
before it is written, and BreezeFill still never submits.

Everything below that describes current behaviour was read off the code or
executed against it, not recalled. Where something is a judgement call rather
than a settled decision it is marked **OPEN**.

---

## 1. Why it changes

### 1a. The name is the blackout list, and it can be poisoned

The patient's name is the dictionary `redaction.py` pass 1 uses to scrub the
note before it reaches the model. A name has no shape, so no pattern can find
one honestly — the parser can only lift it from a line the doctor labelled.
That makes it possible to poison the whole pipeline with one mislabelled line.

Executed, not hypothetical:

```
Paste:   "Patient: c/o bone pain with Tan Ming"
Parsed:  full_name = "c/o bone pain with Tan Ming"

Note in:  "Severe bone pain in right tibia. Bone density low. Pain worse at night."
Note out: "Severe [PATIENT] in right tibia. [PATIENT] density low.
           [PATIENT] worse at night."
```

Every mention of "bone" and "pain" is blacked out, the note becomes unreadable
to the model, and nothing in the system objects. The only thing between that
and a filled form is the doctor happening to open a collapsed drawer.

Note what does **not** happen: plain clinical prose is never mistaken for a
name. `"14/03/2026. 47M presents with bone issue. Discussed with Tan Ming."`
parses to nothing at all. The leftover-with-no-digits rule only runs on
segments of a line the doctor labelled `Patient:` or `Name:`. So the fix is
manual name entry, not tighter patterns — the patterns are already
conservative.

### 1b. The panel demands details the form may not want

The panel currently requires name, NRIC, date of birth and insurer regardless
of what the form on screen asks for. A doctor is made to type a policy number
for a form with no policy number box.

---

## 2. What patient details are actually **for**

This was the finding that reframed the whole design, and it is not obvious
from the UI.

**On the current live-mapping path, patient details are never written onto the
form as answers.** `_live_schema()` in `backend/main.py` marks *every* control
on the page `source="llm"`, so no row ever carries `status="demographic"`. The
model answers even the "Patient's full name" box: it sees `[PATIENT]` in the
blacked-out note, the system prompt instructs it *"Use [TOKENS] exactly as they
appear if a token belongs in a field"*, and `remerge()` swaps the token back to
the real name on the way out.

So the patient details have **one job: they are the blackout list.** Which
turns the design question from *"what does this form need?"* into *"what
cannot be blacked out without being told?"*

### What redaction can and cannot find unaided

| Detail | Found by a generic pattern? | Must the doctor supply it? |
|---|---|---|
| **Name** | ❌ no shape whatsoever | **Always** |
| Date of birth | ❌ pass 2 has no generic date rule | Only if the note contains one |
| Address | ❌ no reliable shape | Only if the note contains one |
| Policy number | ❌ | Only if the note contains one |
| NRIC | ✅ pass 2 catches any NRIC → `[NRIC_2]` | No — but supplying it fills the box |
| Phone | ✅ pass 2 catches any SG number | No |
| Email | ✅ pass 2 | Never asked for |
| Insurer | — not an identifier at all | **Never** |

The NRIC row is worth reading twice: an NRIC not in the dictionary is still
scrubbed, but as `[NRIC_2]`, which `remerge` cannot resolve — so the row comes
back flagged with the value blanked and the doctor types it on the form. Safe,
but not filled.

---

## 3. The new flow

```
1. Doctor types the patient's NAME            ── the only unconditional field
        │
2. Doctor pastes the CLINICAL NOTE            ── plus optional "other notes"
        │
3. Click "FIND PATIENT DETAILS"               ── on click only. Patterns, no AI,
        │                                        no cost, instant
4. VERIFY                                     ── often shows nothing at all
        │   · settled            → quiet
        │   · guessed            → needs a confirm click
        │   · needed but missing → flagged
        │   · not needed         → greyed out
        │
5. Click "MAP FIELDS"                         ── the AI answers the form's
        │                                        clinical questions (10–30s)
6. REVIEW                                     ── unchanged: anything inferred
        │                                        needs an explicit confirm
7. Click FILL                                 ── values written in place
        │
   Doctor checks the form and submits it themselves
```

**The gate moves.** Today the doctor's only checkpoint is before **Fill**. Now
the patient details are settled before **Map**, because that is the moment the
note is blacked out and sent. Verifying a date of birth after the note has
already gone to the model fixes the form box and nothing else — the leak has
already happened.

**Two buttons, not one.** "Find patient details" and "Map fields" stay separate
rather than the AI auto-firing on the step-4 confirm. The doctor should know
when something slow and billable is starting.

---

## 4. The two questions, kept separate

This is the idea that makes step 4 small.

| Question | Answer |
|---|---|
| What goes into the **blackout list**? | **Everything the parser found**, whether the form needs it or not |
| What do we **ask the doctor** about? | **Only what the form needs and the parser could not find** |

A policy number found in the note is always scrubbed from the note, even when
no form asks for one — the doctor simply never sees it mentioned. Privacy costs
nothing and the screen stays empty.

### The flagging rule

Flag a detail **only if the form asks for it AND the parser did not find it.**

| Form asks for it | Parser found it | Panel shows |
|---|---|---|
| yes | yes, from a labelled line | settled, quiet |
| yes | yes, but guessed | **confirm click required** |
| yes | no | **flagged — doctor types it** |
| no | yes | nothing (still used for blackout) |
| no | no | **greyed out** |

### Greyed, not hidden. Greyed, never disabled.

**Not hidden:** a box that silently disappears is indistinguishable from a bug.
Grey says "considered, not needed" — that is information.

**Never disabled:** a disabled field cannot be focused and is skipped by screen
readers, and we can be wrong about what the form needs. On a wizard we only see
the step that is rendered, so a policy-number box on step 3 looks absent.
Clicking a greyed field must wake it up as a normal input — never block a
correct action on a guess.

**Collapse when there are several.** Three or more inactive fields become one
muted line rather than dead boxes down a 400px panel:

```
Not needed on this form: phone, address, policy number.       (click to add)
```

---

## 5. Which values count as a "guess"

The parser already records *how* it found each value, in a `sources` field that
is currently returned and unused. Its own docstring says it exists *"so a
future panel can mark guesses differently from labelled values"*.

| `source` | Meaning | Treatment |
|---|---|---|
| `labelled` | The doctor wrote `NRIC: S1234567D` on its own line | Settled — no click |
| `patient-line` | A segment of a labelled patient block, identified by shape | Settled — no click **(OPEN)** |
| `sole-match` | Found loose in the note, and it was the only candidate | **Guess — confirm required** |

**OPEN:** `patient-line` could reasonably go either way. It comes from a line
the doctor explicitly labelled as the patient block, which argues for settled;
but the individual values inside it are assigned by shape, which can misfire.
Recommendation is settled, so that a well-formatted note produces zero clicks.

The reason to keep the set of clickable items small is stated in the repo
already: *"confirming them would be busywork that trains the doctor to click
through the one screen that exists to be read."* A blanket "these are fine"
button gets clicked without reading by the fourth claim.

---

## 6. How "what the form asks for" is known

Two cases, and the second is the common one:

- **A schema matched the page** — it lists its demographic fields explicitly
  (`source: demographics.nric`, etc). Exact, no guessing.
- **No schema matched** — every control's label is already available from the
  page survey the panel runs on open. Those labels are scanned for identity
  questions.

The synonym table already exists in `backend/demographics.py`:

```
nric:           nric, fin, nricfin, nricno, ic, icno, idno, identitycard
policy_number:  policy, policyno, policynumber, policy#, memberno, certificateno
dob:            dob, dateofbirth, birthdate, born
phone:          phone, tel, telephone, mobile, hp, handphone, contact, contactno
address:        address, addr, residentialaddress
full_name:      name, patient, patientname, fullname, ptname, pt
```

What a doctor calls a field in a note is what an insurer calls it on a form, so
one table serves both.

**Why this works here when general label matching does not.** The repo records
a known limit: schema-to-page enrichment compares words rather than meaning, so
*"7. When did the patient first consult you"* and *"Date of first consultation"*
share one content token, score 0.22, and fail to match. Identity fields escape
that because their wording is stereotyped — "NRIC", "Policy No.", "Date of
Birth" — which is exactly what a synonym list handles well and a similarity
score handles badly.

**Implementation choice.** The table stays in Python and is **not** copied into
JavaScript; the repo is explicit that a second copy of these patterns is how
drift becomes a leak. `POST /parse` gains an optional list of page labels and
returns which identity kinds the page asks for, alongside the parsed values.
One round trip, one definition, no new endpoint. The labels are already
scrubbed twice before they leave the browser (`learn/dump.js`, then
`scrub_patterns` on the way in).

---

## 7. Decisions taken

| Decision | Reasoning |
|---|---|
| **Name typed by hand, always, never auto-filled** | The one identifier with no shape, and the one whose corruption poisons the entire note. Justified by redaction, not by any form. |
| **Name required even when the form does not ask for it** | Same reason. It is the blackout key regardless of whether a box wants it. |
| **"Find patient details" runs on click only** | No parsing while typing. The doctor decides when to look. |
| **Insurer removed entirely** | Not an identifier, never redacted, and used in exactly one field-slot across the whole bank. |
| **Confirmations on guesses only** | Keeps the click meaningful. See §5. |
| **Greyed, not hidden** | Silent absence reads as a bug. |
| **Greyed, not disabled** | We can be wrong about what the form needs; never block a correct action on a guess. |
| **Two buttons, no auto-fire** | The doctor should know when a slow, billable AI call begins. |
| **Clinical review unchanged** | ~85% of a real form is AI-answered clinical content. It cannot skip review. |
| **Synonym table stays server-side** | A JS copy that drifts from the Python one is a leak. |

---

## 8. Why the clinical review cannot be dropped

Identity fields are a small minority of every real form. Counted across the
bank:

| Form | Total boxes | Identity (pattern) | Clinical (AI) |
|---|---|---|---|
| AIA GHS claim | 24 | 3 | **21** |
| AIA medical report | 96 | 23 | **73** |
| Great Eastern GHS | 15 | 2 | **13** |
| Prudential | 29 | 3 | **26** |
| Henner | 17 | 3 | **14** |
| RoboForm (test) | 6 | 6 | 0 |

Across the whole bank: name appears in 15 field-slots, NRIC 13, policy number
8 — but date of birth only 3 and phone only 1. There **is** a stable identity
core (name, NRIC, policy number); it is just not most of the form.

---

## 9. What a wrong name costs — the blast radius

Relevant because the new flow makes the name manual: this is what a typo does.
Redaction replaces each *part* of the name independently, so a patient named
"Tan Wei Ming" has `Tan`, `Wei` and `Ming` blacked out wherever they appear as
whole words. Executed against a real note:

| In the note | After redaction | |
|---|---|---|
| `Tan Tock Seng Hospital` | survives intact | ✅ shielded |
| `Ng Teng Fong General Hospital` | survives intact | ✅ shielded |
| `angina` (patient surnamed Ang) | survives | ✅ word boundaries |
| `Dr Ming Chen` | `Dr [PATIENT] Chen` | ❌ another clinician half-eaten |
| `sun tan rash` | `sun [PATIENT] rash` | ❌ clinical detail destroyed |
| clinic's own phone | `[PHONE_2]` | ✅ distinct token from the patient's |

Mechanisms worth knowing before touching any of this:

- **`_shield_institutions`** pulls hospital/clinic/polyclinic/medical-centre
  names out before redaction runs and restores them after, specifically because
  a patient surnamed Tan turned "Tan Tock Seng Hospital" into
  "[PATIENT] Tock Seng Hospital" and the form lost the hospital field.
- **Word boundaries throughout**, so "angina" survives a patient surnamed "Ang".
- **Name parts under 3 characters match case-sensitively**, so a surname like
  "He" does not eat pronouns.
- **Adjacent `[PATIENT]` tokens collapse into one**, so a full name matched
  part-by-part re-merges sensibly.

The governing rule, stated at the top of `redaction.py`: **over-redaction is
safe; under-redaction is not.** Losing "sun tan rash" means the model answers
*not found* and the doctor writes one line by hand. Missing a name means a
patient's identity reaches a third party.

---

## 10. Accepted consequences

- **A date of birth the parser cannot find, on a form that does not ask for
  one, is never requested — so if the note contains one it is not blacked
  out.** Accepted deliberately: demanding it on every claim is exactly the
  friction this redesign removes, and today's "always required" does not close
  the hole either, since a date written in a format `_dob_regexes` does not
  cover is not scrubbed regardless of what was typed.
- **On a multi-step wizard the panel only sees the rendered step**, so it may
  under-detect what the form asks for. The value then surfaces later as a
  flagged row in the review screen — that fallback already exists.
- **Removing insurer touches the backend**, not just the panel: `PatientRecord`
  declares `insurer: str` as required, so it becomes optional and its tests
  change with it.

---

## 11. Known residual risks (pre-existing, not introduced here)

- **A re-merged token can put the real name into a form box.** If the model
  copies `[PATIENT]` into an answer, `remerge` substitutes it silently — so a
  mangled sentence could land in a box reading "sun Tan Wei Ming rash". Only
  *unresolved* tokens force a review; a resolved one does not. If the row is
  marked `extracted` it is green and needs no confirm click.
- **The raw, unredacted note reaches the server at parse time.** Redaction
  protects the *model*, not the *server*. This is unchanged by the new flow,
  but it means UI copy must not promise that nothing has left the browser
  before step 5.
- **A name rendered into a page's field label defeats every pattern.** Labels
  are scrubbed twice and a name still has no shape. Asserted in the test suite
  as a known hole rather than fixed.

---

## 12. OPEN — proposed, not yet decided

**Warn when the typed name does not appear in the pasted note.** Once the name
is entered by hand it can be checked against the text: if it is absent, the
doctor may have pasted the wrong patient's note. That error currently passes
every guard in the system silently. Cheap to add, and it is the only new
*safety* check this redesign makes possible rather than merely moving.

---

## 13. What does not change

- The model never sees the patient's identifiers; they are the blackout list.
- Anything the model inferred needs an explicit confirm before it is written.
- Nothing is written without a click, including when the page changes by itself.
- The extension fills in place and **never submits**.
- Nothing is stored: no claim store, no `chrome.storage`, no disk.
- Redaction stays server-side, in one language, with one definition of each
  pattern.
