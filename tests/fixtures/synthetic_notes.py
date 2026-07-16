"""Golden set of synthetic clinical notes for redaction tests.

Everything here is invented — names, NRICs, phone numbers, addresses,
policy numbers. NO real patient data may ever be added to this file.

Each entry:
- record: kwargs for PatientRecord
- identifiers_in_text: exact strings appearing in clinical_text that MUST NOT
  survive redaction (checked case-insensitively).
"""

GOLDEN_NOTES = [
    {
        "record": {
            "full_name": "Tan Wei Ming",
            "nric": "S1234567A",
            "dob": "1962-03-14",
            "phone": "91234567",
            "address": "Blk 123 Bedok North Ave 4, #05-678",
            "policy_number": "GE-8839221",
            "insurer": "Great Eastern",
            "clinical_text": (
                "Mr Tan Wei Ming (S1234567A, DOB 14/03/1962) seen 02/06/2026 "
                "c/o RIF pain x 2/7. T 38.2, guarding +. CT abd: acute "
                "appendicitis. Adm for lap appendicectomy. Contact 91234567. "
                "Policy GE-8839221. Resides Blk 123 Bedok North Ave 4, #05-678."
            ),
        },
        "identifiers_in_text": [
            "Tan Wei Ming", "S1234567A", "14/03/1962", "91234567",
            "GE-8839221", "Blk 123 Bedok North Ave 4, #05-678",
        ],
    },
    {
        "record": {
            "full_name": "Lim Siew Hoon",
            "nric": "S7712345B",
            "dob": "1977-11-02",
            "phone": "82345678",
            "insurer": "AIA",
            "clinical_text": (
                "Mdm Lim Siew Hoon, 48F. First seen 15/01/2026 for polyuria, "
                "polydipsia. HbA1c 9.8% -> T2DM, started metformin. Review "
                "12/05/2026: HbA1c 7.1%. DOB 2 Nov 1977. HP 82345678."
            ),
        },
        "identifiers_in_text": [
            "Lim Siew Hoon", "S7712345B", "2 Nov 1977", "82345678",
        ],
    },
    {
        "record": {
            "full_name": "Muhammad Faizal bin Rahim",
            "nric": "S8523456C",
            "dob": "1985-06-30",
            "insurer": "Prudential",
            "clinical_text": (
                "Faizal seen 20/06/2026 post RTA. XR L wrist: distal radius #. "
                "Cast applied, HL 14/7. Pt is Muhammad Faizal bin Rahim, "
                "S8523456C. Wife Nurul contactable at 93456789."
            ),
        },
        "identifiers_in_text": [
            "Muhammad Faizal bin Rahim", "Faizal", "S8523456C", "93456789",
        ],
    },
    {
        "record": {
            "full_name": "Ang Mei Ling",
            "nric": "S6934567D",
            "dob": "1969-01-25",
            "insurer": "NTUC Income",
            "clinical_text": (
                "Mdm Ang c/o exertional chest tightness x 3/12. No rest angina. "
                "Stress ECG positive. Referred NUH cardio. Ang Mei Ling, DOB "
                "25/01/1969. Previously seen by Dr Ong at Bedok Polyclinic."
            ),
        },
        "identifiers_in_text": ["Ang Mei Ling", "25/01/1969"],
    },
    {
        "record": {
            "full_name": "Rajesh s/o Kumaran",
            "nric": "S9145678E",
            "dob": "1991-09-08",
            "phone": "96543210",
            "insurer": "Great Eastern",
            "clinical_text": (
                "Rajesh, 34M, presents w/ acute LBP after lifting at work "
                "(warehouse). SLR negative, no red flags. MC 3/7, analgesia. "
                "Employer contact given as 96543210. NRIC S9145678E."
            ),
        },
        "identifiers_in_text": ["Rajesh", "S9145678E", "96543210"],
    },
    {
        "record": {
            "full_name": "Chua Beng Huat",
            "nric": "S5556789F",
            "dob": "1955-12-19",
            "insurer": "AIA",
            "clinical_text": (
                "Mr Chua Beng Huat reviewed for HTN/HLD. BP 152/94 despite "
                "amlodipine 10mg. Added losartan. Son (S9012345G, HP 87654321) "
                "accompanied, asks re insurability. DOB: 1955-12-19. Email on "
                "file: bhchua55@example.com."
            ),
        },
        "identifiers_in_text": [
            "Chua Beng Huat", "S5556789F", "1955-12-19",
            "S9012345G", "87654321", "bhchua55@example.com",
        ],
    },
    {
        "record": {
            "full_name": "Nur Aisyah binte Hassan",
            "nric": "S9867890H",
            "dob": "1998-04-03",
            "insurer": "Prudential",
            "clinical_text": (
                "Aisyah, 28F, G1P0 at 24/40. GDM on OGTT, diet-controlled. "
                "Seen 10/07/2026. Full name Nur Aisyah binte Hassan, DOB "
                "03/04/1998. Husband HP 98765432."
            ),
        },
        "identifiers_in_text": [
            "Nur Aisyah binte Hassan", "Aisyah", "03/04/1998", "98765432",
        ],
    },
    {
        "record": {
            "full_name": "Goh Kim Seng",
            "nric": "S4878901J",
            "dob": "1948-07-21",
            "phone": "91112222",
            "address": "10 Serangoon Ave 2, #12-05",
            "insurer": "NTUC Income",
            "clinical_text": (
                "Mr Goh Kim Seng, 77M, falls assessment. Hx: 2 falls in 6/12, "
                "last 05/07/2026 at home (10 Serangoon Ave 2, #12-05). XR hip "
                "NAD. Daughter (91112222 is pt's own HP; daughter at 90001111) "
                "requests report. NRIC S 4878901 J. DOB 21 July 1948."
            ),
        },
        "identifiers_in_text": [
            "Goh Kim Seng", "S 4878901 J", "21 July 1948", "91112222",
            "90001111", "10 Serangoon Ave 2, #12-05",
        ],
    },
    {
        "record": {
            "full_name": "Wong Li Ting",
            "nric": "S8289012K",
            "dob": "1982-02-11",
            "insurer": "AIA",
            "clinical_text": (
                "WONG LI TING seen for migraine w/ aura, freq 3-4/month. "
                "Started propranolol prophylaxis. TCU 6/52. dob 11/2/1982. "
                "Work email wonglt@corpmail.example.sg for MC."
            ),
        },
        "identifiers_in_text": [
            "WONG LI TING", "11/2/1982", "wonglt@corpmail.example.sg",
        ],
    },
    {
        "record": {
            "full_name": "Lee Chong Wei",
            "nric": "F7790123L",
            "dob": "1977-10-05",
            "phone": "+65 9333 4444",
            "insurer": "Great Eastern",
            "clinical_text": (
                "Mr Lee\nChong Wei (FIN F7790123L) seen 01/07/2026 for r) "
                "shoulder rotator cuff tear, MRI confirmed. For ortho referral. "
                "Contact +65 9333 4444 or 93334444. DOB 5 Oct 1977."
            ),
        },
        "identifiers_in_text": [
            "F7790123L", "+65 9333 4444", "93334444", "5 Oct 1977",
            "Chong Wei",
        ],
    },
]
