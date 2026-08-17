# BreezeFill — extension UI spec (for redesign)

Source of truth: `extension/manifest.json`, `extension/panel/panel.html`,
`extension/panel/panel.css`, `extension/panel/panel.js`, and the injected
scripts `extension/fill/locate.js`, `extension/fill/apply.js`,
`extension/content/fill.js` (these generate the report content shown in step 3).

---

## 0. What the product is, in one paragraph

A Singapore GP opens an insurer's online claim form in Chrome, clicks the
BreezeFill toolbar icon, and pastes their consultation note into a side panel
that sits beside the form. The panel reads the questions off the live page,
sends a redacted note to a backend that maps note → answers, shows every
proposed answer with its provenance for the doctor to confirm, then writes the
accepted values into the insurer's own page. **It never submits.** The doctor
reviews, signs and submits themselves.

The design consequence that matters most: **this UI is a checkpoint, not a
conveyor belt.** Everything it fills is signed and submitted as the doctor's
own clinical statement, so the review step is the product. Any redesign that
makes reviewing feel skippable, or makes "ready" and "not yet confirmed" look
similar at a glance, is a regression regardless of how much better it looks.

---

## 1. The surface, and its hard constraints

| Constraint | Detail |
|---|---|
| Surface | Chrome MV3 **side panel** (`side_panel.default_path`), opened by clicking the toolbar icon. There is no popup, no options page, no onboarding page. |
| Width | Whatever the user drags the panel to. Design target **~360–420px**, and it must survive down to ~320px and up to ~600px. Height is the full browser viewport, one vertical scroll. |
| Neighbour | It sits *beside a dense insurer claim form*. It competes for attention with the thing the doctor is actually reading. The current CSS comment states the intent: "It stays quiet — one accent colour, used only for the two buttons that do something." |
| CSP | MV3 forbids inline `<script>` and inline `<style>`. **No CDN fonts, no external CSS, no remote images.** Everything must be a local file in the extension bundle. Current type stack is `system-ui, -apple-system, "Segoe UI", sans-serif` at 13px/1.5, and monospace `ui-monospace, "Cascadia Mono", Menlo, monospace` for textareas. |
| Storage | **No `chrome.storage`, and the permission is deliberately not requested** — patient notes must never reach disk. Nothing can be persisted between sessions: no saved drafts, no "recent notes", no remembered settings, no dismissed-tip state. Closing the panel discards the claim. This is a privacy guarantee, not an oversight. |
| Icons | No icon files are declared in the manifest today (Chrome renders a default). An icon set is a legitimate design deliverable. |
| Theme | Light + dark via `prefers-color-scheme`. Both must work; the panel inherits the browser's theme, not the page's. |
| Colour | Colour is never the sole carrier of meaning. Every review row states its status **in words** as well as colour — roughly 1 in 12 men has a colour vision deficiency, and extracted-vs-inferred is the entire reason the review step exists. Keep this rule. |
| Accessibility today | `role="status"` on the three status lines; `aria-labelledby` on each section; a `.visually-hidden` label on the second textarea; `:focus-visible` outlines at 2px accent. Keep or improve. |

### Current design tokens

```
                     light        dark
--bg                 #ffffff      #1b1e23
--fg                 #16191d      #e9ecf1
--muted              #5d6470      #a3abb8
--line               #dfe3e8      #333941
--field-bg           #ffffff      #23272d
--accent             #1a5fb4      #7aa9e9
--accent-fg          #ffffff      #10131a
--extracted (green)  #1f7a3d      #6cc48a
--inferred  (amber)  #9a6100      #e0b25c
--missing   (grey)   #737b87      #9aa2ae
--danger    (red)    #b3261e      #f29b95
--warn-bg            #fdf3e2      #33291a
```

Body padding `12px 14px 32px`. Sections `margin-bottom: 22px`. Inputs: 1px
`--line` border, 5px radius, 6px/8px padding. Buttons: 7px/12px padding, 5px
radius, `.primary` = filled accent. Field captions are 11px uppercase 600
weight in `--muted` with 0.04em tracking.

---

## 2. The screens

There are **four sections and two drawers** in one scrolling column. Sections 1
and 3 are always present; 2 and 4 are `hidden` until earned.

```
┌─ header ──────────────────────────────────┐
│ BreezeFill                                │  always
│ Fills the form in place. Never submits it.│
├─ ① Patient and note ───────────────────────┤  always
│   Insurer form  (detected line + override) │
│   Paste the consultation      [textarea]   │
│   ▸ Other notes (optional)    [drawer]     │
│   ▾ Patient details           [drawer]     │
│   note about pattern-matching              │
│   [ Map fields ]   status                  │
├─ ② Review ─────────────────────────────────┤  hidden until a successful map
│   summary line                             │
│   review rows ×N                           │
├─ ③ Fill this page ─────────────────────────┤  always (NOT gated on ②)
│   note about page access                   │
│   [Check this page] [Fill]    status       │
│   fill report                              │
├─ ⊕ Add this form to the bank ──────────────┤  hidden; only after a
│   note + [Copy JSON] + readonly JSON       │  schema-free fill succeeds
├─ ▸ Advanced ───────────────────────────────┤  always, collapsed
│   Backend URL                              │
└────────────────────────────────────────────┘
```

Note the numbering oddity, flagged again in §7: step **3 is usable before step
2 exists**, on purpose. "Check this page" answers "can BreezeFill see this form
at all", which is worth asking before any note has been pasted.

---

### Header

- `h1` **BreezeFill** — 15px, 600-ish weight.
- Tagline, 12px muted: **"Fills the form in place. Never submits it."**
- 1px bottom rule, 10px padding-bottom, 14px margin-bottom.

The tagline is load-bearing marketing copy — it is the product's core promise
and the landing page has a test asserting the site never claims to be fully
automatic. Don't cut it for space.

---

### ① Patient and note

Heading: circled numeral `1` (18px accent disc, white 11px 600 numeral) + **"Patient and note"** at 13px.

#### 1a. "Insurer form" — the detected-form line

A caption **INSURER FORM**, then a single paragraph `#form-detected` that is a
*statement of fact, not a control*, plus an optional override.

Five distinct states, all rendered into the same one-line paragraph:

| State | Copy | Style |
|---|---|---|
| Initial | `Checking this page…` | `.detected` (600 weight) |
| Schema matched | `AIA — GHS Claim Form` (`insurer — display_name`, or just `display_name` if no insurer) | `.detected`, 600 weight, full `--fg` |
| No schema matched (normal!) | `Reading the questions on this page (claimez.aia.com.sg)` | `.detected.unknown` — 400 weight, `--muted` |
| No host known | `Reading the questions on this page` | `.detected.unknown` |
| Could not read page | `Could not read this page — pick the form yourself, or click the BreezeFill icon on the tab you want to fill.` | `.detected.unknown` + `<select>` force-revealed |

Beneath it, either:
- a link-styled button **"Choose a different form"** (`button.link`: no border,
  accent, underlined, 11.5px) — shown in the four normal states; or
- a `<select>` listing every form in the bank as `Insurer — Display name` —
  shown after the doctor clicks the override, or forced open in the error
  state.

**Design brief for this block:** "no schema matched" is a completely ordinary,
successful state — every question on the page still gets answered — but it
currently renders in the same greyed style as the genuine error. Those two
should not look alike. A schema only ever changes *how sharply* each question
is put to the model, never whether it is attempted. The panel must never look
like it is declining to fill a form.

#### 1b. "Paste the consultation"

- Caption **PASTE THE CONSULTATION**.
- `<textarea rows="12">`, monospace 12px, `spellcheck="false"`, vertical resize.
- Placeholder: *"Paste the patient's details and the clinical note together."*

This is the primary input and by far the biggest element on the panel. The
doctor pastes the consultation exactly as it sits in their clinic CMS —
demographics header and clinical note in one block.

#### 1c. "Other notes (optional)" — collapsed drawer

- `<details>`, summary **"Other notes (optional)"** styled like a field caption
  (11px uppercase 600 muted).
- Inside: `<textarea rows="6">` with a visually-hidden label, placeholder
  *"Anything the form asks for that is not in the consultation note —
  admission references, ward class, billing details."*
- Trailing note: *"Redacted with the note, and read for identifiers the same
  way."*

Collapsed by default so the common case still reads as *one box, one paste*.
Both boxes are joined into one corpus before anything is sent.

#### 1d. "Patient details" — the correction drawer

A `<details>` whose **summary text is dynamic** and is the main status readout
for parsing:

| Situation | Summary copy |
|---|---|
| All required present | `Patient details — 5 of 7 found` |
| Something required missing | `Patient details — full name, nric still needed` (comma-joined, lowercased field labels) |
| Parse request failed | `Patient details — could not read the paste, fill these in` |

Behaviour: the drawer **opens itself** when something required is missing —
but only *once per paste*, so it doesn't fight a doctor who just closed it.
Required = Full name, NRIC, Date of birth, Insurer.

Contents — a `repeat(auto-fit, minmax(140px, 1fr))` grid, so 2 columns at panel
width and 1 column when narrow:

| Field | Input |
|---|---|
| Full name | text |
| NRIC | text |
| Date of birth | `type="date"` |
| Phone | text |
| Policy number | text |
| Insurer | text |

then full-width:

| Address | text |

Re-parsing happens on a 400ms debounce as the doctor types in either paste box
— **except** for any field the doctor has typed in themselves, which wins from
then on.

**Design brief:** these are explicitly *not a summary* — they are a required
correction surface. These exact values are the dictionary that redaction
searches the note for, so a name that arrived wrong here is a name that stays
in the text sent to the model. Required vs optional is currently invisible in
the UI (it only surfaces as an error after clicking Map). That's worth fixing.

#### 1e. The privacy note

Muted 11.5px paragraph:

> "Names and identifiers are found by pattern, never by a model. They are what
> the paste is redacted against before any of it is sent to one, and they are
> written onto the form directly."

This is a trust claim, not filler. It's the panel's only in-context
explanation of the privacy model, and it currently reads as small grey legal
text — the thing a doctor most needs to believe is styled like the thing they'd
most likely skip.

#### 1f. Action

- Primary button **"Map fields"**.
- Status line `#map-status`, `role="status"`, 12px, `min-height: 1.2em`.

Status states:

| Kind | Copy |
|---|---|
| busy (muted) | `Reading this page, then mapping…` (button disabled meanwhile) |
| error | `Paste the consultation first.` |
| error | `Still needed: full name, nric, date of birth.` (also force-opens the details drawer) |
| error | `Could not reach the backend. Check it is running, then check the URL under Advanced.` |
| error | `No fillable questions found on this page. Click the BreezeFill icon on the tab with the form open.` |
| error (502) | `The model call failed.` |
| error (503) | `The backend has no API key. Set ANTHROPIC_API_KEY in the terminal running it, then restart it.` |
| error (404) | `The backend does not know this form. Restart it if you have just added one.` |
| error (413) | `This page has more questions than BreezeFill can map in one go. Try a page with fewer fields, or one step of the form at a time.` |
| error (422) | `BreezeFill could not read any questions on this page. Its fields may have no labels, or the form may be inside a frame BreezeFill cannot see.` |
| error (other) | `Request failed (500).` |
| success | *cleared to empty* — steps 2 and 3 appear |

The mapping call is a live LLM call and takes **roughly 10–30 seconds**. Today
that is a one-line muted "Reading this page, then mapping…" and a disabled
button. That is the single weakest moment in the whole UI: the longest wait in
the product has the least feedback.

---

### ② Review — the heart of the product

Heading: circled `2` + **"Review"**. Hidden until a map succeeds.

#### Summary line (muted note, 11.5px)

Two forms:

- `3 values still to confirm. Nothing is written until you do.`
  (singular: `1 value still to confirm.`)
- `9 of 24 fields ready to write. The rest are for you to complete by hand.`

#### Review rows

One card per mapped field. Card: 1px `--line` border, 6px radius, 9px/10px
padding, 8px gap. Contents top to bottom:

1. **Status badge** — 10.5px, 700 weight, uppercase, 0.05em tracking, colour
   only (no pill/background today). Four values:

   | `status` | Badge text | Colour |
   |---|---|---|
   | `extracted` | `EXTRACTED FROM THE NOTE` | green `--extracted` |
   | `demographic` | `FROM THE DETAILS YOU ENTERED` | green `--extracted` |
   | `inferred` | `INFERRED — CHECK THIS` | amber `--inferred` |
   | `missing` | `NOT FOUND — FILL BY HAND` | grey `--missing` |

2. **Field label** — 600 weight. This is the schema's human label ("ICD-10
   code") or the page's own question wording. Raw ids must never appear.

3. **Help text** (optional) — muted 11.5px. The instruction behind the
   question, e.g. *"the date the patient FIRST consulted this doctor for this
   condition, not the latest visit."*

4. **The editable value**, one of three controls:
   - **checkbox** when `field_type === "checkbox"`;
   - **`<select>`** when the field declares `options` — the form's own option
     strings verbatim, prefixed by a blank option reading **`— leave blank —`**
     (blank must stay reachable: "none of these" is a legitimate answer);
   - **`<textarea>`** otherwise, auto-sized 1–4 rows by value length,
     monospace 12px.

5. **"Confirm" button** — only rendered when the row `needs_review`, has a
   value, and is not yet confirmed. Disappears once confirmed.

#### Row states

| State | Appearance |
|---|---|
| Pending (needs review, has a value, unconfirmed) | `--warn-bg` background + amber `--inferred` border. Deliberately reads as *visibly unfinished* so a panel scrolled past at speed never looks ready. |
| Confirmed | Normal card; Confirm button hidden. **No positive confirmation styling exists today.** |
| Missing / no value | Normal card, grey badge, empty input. Never gated on confirm — confirming an empty field would be busywork that trains the doctor to click through the one screen that exists to be read. |

**Editing a value counts as confirming it** — the doctor typed it, so there is
nothing left for them to accept. The row flips from pending to confirmed on
first keystroke.

**Design briefs for this section — the highest-value work in the whole panel:**

- Real AIA forms run to ~24 fields; a live page can carry up to 50. So this is
  a **long list of 20–50 cards in a 400px column**, with no grouping, no
  filter, no sticky "N left to confirm" counter, and no way to jump to the next
  pending row. The summary line scrolls away instantly.
- There is no bulk affordance, and that is deliberate — but a *guided* pass
  (next / next) is not the same as a "confirm all" button and would be a
  legitimate improvement.
- Confirmed rows are visually identical to extracted ones. The doctor gets no
  reward signal for progress.
- `missing` rows are dead weight in the scroll but must stay visible — they are
  what tells the doctor what they still have to write by hand. They're a
  candidate for collapsing/grouping, not for hiding.
- The three-way distinction (extracted / inferred / missing) is the product's
  whole safety argument and is currently carried by 10.5px coloured caps.

---

### ③ Fill this page

Heading: circled `3` + **"Fill this page"**. **Always visible**, even before
anything is mapped.

- Muted note: *"BreezeFill has no access to any page until you grant it here,
  one site at a time."*
- Two buttons in a wrapping flex row:
  - **"Check this page"** — secondary. A read-only survey; writes nothing.
  - **"Fill"** — primary, `disabled` until there is something confirmed to
    write (disabled when any pending row exists, or when zero rows are ready).
- Status line `#fill-status`, `role="status"`.
- `#fill-report` — a rendered report below.

#### Status copy

| Trigger | Copy |
|---|---|
| Check, busy | `Reading the page…` |
| Check, nothing mapped yet | `Connected to claimez.aia.com.sg. Found 24 fillable fields. Map a note to see which ones match.` |
| Check, plan matches | `Matched 9 of 11 fields on claimez.aia.com.sg.` |
| Check, plan does not match (error) | `Only matched 2 of 11 fields on claimez.aia.com.sg. BreezeFill will not fill a page it does not recognise.` |
| Fill, busy | `Filling…` |
| Fill, success | `Filled 9 fields. Check each one, then submit the form yourself.` |
| Fill, refused (error) | `Nothing was filled: the page does not match the form this schema describes` |
| Page changed under us | `This page changed — press Fill again to write the fields on this step.` |
| No tab access (error) | `BreezeFill has no access to this tab. Click the BreezeFill icon in the toolbar while this page is open, then try again.` |
| Injected script silent (error) | `The page did not respond.` |

#### The fill report

Three stacked blocks, all plain `<ul>`/`<p>` today:

1. **Per-field outcomes** — a bulleted list of `Label — outcome (reason)`:
   - outcomes: `filled`, `unchanged`, `skipped`
   - reasons: `no value`, `no matching option`, `no target`, `not writable`,
     `unmatched`, `ambiguous`
   - e.g. `Ward class — skipped (no matching option)`
   The reason matters: "skipped" alone covered three situations needing three
   different responses from the doctor — already correct, not on this page, and
   the value would not go in. The last of those is a field they reviewed and
   approved, and it needs to stand out.

2. **Deferred fields** (wizard forms) — muted note:
   `4 fields belong to a later step. Move to that step and press Fill again.`
   (singular `1 field belongs`). This is a normal, expected outcome on
   multi-step insurer portals and must not read as failure.

3. **Unknown controls** — muted heading *"Fields on this page BreezeFill does
   not know about — fill these yourself:"* followed by a muted `<ul>` of labels,
   or `(unlabelled select)` where a control had no readable label.

**Design brief:** this report is a flat monochrome bullet list carrying three
completely different kinds of information — *what I wrote* (the doctor should
go verify each one on the page), *what I'll write later*, and *what you must do
by hand*. Each deserves a different visual treatment and a different call to
action. Right now they run together and the most important sentence in the
product — "Check each one, then submit the form yourself" — is a 12px status
line above them.

---

### ⊕ Add this form to the bank — **REMOVED 2026-08-17**

**This section is no longer built.** The owner's call, and it is the design brief
below arriving at its conclusion: a JSON block asking a doctor to read a schema
is a developer artefact in a clinician's tool, and the schema it produced bought
sharpness rather than coverage, so nothing about the fill depended on it. Schemas
are authored from a learn-mode dump instead. Kept here as the record of what was
built and why it went; do not implement it again from this spec.

Heading: `+` in the same circled-numeral chip + **"Add this form to the bank"**.

Hidden, and shown **only** after a successful fill on a page that no schema
described. Contents:

- Muted note: *"This page had no schema. Below is a draft of one, built from
  the fields BreezeFill found and the values you accepted. Read it, then save
  it into `backend/schemas/` — the next claim on this form will use it instead
  of guessing."*
- Button **"Copy JSON"**, with status:
  - `Copied. Save it into backend/schemas/ and restart the backend.`
  - error: `Select-all and copy — the clipboard was not available.`
- `<textarea rows="14" readonly>` of pretty-printed JSON, 11px monospace,
  line-height 1.45.

**Design brief:** this is a *developer* artefact appearing inside a *clinician's*
tool, and it is deliberately never auto-installed — a human has to read it and
commit it. It reads as a raw JSON dump today. It is also the one block whose
audience is unambiguously not the doctor, which is worth making obvious.

---

### ▸ Advanced

A `<details>` at the bottom, separated by a top rule, summary styled as a muted
uppercase caption.

- Caption **BACKEND URL**, `<input type="url">`, prefilled with
  `https://breezefill-livid.vercel.app`.
- Muted note: *"Held in memory for this session only. BreezeFill requests no
  storage permission, so nothing here — and no part of the note — is written to
  disk."*

Changing it re-fetches the form bank and re-runs detection. Because there's no
storage, a doctor pointing this at a local backend has to retype it **every
time the panel is opened** — a known and accepted cost of the no-disk rule.

**DEVELOPER ONLY as of 2026-08-17.** The drawer is `hidden` in the markup and
revealed by `panel.js` only when `update_url` is absent from
`chrome.runtime.getManifest()`, which is how Chrome distinguishes an unpacked
install from a Web Store one. A doctor never sees it: the paragraph above
describes a doctor retyping a local backend URL, which is not a thing a doctor
has any reason to do, and pointing the panel at a server that is not there is
the only outcome available to them. The `api-base` input stays in the DOM either
way — only visibility moves — so nothing about which backend is called depends on
the drawer. It is a heuristic, not a security boundary; anything that must not
reach a doctor needs a real check.

---

## 3. The flow, as a state machine

```
panel opens (doctor clicked the toolbar icon on the insurer's tab)
   │
   ├─ GET /forms          → bank loaded, or UNREACHABLE in ①'s status line
   └─ survey the page     → detected-form line resolves to one of 5 states
   │
paste note ──400ms──► POST /parse ──► demographic fields populate,
   │                                  drawer auto-opens if something required
   │                                  is missing (once per paste)
   │
[Map fields] ──► survey page for live questions
             ──► POST /map-live  (10–30s LLM call)
             ──► ② Review appears, ③ Fill's button becomes reachable
   │
review each row; inferred rows must be Confirmed (or edited) before
Fill un-disables
   │
[Fill] ──► values written into the insurer's page, in place
       ──► report renders
       ──► if no schema described the page, ⊕ Draft schema appears
   │
doctor checks each field on the actual form, then submits it themselves
```

Two events can fire at any time:

- **The page changed shape** (a wizard step rendered). A `MutationObserver` in
  the injected script tells the panel. The panel re-runs form detection and, if
  values are waiting, writes "This page changed — press Fill again…" into ③'s
  status. **It never fills on its own.** Nothing is ever written without a
  click — advancing a step is the doctor using the insurer's form, not asking
  BreezeFill for anything.
- **The doctor switches tabs.** Access is per-tab and per-visit (`activeTab`),
  so they must click the toolbar icon again on the new tab. The error copy says
  exactly that.

---

## 4. Complete inventory of user-visible strings

Useful if the redesign restyles or rewrites copy — this is everything a doctor
can see.

**Chrome-level:** action title `Open BreezeFill`; extension name `BreezeFill`;
description `Fills insurer claim forms from a clinical note. Fills in place; never submits.`

**Static:** the header + tagline; the three section headings; every field
caption (INSURER FORM, PASTE THE CONSULTATION, FULL NAME, NRIC, DATE OF BIRTH,
PHONE, POLICY NUMBER, INSURER, ADDRESS, BACKEND URL); the two drawer summaries
(`Other notes (optional)`, `Advanced`); the two placeholders; the four static
notes (pattern-matching, other-notes redaction, page access, session-only URL);
the button labels (`Map fields`, `Choose a different form`, `Check this page`,
`Fill`, `Confirm`, `Copy JSON`); the four badge strings; `— leave blank —`.

**Dynamic:** everything tabulated in §2 under each section's status table, plus
the dynamic `Patient details — …` summary and the review summary line.

---

## 5. Content shapes to design against

Realistic worst cases, not hypotheticals:

- **Field count:** a real AIA GHS claim is 24 fields; Great Eastern's is 15; a
  live page survey caps at 50. Design the review list for **20–50 cards**.
- **Multi-step wizards:** the real AIA ClaimEZ form is 5 steps
  (verification → admission details → patient diagnosis → requested fees →
  review) and the URL does not change between them. So the doctor will map
  once and press **Fill several times**, once per step, with a "N fields belong
  to a later step" report in between. The current UI has no notion of *where
  you are in a multi-press fill* — that's a real design gap.
- **Long values:** free-text diagnosis fields can run several lines; textareas
  auto-size to a 4-row cap and then scroll.
- **Dropdowns:** option text is verbatim from the form, e.g.
  `B1 (4-bedded)` — long strings in a narrow select.
- **Labels:** on print-derived insurer forms, questions look like
  `7. When did the patient first consult you` — long, numbered, sentence-cased.
  Some controls have no label at all and surface as `(unlabelled select)`.
- **Hosts:** `claimez.aia.com.sg`, `www.roboform.com` — long, shown inline in
  status sentences.

---

## 6. Rules the redesign must not break

These are product guarantees, each with a reason. Anything that softens one of
them is wrong even if it tests better.

1. **The extension never submits.** No button may look like a submit button. The
   final message to the doctor is always "check each one, then submit the form
   yourself."
2. **Nothing inferred is written without an explicit confirmation.** No
   pre-confirming, no "confirm all", no design where scrolling past counts as
   reviewing. Editing a value counts as confirming it; nothing else does.
3. **Pending and ready must be distinguishable at a glance**, at speed, while
   scrolling. This is what the amber pending row exists for.
4. **Colour is never the only signal.** Every status is also words.
5. **Nothing may be persisted.** No storage permission exists. No saved drafts,
   no history, no remembered backend URL, no dismissed-onboarding flag.
6. **Nothing fills without a click**, including when the page changes by itself.
7. **A missing schema is not an error state.** The panel must never look like
   it is refusing to work on a form; a schema only sharpens the questions.
8. **Precision over coverage.** The product's stated bet: *"it's much more
   important to get the fields that are being filled right rather than filling
   all the fields up. Doctors don't mind filling additional fields
   themselves."* A blank costs seconds of handwriting; a wrong value gets
   signed and submitted to an insurer. Never design toward a fill-rate number.
9. **No patient data anywhere it doesn't belong** — the panel never echoes a
   server error body, and it names empty fields but never their contents.

---

## 7. Known weak points — the brief, in priority order

My read of where design effort pays off most:

1. **The review list at scale.** 20–50 cards in a 400px column with no
   grouping, no progress indicator that stays on screen, and no way to jump to
   the next unconfirmed row. This is the screen the product exists for and it's
   the least designed.
2. **The 10–30 second mapping wait**, currently a muted one-liner and a
   disabled button. Longest wait, thinnest feedback.
3. **The disabled Fill button never says why.** It's disabled both when rows
   are pending and when nothing is ready — two different situations, no
   explanation on the button itself.
4. **Three status lines that each hold one sentence at a time**, in three
   sections, all `min-height: 1.2em`. Messages of very different severity —
   "Filling…", "Filled 9 fields", "The backend has no API key" — all land in
   the same thin grey slot. There's no error/notice hierarchy.
5. **The fill report** flattens three different kinds of information (what was
   written, what comes later, what you must do by hand) into one bullet list.
6. **Step numbering vs. reality.** Steps are labelled 1-2-3, but 3 is
   deliberately usable before 2 exists, and on a wizard step 3 is pressed
   repeatedly. The linear numbering describes the flow inaccurately.
7. **"No schema matched" looks like a failure** (greyed, same as the genuine
   read error) when it's a normal successful path.
8. **Required vs optional demographic fields is invisible** until Map throws an
   error naming them.
9. **No empty/first-run state.** Opening the panel on a page with no form shows
   the full three-step scaffold with nothing to do and no orientation.
10. **No branding at all** — no logo, no icon set, no illustration, no product
    colour beyond one accent blue. The panel is entirely typographic today.

---

## 8. What actually changes when you press each button

Every transition below is read off `panel.js`; nothing here is inferred. Two
facts govern all of them:

- **There is no `scrollIntoView` and no `.focus()` anywhere in the panel.** No
  press ever moves the viewport or the caret.
- **No section is ever re-hidden once shown.** `hidden = false` is one-way for
  steps 2, 3 and the draft block. The only two-way toggle in the file is the
  override link swapping places with the `<select>`.

### "Map fields"

| Phase | What changes |
|---|---|
| On press | Button → disabled. `#map-status` → `Reading this page, then mapping…` (muted). |
| ~10–30s | Nothing else. No progress, no skeleton, no cancel. |
| On success | `#map-status` cleared to empty. `state.rows` replaced; `edited` and `confirmed` cleared. Step 2 revealed and populated. Step 3 revealed (its Fill button becomes eligible). Button re-enabled. |
| On failure | `#map-status` → the relevant error (see §2). Button re-enabled. Nothing else on screen changes. |

Three problems in that success row:

- **Step 2 appears below the fold** — under a 12-row textarea and two drawers —
  and nothing scrolls. On a real panel the doctor must discover that the thing
  they asked for appeared somewhere off-screen.
- **Step 3 is never cleared.** A previous run's `Filled 9 fields…` status, its
  whole fill report, and the draft-schema block all stay on screen, now
  describing rows that no longer exist. Re-mapping is a normal thing to do
  (fix a typo in the note, re-paste) and it leaves the panel visibly lying.
- **The button never changes.** It says "Map fields" forever; there is no
  re-map affordance and no indication that pressing it discards every confirm
  the doctor has already made.

### "Choose a different form", then the picker

| Press | What changes |
|---|---|
| The link | `<select>` revealed, link hidden. Auto-detection is switched off **permanently for the session** (`formChosenByHand`), including across wizard steps. |
| Choosing an option | `state.schema` is set — and **nothing visible changes at all.** |

The detected line keeps whatever text it had (often still
`Reading the questions on this page (host)`), and choosing a schema **does not
re-map**. If the doctor has already mapped, their new choice has no effect
until they press Map fields again, and nothing on screen says so. This is the
most silent control in the panel.

### "Confirm" (one per pending review row)

On press: `confirmed` gains the field id, then **the entire review list is
re-rendered** — `renderRows()` does `replaceChildren(...)` over every row.

| Changes | Doesn't change |
|---|---|
| That row loses its amber `.pending` background and its Confirm button | The row gets **no positive confirmed marker** — it becomes a plain card, visually identical to an `extracted` row |
| `#review-summary` recomputes (`2 values still to confirm…`) | — |
| Fill may un-disable | — |
| Every *other* row's DOM node is destroyed and rebuilt | — |

That last one is the cost: on a 20–50 row list, every confirm rebuilds the
whole list, losing any focus or caret position and risking a scroll jump. The
doctor's position in a long review is not preserved by anything.

### Typing into a review row's input (which counts as confirming)

On input: `edited` and `confirmed` both gain the field id; the row swaps
`.pending` → `.confirmed` **in place** (no re-render); `updateFillButton()`
runs.

**`renderRows()` is not called, so `#review-summary` is never recomputed.** The
line keeps saying `3 values still to confirm. Nothing is written until you do.`
after the doctor has typed into all three. It only corrects itself if some
*other* row is confirmed via its button. This is a genuine bug, not just a
design gap — and it undercuts the one counter that tells the doctor how much
review is left.

### "Check this page"

| Phase | What changes |
|---|---|
| On press | `#fill-status` → `Reading the page…` (muted). **Button is not disabled.** |
| Nothing mapped yet | Status → `Connected to {host}. Found {n} fillable fields. Map a note to see which ones match.` `#fill-report` is **cleared**. |
| Something mapped | Status → the matched/only-matched sentence. `#fill-report` renders a **full report with `applied: []`** — so each line shows the *matcher's* status (`matched` / `unmatched` / `ambiguous`), not a write outcome. |

That report occupies the same block, in the same visual language, as the
post-fill report — but it means something entirely different: *what would
happen* versus *what did happen*. Nothing on screen distinguishes the two.

### "Fill" — the state the panel spends the rest of its life in

| Phase | What changes |
|---|---|
| On press | `#fill-status` → `Filling…` (muted). **Button is not disabled** — it can be pressed again mid-run. |
| On success | (1) status → `Filled 9 fields. Check each one, then submit the form yourself.` in the **default** status style — no success colour, no icon, the same grey slot that said "Filling…". (2) `#fill-report` replaced with the outcome list, plus the deferred-step note and the unknown-controls list if present. (3) If no schema matched, the draft-schema section appears at the very bottom. |

**That is the entire post-fill state change. Everything else is untouched:**

- **Step 2 does not react at all.** Not one review row shows that it was
  written. A value that just landed in the insurer's form is styled identically
  to one that was skipped or never found. The doctor's immediate question —
  *"which of these did it actually write?"* — is answered only in a separate
  bullet list further down, keyed by label, in a different visual language,
  restating the same 24 fields they just reviewed.
- **The Fill button stays enabled and still reads "Fill."** There is no
  completed state, no "Fill again", nothing marking the action as done.
- The paste box, the patient drawer, the Map button and the form picker all
  stay live and editable, with no signal that changing them now desyncs the
  panel from what is already written into the page.
- Nothing scrolls; the report renders wherever step 3 happens to sit.
- **The panel has no terminal state.** No done screen, no session summary, no
  push toward the actual last action — the doctor going to the insurer's form,
  checking each value, and pressing submit *there*. That instruction exists
  only as the tail of one 12px status line that the next press overwrites.

#### Three post-fill cases the design has to hold

1. **Fill pressed twice** — required on a wizard, once per step, and likely
   anywhere out of uncertainty. `applyPlan` is idempotent, but the *report*
   shifts: `applyText` and `applySelect` rewrite the same value and return
   `filled` again, while `applyCheckbox` and `applyRadio` detect the correct
   state and return `unchanged`. So `Filled 9 fields` can become
   `Filled 6 fields` between two identical presses, with no explanation and no
   indication that both are successes.
2. **Refusal** — status turns red: `Nothing was filled: the page does not match
   the form this schema describes`. But `renderReport` still runs, and with
   `applied: []` each line falls back to the matcher's status. The panel shows
   `Diagnosis — matched` directly beneath "nothing was filled". A visible
   contradiction.
3. **A wizard step renders** — `#fill-status` is overwritten with `This page
   changed — press Fill again to write the fields on this step.`, and the
   previous step's report is left on screen underneath it, describing fields
   that are no longer on the page.

### "Copy JSON"

`#draft-status` → `Copied. Save it into backend/schemas/ and restart the
backend.`, or on clipboard refusal the textarea is select-alled and the status
turns red. The button itself never changes.

---

## 9. Revised priority list

Superseding §7's ordering, now that the transitions are mapped:

1. **The post-fill state is nearly a no-op.** The product's whole payload —
   values written into a live insurer form that a doctor is about to sign — is
   communicated by one grey sentence and a bullet list, while the review list
   that everyone is looking at does not react at all. Design a real completion
   state: which rows landed, which need hand-filling, and what to do next.
2. **Step 2 and the fill report are two representations of one list**, in two
   visual languages, one above the other. They should be one thing that changes
   state, not two lists to reconcile.
3. **The review list at scale** — 20–50 cards, no grouping, no persistent
   progress, no jump-to-next-pending, and a full rebuild on every confirm.
4. **The 10–30s mapping wait**, with a stale step 3 left visible underneath it.
5. **Three status lines with no severity hierarchy**, each holding one sentence,
   each overwritten by the next press.
6. **Multi-press filling (wizards) is unmodelled.** Fill is pressed once per
   step; nothing tracks which steps are done.
7. **Silent controls** — the form picker changes nothing visible; typing into a
   row leaves the summary count stale.
8. **Check vs. Fill reports look identical** but mean would-happen vs. did-happen.
9. Disabled Fill never says why; required demographics are invisible until an
   error names them; no first-run state; no branding or icon set.
