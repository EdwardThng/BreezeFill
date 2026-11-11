# IMPORTANT — open system design: the cache, the database, and auth

**Status: discussed 2026-08-18 and 19. NOTHING BUILT, NOTHING COMMITTED.** Read
this before creating any store, table or account system.

What is settled, and it is only two things:

- **There will be a doctor profile**, entered once and auto-filled onto forms.
  The owner's feature, and the reason any of this is being discussed.
- **It needs real authentication.** The owner's call, and correct — see "the
  licence token cannot be the credential for PII" below for why the credential
  already in the product does not stretch to cover it.

What is open: whether to use Supabase at all, which auth, where the profile
physically lives, and how many doctors share one subscription. That last one is
listed as step 0 in the order of work because it decides the others.

The sequence that produced this: the owner asked whether to create the Blob
store, said in the same breath that a user system was coming, and the second
answer changed the first — a cache and a database are not two decisions when
one is nine megabytes of JSON.

## What is actually needed, in the owner's words

> when they first create an account with BreezeFill, they can input their own
> personal information (name, name of clinic etc). Because every form will
> require the doctor to fill in some of their own information, if I just ask
> for that info when they're setting up their accounts those fields will be
> automatically filled every time they fill an insurance form.

So: **a doctor profile, auto-filled onto forms.** Not logins for their own
sake, not a dashboard — the feature is "stop retyping my own name and clinic
on every claim". And the cache is to hold every form in the bank, current and
future.

## The cache

**It is a pure cache now, and it was not before.** Until the client began
carrying the schema (2026-08-18), the bank was the only home for an uploaded
form and losing it produced `unknown form_id` in the middle of a claim. That is
fixed. Nothing depends on the bank for correctness any more, and nothing should
be allowed to again — see the guardrail added that day.

**It is worth having, and the reason is the usage pattern rather than the hit
rate in general.** A doctor uploads *the same form once per patient*. A clinic
doing ten Great Eastern claims a week pays ten full derives — three Opus calls
each — for a form that should have been read once, ever. That is the case that
pays for it, and it is the dominant one.

**The hit needs BYTE-IDENTICAL files**, because the key is
`sha256(pdf)[:32]`. Within a clinic re-using one saved file that is effectively
100%. Across clinics it depends on whether both downloaded the same static file
from the insurer. A re-scanned or re-saved copy misses. If that turns out to
bite, a fuzzier fingerprint (page count + a digest of widget names or page text)
is the fix — but **do not loosen it speculatively**: a false match means mapping
a claim onto the wrong form.

**Store the schemas; think hard before storing the PDFs.** Measured across the
six curated forms:

```
6 forms:            53 KB of schema   vs   6.8 MB of PDF
1,000 banked forms: ~9 MB of schema   vs   ~1.1 GB with the PDFs   (120x)
```

`get_pdf` is read in exactly ONE place — the fallback in `_blank_form_bytes` for
when the client did not send the file — and the website always has the file. So
the PDF copy is close to dead weight today. Dropping it makes the bank small
enough to live anywhere.

**On Redis specifically.** It fits the access pattern (small keyed JSON, read on
every upload) and it is the wrong instinct here for two reasons. First, Redis is
usually priced and sized as a *cache with eviction*, and an evicted schema costs
a full re-derive — real money, not a slow request. Second, this data wants to be
durable and is tiny: 9 MB that should never be evicted is a table, not a cache
tier. **If a database is arriving for the user system, the bank is one table in
it** and you run one store instead of two. Blob earns its place only if the PDFs
are kept, which is the thing to avoid.

## The user system, and what it collides with

**Identity already exists and needs no database.** The licence token carries the
Stripe subscription id; `verify_licence` returns it on every gated request.
"Which clinic is this" is answered today.

**What does not exist is anywhere to put a profile**, and `licence.py` says in
its own docstring why that was deliberate:

> `README.md` says publicly that there is no database, and that sentence is why
> a clinician is being asked to trust this at all. A subscriber table would make
> it false.

**The public copy has to change before accounts ship, and one file is a store
review risk.** As of 2026-08-18:

| File | What it says |
|---|---|
| `frontend/public/privacy.html` | "Nothing is stored. There is **no database, no account**, and no file on disk" |
| `README.md` | Now says "zero retention **of patient data**" and documents the form bank — **updated 2026-08-18** |
| `frontend/src/Landing.tsx` | "There is no database." — and, elsewhere, the wording that survives: "No patient data stored" |

`privacy.html` says **"no account"** explicitly, and it is the document a Chrome
Web Store reviewer reads with the review in flight. **The promise worth keeping
is the patient one**, which survives both accounts and the form bank intact: a
doctor's own professional details and a blank insurer form are neither of them
patient data. The absolute version survives neither.

Recording an omission honestly: **the form bank already eroded "no database" on
2026-08-18 and the public copy was not updated at the time.** It stayed
literally true only because production runs `NullBank`. `README.md` is fixed;
`privacy.html` and `Landing.tsx` are not, and they must be before a store is
provisioned or accounts ship.

## The fork nobody has chosen yet

**The profile could live client-side** — `chrome.storage` in the extension,
`localStorage` on the site. No database, no sessions, no password reset, and the
doctor's details never leave their machine except to be typed onto a form. Every
current promise survives untouched.

The cost: it does not follow them between devices, it is lost if they clear
browser data, and it is re-entered per browser. For a single-machine clinic that
is nearly free; for a doctor moving between a clinic PC and a laptop it is an
irritation, and it rules out a dashboard permanently.

Note this would need the `chrome.storage` hard rule amended — it currently holds
the licence key and nothing else. That rule exists to keep *patient* data off
disk, and a doctor's own name is not a patient's, so the amendment is defensible
rather than a loophole. **Amend it deliberately, in that rule's own words, or
not at all.**

## The part that is safe to build first, whichever way the storage goes

**The mapping layer is storage-agnostic.** A `PractitionerRecord`, an alias
allowlist, `practitioner.<attr>` as a second deterministic source beside
`demographics.<attr>`, and `assemble_claim` copying the values in. It works
identically whether the profile ends up in Postgres or in `localStorage`.

**It is a privacy improvement, not a cost**, for exactly the reason
`_live_sources` is: marking a control practitioner-sourced *removes its question
from the mapping call*. Today "Your name (attending doctor)" is sent to the
model, comes back `missing` because no note answers it, and the doctor writes it
by hand.

**THE DANGER, AND IT IS THE WHOLE DESIGN.** Of 23 doctor-ish labels across the
five real forms, only about **6** are the doctor filling the form in:

```
Your name (attending doctor)       yours        Referring doctor                   NOT yours
Your MCR number                    yours        Patient's regular doctor           NOT yours
Attending physician                yours        Doctor who made that diagnosis     NOT yours
MCR number                         yours        Other doctor consulted beforehand  NOT yours
Clinic name and address            yours        Previous / referring doctor        NOT yours
                                                Hospital name (where admitted)     NOT yours
                                                ...12 more
```

Auto-filling "Patient's regular doctor" or "Referring doctor" with the current
doctor's name puts a **false clinical statement on a signed claim** — plausible,
and invisible in review, which is the exact failure class this product exists to
prevent and strictly worse than the blank it replaces. So the practitioner alias
table must be an **exact allowlist**, the same discipline as the patient one,
and it must refuse the other 17. AIA's own form shows the discriminator it uses:
it writes "**Your** name (attending doctor)" and "**Your** MCR number".

**Build the allowlist from labels that really appear**, not from the handful
visible in six schemas. The input wanted is the pilot's actual form set — which
fields he retypes on every claim.

## Supabase, evaluated 2026-08-19 — NOT YET COMMITTED

The owner asked whether Supabase could hold both the form bank and doctor
profiles. It can, and the shape below is what was worked out. **Nothing is
decided and nothing is built** — the DB choice is still open and the auth
choice is explicitly deferred.

**One project, one Postgres database, two tables — not two databases.** They
never join, which is the evidence they are genuinely independent rather than
one thing. A second storage primitive (a Supabase Storage bucket) enters only
if the blank PDFs are kept, and they probably should not be.

**The two kinds of data have OPPOSITE sharing rules, and that is what shapes
the design:**

| | Form bank | Doctor profile |
|---|---|---|
| Who reads a row | **everyone** | **only that doctor** |
| Is it PII | no — a published insurer document | **yes** |
| Value comes from | being *shared* across clinics | being *private* |
| Keyed by | `sha256(pdf)` | the doctor |

The trap: applying Supabase's usual "users see only their own rows" policy to
the form bank by reflex turns it into a per-clinic cache and destroys the whole
reason it exists — one doctor uploads the Great Eastern form and *every* clinic
should benefit.

**Two practical notes.** Vercel functions plus Postgres exhausts connection
pools; **PostgREST over plain HTTP** avoids it entirely, needs no driver and no
new dependency, and is the same shape `BlobBank` already uses — `SupabaseBank`
would implement the same three methods and `build_bank()` would pick it up from
an env var. And **Supabase offers Singapore**, so the doctor's PII would sit
in-region, unlike the Anthropic inference.

## The licence token cannot be the credential for PII

**The correction that matters, made 2026-08-19.** It was suggested here that
the existing licence token could double as the account credential, since it
already carries a Stripe subscription id and `verify_licence` returns it on
every gated request. **That was wrong, and `licence.py` disqualifies it in its
own docstring:**

> **a leaked token keeps working until it expires.** Revocation IS expiry [...]
> There is deliberately no revocation list
>
> a token gets pasted into panels, quoted in support email and pasted into chat
> transcripts

Every one of those is a fine trade for a **paywall** — worst case somebody gets
free mapping for 30 days. Every one is disqualifying for a credential that
unlocks a doctor's name, MCR number and clinic address. It is also
per-*subscription*, so it cannot tell two doctors at one clinic apart.

**So there are two credentials answering two different questions**, and neither
replaces the other:

| | Licence token | A real session |
|---|---|---|
| Answers | *is this clinic paid up?* | *which doctor is this?* |
| Gates | the model routes | the profile |
| Revocation | expiry only, 30 days | immediate, per user |
| Scope | one subscription | one person |
| Safe to quote in support email | yes, by design | **no** |

**The licence gate stays exactly as it is.** Nothing above changes it.

## The extension is what makes the auth choice hard

A profile living server-side behind a session means **the side panel needs a
session** — a login flow inside a Chrome side panel, plus amending the hard rule
that `chrome.storage` holds the licence key and nothing else so it can hold a
refresh token. That is a lot of new surface in the place with the least room for
it.

**The shape proposed instead, not yet chosen: treat the doctor's details exactly
like the patient's.** Patient demographics never travel with a claim — the panel
holds them, `assemble_redacted` returns `fill_from` naming the value, and the
panel fills locally. Practitioner details can work identically
(`fill_from: "practitioner.full_name"`), which would mean:

- **The website is where you log in** and edit the profile. Accounts belong
  there, and it is an ordinary web app.
- **The extension holds a local copy** and fills from it — no session in the
  panel, and the details never reach the server during a claim at all.
- The copy arrives by a **one-time sync**: a short-lived single-use code shown
  on the website after login, pasted into the panel once.

**This needs the `chrome.storage` hard rule amended, deliberately and in that
rule's own words.** The rule exists to keep *patient* data off disk; a doctor's
own professional details on their own machine is the category the licence key
already occupies. Defensible — but written down as a decision, not slipped in.

## Sketch of the schema, for whenever this is picked up

```sql
-- GLOBAL. The uploader is deliberately NOT recorded: linking a doctor to an
-- insurer's form is a weak signal about their patients, and nothing needs it.
create table form_bank (
  pdf_sha256    text primary key,      -- key_for(pdf), the existing key unchanged
  schema        jsonb       not null,
  fill_mode     text        not null,  -- 'acroform' | 'overlay'
  display_name  text,
  field_count   int,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);

-- PER DOCTOR. PII, and the reason privacy.html has to change first.
create table practitioner (
  user_id          uuid primary key,   -- references auth.users(id) if Supabase Auth
  subscription_id  text,               -- which clinic pays; links to the licence
  full_name        text not null,
  mcr_number       text,
  clinic_name      text,
  clinic_address   text,
  clinic_phone     text,
  updated_at       timestamptz not null default now()
);

-- RLS ON, DENY BY DEFAULT, on both. Supabase exposes Postgres to the browser
-- through PostgREST with an anon key, and a table with RLS off is readable by
-- anyone holding it. Only the backend's service-role key should touch these.
alter table form_bank    enable row level security;
alter table practitioner enable row level security;
```

**Size is a non-issue**: ~9 MB of schema JSON per 1,000 banked forms, against a
500 MB free tier. The form bank will not be what is outgrown.

## The question that decides the auth shape, and is unanswered

**How many doctors share one subscription?** Pricing is per clinic.

- **One** — the pilot, a solo GP — and the profile is per subscription, the
  panel needs no session, and the sync code may be unnecessary.
- **Several** — a clinic with a locum — and something must identify *which*
  doctor is filling this form, which is where per-user auth genuinely earns its
  place rather than being assumed into the design.

Do not build the profile table until this is answered; it changes the primary
key.

## Order of work, when this is picked up

0. **Answer "how many doctors per subscription".** One question, and it decides
   the primary key of the profile table and whether the panel needs a session
   at all. Everything below is cheaper once it is answered.
1. **Rewrite `privacy.html` and `Landing.tsx`** onto the patient-data promise.
   Cheapest, unblocks everything, and it is a store-review risk while it is
   wrong. `privacy.html` currently says "no database, no account" outright.
2. **Decide the profile's home** — server-fetched, or a local copy synced once.
   This is the fork; everything else follows it. The DB choice (Supabase or
   otherwise) is still open and is the smaller half of this decision.
3. **Build the practitioner mapping layer.** Storage-agnostic, so it can be done
   in parallel with 2 and wired to whichever wins.
4. **Then the bank's storage.** One table in the user database if there is one;
   Blob with schemas only if there is not. Never both.

---

## Reference — the system design document

**https://claude.ai/code/artifact/416cfc07-d618-4779-93a0-b5f9c4d9db74**

Written 2026-08-19, traced from the source rather than from these notes: every
path a consultation note can take, which process each step runs in, and where
the trust boundaries sit. It covers the three dataflows (portal claim, PDF
claim, reading a blank form), all four Anthropic call sites, the complete list
of what persists, and the failure modes.

Private until shared. **It is a snapshot, not a live view** — it does not
update itself, so treat a disagreement between it and the code as the document
being out of date, and republish it from the same file path rather than
creating a second one.
