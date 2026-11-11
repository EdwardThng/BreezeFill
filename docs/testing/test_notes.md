# Test notes for the pilot

Six synthetic cases for trying BreezeFill at **https://breezefill.com**. The
DNS landed on 2026-08-08, so that is the address to use and to learn.

`https://breezefill-livid.vercel.app` still resolves to the same deployment and
still works, but do not hand it to anyone: `livid` is a name **Vercel**
generated, it lives in their namespace rather than ours, and it is theirs to
change.

**Install the extension from that URL, and delete any copy you downloaded
earlier.** There used to be a second address serving an older build, and an
extension from there talked to that older backend — which showed up as
unrelated-looking failures rather than as "you have the wrong version". That
address is gone, but a zip already on disk still works and is still wrong.

**If the panel says it has no access to the tab**, remove the extension from
`chrome://extensions` completely and load it again. A plain reload is not
enough: Chrome persists the side-panel behaviour flag per extension, and an
install that ever set it keeps swallowing the toolbar click.

**Every patient here is invented.** The names, NRICs, phone numbers, addresses
and dates are all made up, and no case is drawn from a real consultation. They
are synthetic because anything committed to this repository has to be — not
because real notes are off limits.

**Real consultation notes are in scope** (the owner's call, 2026-08-06). There
is no test mode and no expectation that you anonymise a note before pasting it.
What you should know while doing it: the note is de-identified on our server
before any of it reaches the model, but that model call currently runs outside
Singapore, and the PDPA expects a comparable-protection agreement for an
overseas transfer which is not yet in place. `https://breezefill.com/privacy`
says so plainly and is the document to read. These six cases are still the
better place to *start*, because you know what the right answer is.

## How to use them

For each case: copy the patient details into the top of the form, paste the
note into the notes box, pick the insurer, and generate.

**What to look at is not "how many boxes got filled".** The thing to judge is
whether every box that *was* filled is right. A blank is a few seconds of
handwriting; a wrong value is something you'd be signing your name to. Cases 5
and 6 exist specifically to check the system stays quiet when it should.

Worth noting as you go:
- Any field filled with something the note doesn't support — **this is the
  one that matters most**
- Any field marked "From your notes" (green) that wasn't actually stated
- A date that's right in content but wrong in format or year
- Anything left blank that the note clearly answered

---

## Case 1 — Acute appendicitis, emergency surgery
*Try with: AIA Group H&S, or Prudential medical report*

**Patient:** Chua Beng Huat · S7211043C · 04/11/1972 · 91112233 ·
18 Toa Payoh Lorong 4, Singapore 310018 · Policy GHS-4471902

```
14/03/2026, 0930h. 53M, previously well, presents with 2-day history of
periumbilical pain migrating to right iliac fossa. Associated nausea, two
episodes of vomiting. No diarrhoea. No urinary symptoms. Last meal 2100h
previous night.

O/E: T 38.1, HR 96, BP 128/76. Abdomen soft, marked RIF tenderness with
rebound. Rovsing's sign positive. Psoas negative.

Ix: WBC 15.4, CRP 88. CT abdomen/pelvis 14/03/2026: acute appendicitis,
appendix 11mm, no perforation, no abscess.

Referred to Mount Elizabeth Hospital, admitted same day 14/03/2026 under
Dr Lim Wei Sheng (general surgery). Laparoscopic appendicectomy performed
15/03/2026. Findings: inflamed non-perforated appendix approx 7cm.
Uncomplicated post-op recovery. Discharged 17/03/2026.

MC 7 days from 15/03/2026 to 21/03/2026.

Review 24/03/2026: wound healing well, no discharge. Patient well, resumed
light duties. Care concluded.

Dr Tan Mei Ling, MCR M08842B, Family Physician.
Braddell Family Clinic, 22 Braddell Road, Singapore 359915. Tel 62551234.
```

---

## Case 2 — Dengue with hospitalisation
*Try with: Great Eastern Group H&S, or AIA Medical Report (Section D)*

**Patient:** Nurul Aisyah Binte Rahman · S8830517D · 17/05/1988 · 98765432 ·
5 Tampines Street 21, Singapore 529391 · Policy GE-88213

```
02/04/2026. 37F presents day 4 of fever. Onset 30/03/2026 with sudden high
fever, severe retro-orbital headache, myalgia and arthralgia. No cough, no
sore throat. No recent travel outside Singapore. Neighbour recently
diagnosed with dengue.

O/E: T 39.2, HR 104, BP 106/68. Tourniquet test positive. No bleeding.
No hepatomegaly.

Ix 02/04/2026: dengue NS1 antigen positive. Platelet 92, Hct 41, WBC 3.1.

Diagnosis: dengue fever without warning signs.

Advised strict hydration, paracetamol only, avoid NSAIDs. Daily platelet
monitoring arranged. Warning signs explained to patient and spouse.

04/04/2026: platelet fell to 61, patient reporting persistent vomiting.
Admitted Changi General Hospital 04/04/2026 for monitoring and IV fluids.
No progression to dengue haemorrhagic fever. Platelets recovered to 118 by
07/04/2026. Discharged 08/04/2026.

MC from 02/04/2026 to 12/04/2026.

Dr Tan Mei Ling, MCR M08842B, Family Physician.
Braddell Family Clinic, 22 Braddell Road, Singapore 359915.
```

---

## Case 3 — Fall at work, wrist fracture
*Try with: Prudential medical report (accident), or AIA Medical Report (Section C)*

**Patient:** Ramasamy Kumaran · S9104882G · 22/08/1991 · 87654321 ·
101 Jurong East Street 13, Singapore 600101 · Policy PRU-772104

```
11/02/2026. 34M, warehouse supervisor. Accident at workplace 10/02/2026
approximately 1430h: slipped on wet loading bay floor, fell onto
outstretched left hand. No head injury, no LOC. Not under influence of
alcohol or medication at time of incident.

Presented 11/02/2026, one day post-injury, with left wrist pain and
swelling, unable to bear weight through the hand.

O/E: obvious dinner-fork deformity left wrist. Neurovascularly intact.
No open wound. No other injuries.

X-ray left wrist 11/02/2026: dorsally angulated distal radius fracture,
extra-articular. No ulnar styloid involvement.

Diagnosis: closed fracture distal radius, left.

Referred same day to Ng Teng Fong General Hospital orthopaedics.
Closed reduction and below-elbow cast applied 11/02/2026 under
Dr Goh Kah Meng. Not admitted, day case.

MC 21 days from 11/02/2026 to 03/03/2026. Patient cannot perform lifting
duties of his occupation during this period. Expected to return to full
duties after cast removal and review, estimated 6 weeks.

No prior injury to this wrist. No underlying bone disease.

Dr Tan Mei Ling, MCR M08842B, Family Physician.
Braddell Family Clinic, 22 Braddell Road, Singapore 359915.
```

---

## Case 4 — Day surgery, lipoma excision
*Try with: AIA Group H&S (tests the excision-size field)*

**Patient:** Lim Hwee Kiat · S6503219A · 21/03/1965 · 90011223 ·
77 Ang Mo Kio Avenue 3, Singapore 560077 · Policy GHS-2210873

```
20/01/2026. 60M presents with painless lump over posterior neck, present
approximately 18 months, gradually enlarging. No pain, no discharge, no
overlying skin change. Not interfering with movement. Cosmetic concern.

O/E: soft mobile subcutaneous mass posterior neck, approx 4cm, non-tender,
no fluctuance, overlying skin normal.

Diagnosis: lipoma, posterior neck.

Ultrasound 20/01/2026: well-circumscribed subcutaneous lesion 4.2 x 3.1cm,
features consistent with lipoma. No deep extension.

Excision performed under local anaesthesia 27/01/2026 as day surgery at
clinic procedure room. Lesion excised intact, measured 4.3cm. Wound closed
with 4/0 nylon. No complications.

Histology 03/02/2026: benign lipoma, margins clear.

Sutures removed 05/02/2026, wound healed. No follow-up required.

MC 2 days, 27/01/2026 to 28/01/2026.

Dr Tan Mei Ling, MCR M08842B, Family Physician.
Braddell Family Clinic, 22 Braddell Road, Singapore 359915.
```

---

## Case 5 — Deliberately sparse note

**This one is the real test.** It is a thin note of the kind written when a
consultation is rushed. Most of the form is genuinely unanswerable from it.

**A good result here is mostly blanks.** If fields come back confidently
filled — an admission date, an operation code, a hospital name — that is the
system inventing, and it is worth telling me about.

*Try with: any form*

**Patient:** Foo Sok Cheng · S5907114B · 11/07/1959 · 96543210 ·
9 Bedok North Street 1, Singapore 460009 · Policy GHS-9910244

```
08/05/2026. Reviewed. Ongoing epigastric discomfort. Started omeprazole
20mg om. Advised diet. Review 2/52 if no better.
```

---

## Case 6 — Note with an unrelated second condition

Checks the system doesn't mix a second, unrelated problem into the claim, and
that the mention of another person's illness doesn't leak into any field.

*Try with: Great Eastern Group H&S*

**Patient:** Devi Shanmugam · S7712258E · 25/12/1977 · 91234567 ·
30 Clementi Avenue 4, Singapore 120030 · Policy GE-55190

```
19/06/2026. 48F presents with 3-day history of right-sided loin pain
radiating to groin, colicky in nature. Associated nausea. No fever.

O/E: right renal angle tenderness. Abdomen otherwise soft.

Urine dipstick: blood 2+, nitrites negative.
CT KUB 19/06/2026: 6mm calculus at right vesicoureteric junction, mild
hydronephrosis.

Diagnosis: right ureteric colic secondary to VUJ calculus.

Admitted Singapore General Hospital 19/06/2026 for pain control. Passed
stone spontaneously 21/06/2026. Discharged 21/06/2026. No surgical
intervention required.

Separately: patient also has well-controlled hypothyroidism, on
levothyroxine 75mcg daily since 2019, last TFT normal 03/2026. Unrelated to
this admission.

Patient mentioned her husband was hospitalised last month for pneumonia at
Tan Tock Seng Hospital; she is his carer and asked about MC for caregiving.
Explained not applicable.

MC 4 days, 19/06/2026 to 22/06/2026.

Dr Tan Mei Ling, MCR M08842B, Family Physician.
Braddell Family Clinic, 22 Braddell Road, Singapore 359915.
```

---

## Reporting back

The most useful feedback is a specific wrong value: which form, which field,
what it said, and what the note actually supported. That is more actionable
than an overall impression, and wrong-fill is the failure mode that matters.

Blanks are working as intended — note them if a blank field was clearly
answered in the note, but don't treat a blank as a bug by itself.
