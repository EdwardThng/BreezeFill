# Handoff: PasteFill — Chrome side-panel redesign

## Overview

PasteFill is a Chrome MV3 **side panel** used by Singapore GPs while an insurer's
online claim form is open in the tab beside it. The doctor types the patient's
name, pastes their consultation note, PasteFill extracts the patient's
identifiers locally (no model, no network), the doctor verifies them, a model
then answers the form's clinical questions, the doctor confirms anything that was
inferred, and PasteFill writes the accepted values into the insurer's own page.
**It never submits.**

This redesign replaces a single long scrolling form with a **progressive,
one-step-at-a-time panel**: the panel asks for one thing, waits, then asks for
the next. Finished steps fold into a one-line summary row at the top that can be
expanded (chevron) or reopened for editing. Nothing below the current step is
rendered at all, so the primary call-to-action always sits in the middle of the
panel rather than below three screens of controls.

Two product guarantees drive the visual design and must survive implementation:

1. **Nothing reaches the model until the patient's details are verified.** Step 3
   is a hard gate.
2. **Nothing inferred is written to the page without an explicit confirmation.**
   Confirming is a click or an edit, never a scroll.

## About the design files

The files in this bundle are **design references written as HTML** — prototypes
that show the intended look, spacing, copy and behaviour. They are not production
code to lift. The task is to **recreate these designs in the extension's own
codebase** (`extension/panel/panel.html` + `panel.css` + `panel.js`, vanilla DOM,
MV3) using its established patterns. If you build in a framework instead, keep
every measurement, colour, easing and string below exactly as specified.

MV3 constraints that shape implementation:

- **No inline `<script>` or inline `<style>`.** The prototypes use inline styles
  because that is how the design tool works; production must move these into
  `panel.css` classes.
- **No CDN fonts.** Schibsted Grotesk and the mono face must be bundled as local
  `.woff2` files in the extension and declared with `@font-face`. Both are
  open-licensed (Schibsted Grotesk: SIL OFL; Geist Mono: SIL OFL).
- **No `chrome.storage`, no persistence of any kind.** No drafts, no recent
  notes, no remembered backend URL, no dismissed-tip flags. Closing the panel
  discards everything. This is a privacy guarantee.
- Panel width is whatever the user drags it to. **Design target 400px**; must
  survive 320px → 600px. Height is the browser viewport, one vertical scroll.

## Fidelity

**High fidelity.** Colours, type, spacing, radii, transitions and copy are final
and exact. Recreate pixel-perfectly. Where a value is not stated below, take it
from the prototype file.

---

## Design tokens

### Typography

| Token | Value |
|---|---|
| Sans (all UI) | `'Schibsted Grotesk', system-ui, sans-serif` — weights 400, 500, 600 |
| Mono (captions, values, identifiers) | `'Geist Mono', ui-monospace, monospace` — weights 400, 500 |
| Heaviest weight used anywhere | **500.** Never 600 or 700 in the panel body. 600 exists only in the loaded family for future use. |

Type scale, exact:

| Role | Size | Weight | Line-height | Tracking |
|---|---|---|---|---|
| Product name (header) | 15px | 500 | 1.25 | −0.015em |
| Header tagline | 11.5px | 400 | 1.3 | — |
| Step counter (header right) | 11px mono | 400 | — | — |
| Step title ("Who is this claim for?") | 15px | 500 | 1.55 | — |
| Step subtitle / explainer | 12.5px | 400 | 1.55 | — |
| Field label inside review row | 14px | 500 | 1.55 | — |
| Body / input text | 13.5px | 400 | 1.55 | — |
| Review row input text | 13px | 400 | 1.5 | — |
| Status badge in a review row | 12px | 500 | — | — |
| Field-state label ("Needs checking") | 11px | 500 | — | — |
| Help text under a row | 12px | 400 | 1.55 | — |
| Hint under a CTA | 11.5px | 400 | 1.55 | — |
| Collapsed-step title | 11px | 400 | — | — |
| Collapsed-step summary | 13px | 500 | — | — |
| Section caption (uppercase mono) | 10px mono | 400 | — | 0.08em, uppercase |
| Field caption in verify card (uppercase mono) | 10px mono | 400 | — | 0.06em, uppercase |
| Paste textarea | 12px mono | 400 | 1.6 | — |
| Report key/value | 12.5px sans / 11.5px mono | 400 | — | — |
| CTA button | 14px | 500 | — | — |
| Secondary button | 13.5px | 500 | — | — |
| Small button ("This is right", "Confirm") | 12.5–13px | 500 | — | — |

**Minimum size anywhere in the panel is 10px, and only for uppercase mono
captions.** Body copy never goes below 11.5px.

### Colour

| Token | Hex | Used for |
|---|---|---|
| `--paper` | `#F5F5F4` | Panel background |
| `--surface` | `#FCFCFB` | Cards, collapsed rows, header chip |
| `--field` | `#FFFFFF` | Inputs, textareas, selects |
| `--desk` | `#E9E9E7` | Page behind the panel (prototype only) |
| `--text` | `#1D1D1F` | All primary text, primary buttons |
| `--muted` | `#86868B` | Secondary text, captions, "nothing found" |
| `--muted-strong` | `#6E6E73` | Explanatory paragraphs, tertiary buttons |
| `--line` | `#E7E7E4` | Card hairlines |
| `--line-strong` | `#E3E3E0` | Input borders, panel border |
| `--line-quiet` | `#EAEAE7` | Inner dividers |
| `--line-dashed` | `#DEDEDB` | Dashed border on "nothing found" cards |
| `--btn-line` | `#D5D5D1` | Secondary button border |
| `--confident` | `#157553` | Green: extracted / verified / written |
| `--confident-bg` | `#F1F7F3` | Success banner fill |
| `--confident-line` | `#CFE3D6` | Success banner border |
| `--confident-ink` | `#12603F` / `#2C6B4E` | Success banner heading / body |
| `--check` | `#8A6A28` | Amber: needs checking / inferred / deferred |
| `--check-line` | `#D9C9A8` | Input border on an amber field |
| `--missing` | `#86868B` | Grey: nothing found, fill by hand |
| `--accent` | `#0071E3` | The Fill button, and nothing else |
| `--accent-hover` | `#0062C4` | Fill hover/active |
| `--disabled-bg` | `#EFEFEC` | Disabled CTA fill |
| `--disabled-line` | `#E0E0DC` | Disabled CTA border |
| `--disabled-ink` | `#A5A5A0` | Disabled CTA text |
| `--focus-ring` | `rgba(29,29,31,.06)` | 3px focus ring |
| `--focus-line` | `#B9B9B4` | Focused input border |

Rules: **one accent colour** (`#0071E3`) and it is only ever the Fill button.
**Three status colours** — green `#157553`, amber `#8A6A28`, grey `#86868B` — and
every status is also stated in words, because roughly 1 in 12 men has a colour
vision deficiency and extracted-vs-inferred is the whole reason the review step
exists. There is no red in the panel except backend/error banners
(`#9A2B22` on `#FDF2F1` with `#EBCFCC` border).

### Spacing

Everything lands on a 4px rhythm. Exact values in use:

| Context | Value |
|---|---|
| Panel scroll area padding | `14px 16px 20px` |
| Gap between stacked blocks in the scroll area | `10px` |
| Panel header padding | `13px 16px` |
| Header gap (chip → text) | `10px` |
| Active step card padding | `16px` |
| Active step card internal gap | `12px` (14px on the verify card) |
| Title/subtitle gap inside a card | `4px` |
| Review row card padding | `12px`, `padding-left: 13px` when a 3px left rule is present |
| Review row internal gap | `8px` |
| Collapsed step row padding | `10px 12px`; expanded body `0 12px 11px 36px` |
| Collapsed row gap | `9px` |
| Legend strip padding | `9px 11px`, gap `12px` |
| Input padding | `9px 11px` (review + verify), `11px 12px` (name), `11px` (textareas) |
| CTA padding | `12px 18px`, full width |
| Secondary button padding | `10px 17px` |
| Small button padding | `7px 13px` / `8px 14px` |
| Report row gap | `7px` |

### Radii — concentric

Each nested radius equals its parent minus the padding between them, so curves
stay parallel. Do not deviate.

| Element | Radius |
|---|---|
| Panel | `14px` |
| Active step card | `12px` |
| Card inside a card / collapsed row / review row | `10px` |
| CTA button | `10px` |
| Input, select, textarea, small button | `7px` (9px on the name input and secondary button, 10px on the paste textarea) |
| Header logo chip | `8px` |
| Status dots, ticks, progress bars | `999px` |

### Borders and shadows

- Hairlines are 1px and sit close in value to the fill they separate
  (`#E7E7E4` on `#FCFCFB`), so structure is felt rather than seen.
- The only shadow in the design is the prototype's panel drop shadow
  (`0 1px 2px rgba(0,0,0,.04), 0 12px 32px rgba(0,0,0,.06)`), which exists to
  lift the mock off the desk background. **The real side panel has no shadow.**
- State is carried by a **3px left rule** on the card, plus a coloured word:
  green `#157553` = done/written/confident, amber `#8A6A28` = needs you.
  "Nothing found" cards instead use `1px dashed #DEDEDB` on `#F7F7F6`.

### Motion

| Name | Definition | Applied to |
|---|---|---|
| `pf-rise` | `from { opacity:0; transform: translateY(8px) } to { opacity:1; transform:none }`, `.26s–.32s ease both` | Every block that appears: a new step card (.3s), a collapsed row (.26s), an expanded drawer (.22s), a status banner (.26s) |
| `pf-tick` | `from { opacity:0; transform: scale(.7) } to { opacity:1; transform:none }`, `.3s–.32s ease both` | The green ✓ on a written row and in the success banner |
| `pf-spin` | `to { transform: rotate(360deg) }`, `.7s linear infinite` | 12px spinner ring inside a busy button (1.6px border, top border in the button's text colour) |
| `pf-sweep` | `0% { translateX(-100%) } 100% { translateX(340%) }`, `1.5s ease-in-out infinite` | Indeterminate mapping bar: a 30%-wide `linear-gradient(90deg, transparent, #1D1D1F, transparent)` inside a 3px `#EDEDEA` track |
| Progress bar fill | `transition: width .45s cubic-bezier(.22,.7,.3,1)` | Review readiness bar |
| Button hover | `transition: background .18s ease, border-color .18s ease, color .18s ease, transform .12s ease` | All buttons |
| Button press | `transform: scale(.98)` (CTA `.99`, small buttons `.97`) on `:active` | All enabled buttons |
| Card state change | `transition: background .24s ease, border-color .24s ease, border-left-color .24s ease` | Review and verify cards, so confirming visibly settles rather than snapping |
| Input focus | `transition: border-color .2s ease, box-shadow .2s ease` → `border-color: #B9B9B4; box-shadow: 0 0 0 3px rgba(29,29,31,.06)` | Every input, textarea, select |
| Caret rotation | `transition: transform .22s ease`, `rotate(0deg)` → `rotate(90deg)` | Collapsed-step chevron `›`, drawer carets `▶` |

Respect `prefers-reduced-motion: reduce`: drop `pf-rise`, `pf-tick` and the
`pf-sweep` translation (keep a static 30% bar), keep colour/width transitions.

---

## Screens / views

The panel is one scrolling column with a fixed header. Exactly one step is
"active" at a time; completed steps render as collapsed rows above it; future
steps render nothing.

`step ∈ ["name", "note", "verify", "map", "review", "fill"]`

### Panel header (always visible)

- `flex: none`, padding `13px 16px`, `border-bottom: 1px solid #E7E7E4`, no
  background of its own (`#F5F5F4` shows through).
- Logo chip: 28×28, `border-radius: 8px`, `#FCFCFB` fill, `1px solid #E3E3E0`,
  centred 17×17 SVG mark.
- Title `PasteFill` 15px/500/−0.015em; tagline **"Fills the form in place. Never
  submits it."** 11.5px `#86868B`. The tagline is load-bearing product copy —
  do not cut it.
- Right: step counter, mono 11px `#86868B`, text `Step N of 6`.

**The logo mark** (see `logo-mark.svg`, 24-unit grid, all coordinates on
half-units so edges land on whole pixels):

```
<svg viewBox="0 0 24 24" fill="none">
  <rect x="4.5" y="4.5" width="15" height="16" rx="3.5" stroke="currentColor" stroke-width="2"/>
  <rect x="9" y="2.5" width="6" height="4" rx="2" fill="currentColor"/>
  <path d="M8 12.5h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
</svg>
```

Three densities of one drawing: at ≥20px draw **two** rules (`M8 11.5h8` and
`M8 15h5`) with `stroke-width: 1.6`; at 17–19px draw one centred rule at `y12.5`
with `stroke-width: 2`; at ≤16px one centred rule with `stroke-width: 2.4`.
Toolbar icons: 16/32/48/128 PNG exports, `#3C3C43` on transparent for light
Chrome, `#F5F5F4` for dark.

### Collapsed step row (one per completed step)

- `#FCFCFB`, `1px solid #E7E7E4`, radius 10, `overflow: hidden`, enters with
  `pf-rise .26s`.
- The whole row is a button: full width, padding `10px 12px`, gap 9,
  `background .18s ease`, hover `#F7F7F6`.
- Left: 15×15 green disc `#157553` with a white 9px `✓`.
- Middle: title 11px `#86868B` over summary 13px/500, summary truncates with
  `text-overflow: ellipsis; white-space: nowrap`.
- Right: chevron `›`, 17px, `#A5A5A0`, rotates 0° → 90° on expand.
  **This chevron is the disclosure affordance — there is no "Edit" text button.**
- Expanded body: padding `0 12px 11px 36px` (36px aligns to the summary text),
  gap 7, `pf-rise .22s`; a list of `label` (12.5px `#86868B`) / `value`
  (11.5px mono `#1D1D1F`, right-aligned) rows, then a **"Change this"** button
  (12px/500, `#F5F5F4` fill, `1px solid #E0E0DC`, radius 7, padding `6px 11px`,
  hover `#EDEDEA` / `#D5D5D1`) which makes that step active again.

Summaries and expanded lines per step:

| Step | Collapsed summary | Expanded lines |
|---|---|---|
| Patient | the typed name | Name |
| Consultation note | `{n} words pasted` | First line of the note; character count |
| Patient details | `{n} of 7 verified` | Every non-empty detail, caption → value |
| Clinical questions | `24 questions mapped` | Questions read: 24; Answered: 5 |
| Review | `{n} values confirmed` | Every clinical field with a value |

### Step 1 — "Who is this claim for?"

Card: `#FCFCFB`, `1px solid #E3E3E0`, radius 12, padding 16, gap 12,
`pf-rise .3s`.

- Title **"Who is this claim for?"** 15px/500.
- Subtitle **"Type the patient's name yourself. PasteFill never guesses this
  one."** 12.5px `#86868B`.
- Input: full width, 14px, `#FFFFFF`, `1px solid #E3E3E0`, radius 9, padding
  `11px 12px`, placeholder **"Full name as it appears on the policy"**,
  autofocus.
- CTA **"Continue"**: full width, 14px/500, radius 10, padding `12px 18px`,
  `#1D1D1F` fill / `#FCFCFB` text, hover `#35353A`, active `scale(.99)`.
  Disabled (`#EFEFEC` / `#E0E0DC` / `#A5A5A0`, `cursor: not-allowed`) while the
  name is empty.

Why it is its own step: the patient's name is the one value that is never
inferred, and it seeds the redaction dictionary.

### Step 2 — "Paste the consultation"

- Title 15px/500; subtitle **"Exactly as it sits in your CMS — demographics
  header and clinical note together. Messy is fine."**
- Textarea: `rows="10"`, mono 12px/1.6, `#FFFFFF`, `1px solid #E3E3E0`, radius
  10, padding 11, `resize: vertical`, `spellcheck="false"`, placeholder
  **"Paste here."**
- Below it, a text button **"Use a sample note"** (12px `#6E6E73`, underlined,
  `text-underline-offset: 3px`, hover `#1D1D1F`) — prototype affordance; in
  production replace with nothing, or a dev-only affordance.
- CTA **"Find patient details"**, full width, black; busy label **"Reading the
  note…"** with the 12px spinner; disabled while the note is empty.
- Hint under the CTA, 11.5px `#86868B`: **"Pattern matching on your machine. No
  model, no network, no cost."**

Behaviour: extraction is synchronous local regex work. The prototype fakes 550ms;
production should show the spinner only if the work exceeds ~120ms.

### Step 3 — "Check what was found" (the gate)

- Title **"Check what was found"**; subtitle **"These values are the dictionary
  the note is redacted against. Nothing is sent to the model until this reads
  correctly."** Card gap 14.
- **Legend strip**: `#F7F7F6`, `1px solid #EAEAE7`, radius 9, padding `9px 11px`,
  gap 12, wrapping. Three items, each a 7px dot + 11.5px `#6E6E73` label:
  `Confident` `#157553`, `Needs checking` `#8A6A28`, `Nothing found` `#86868B`.
  **Exactly three colours; no fourth.**
- **Seven field cards** (`gap: 8px` between them), each:
  - caption row: mono 10px uppercase 0.06em `#86868B` on the left, state label on
    the right (11px/500) in the state's colour;
  - input: full width, 13.5px, `#FFFFFF`, radius 7, padding `9px 11px`, border
    `#D9C9A8` when amber, `#DCDCD8` when empty, else `#E3E3E0`;
  - amber cards only: a hint line 11.5px `#8A6A28` explaining the ambiguity, then
    a **"This is right"** button (12.5px/500, black fill, radius 7, padding
    `7px 13px`, hover `#35353A`, active `scale(.97)`).
  - card chrome by state: confident → `#FCFCFB` + `1px solid #E7E7E4` +
    `border-left: 3px solid #157553` + `padding-left: 13px`; needs checking →
    same but left rule `#8A6A28`; nothing found → `#F7F7F6` +
    `1px dashed #DEDEDB`, no left rule.

State labels, exact strings: `Confident`, `Needs checking`,
`Required — type it in`, `Optional — nothing found`.

Field set and demo values (from the sample note):

| Caption | Required | Value | State | Hint |
|---|---|---|---|---|
| NRIC | yes | `S8012345D` | confident | — |
| Date of birth | yes | `14/03/1978` | confident | — |
| Insurer | yes | `AIA Singapore` | confident | — |
| Phone | no | `9123 4567` | needs checking | "Two numbers in the note — 9123 4567 and 6123 4567." |
| Policy number | yes | `GHS-88213004` | needs checking | "Written two ways in the note. Pick the one on the policy." |
| Address | no | `Blk 118 Bishan St 12 #07-21, S570118` | confident | — |
| Occupation | no | empty, placeholder "Not in the note" | nothing found | — |

- Gate CTA **"Details are correct — continue"**, full width, black, disabled
  while any field is amber or a required field is empty.
- Hint below, 11.5px `#86868B`:
  - blocked → `{n} field(s) still need you: {comma-joined lowercased captions}. Press “This is right” on each, or type the value in.`
  - clear → `Nothing has been sent anywhere yet. Continuing sends the note, redacted against these values.`

A field clears its amber state when the doctor presses **This is right** *or*
edits its value. Editing also clears it — the doctor typed it, so there is
nothing left to accept.

### Step 4 — "Answer the clinical questions"

- Title; subtitle **"24 questions read off this page. The redacted note goes to
  the model; your patient's identifiers do not."**
- CTA **"Map fields"** (black, full width). Busy: label **"Mapping…"**, spinner,
  `opacity: .65`, `cursor: default`.
- While busy, below the button (gap 9): a step line 12.5px cycling every 900ms
  through **"Reading the questions on this page…"**, **"Redacting the note…"**,
  **"Matching the note to 24 questions…"**; the `pf-sweep` indeterminate bar; and
  11.5px `#86868B` **"Usually 10–30 seconds. Nothing is written to the page while
  this runs."**
- On success the panel advances to Review. Real call is 10–30s; the prototype
  uses 2800ms.

### Step 5 — Review (only what needs the doctor)

Header card (`#FCFCFB`, `1px solid #E3E3E0`, radius 12, padding `14px 16px`, gap 7):

- Left title 15px/500: `{n} value(s) to confirm`, or `Everything confirmed`.
- Right 12px `#86868B`: `{ready} of 5 ready`.
- 3px track `#E7E7E4` radius 999 with a `#1D1D1F` fill that animates width.
- Note 12.5px `#6E6E73`: pending → **"Only what needs you is listed: inferred
  values to confirm, and questions with no answer in the note."**; clear →
  **"Nothing left to confirm. Fields with no answer stay for you to complete by
  hand."**

**Quiet-rows disclosure** (`#FCFCFB`, `1px solid #E7E7E4`, radius 10, padding
`10px 12px`): a caret `▶` (9px `#86868B`, rotates 90°), a 7px green dot, and
`{n} values taken straight from the note`. Expanded: label / mono-value rows for
each extracted field. **Extracted values are never listed as cards** — the review
list shows only inferred and not-found fields.

**Review row cards** (only inferred + missing), padding 12, gap 8, radius 10:

1. Badge row: badge text 12px/500 in its colour; after a successful fill, a right-aligned
   `✓ Written` chip (11.5px `#157553`, 13px green disc, `pf-tick`).
2. Field label 14px/500 — the schema's human label or the page's own question
   wording, e.g. `7. When did the patient first consult you`. **Raw ids never
   appear.**
3. Optional help text 12px `#86868B`.
4. The control: textarea (13px, 1 row, 3 rows if the value exceeds 44
   characters), or a select whose first option is `— leave blank —` followed by
   the form's own option strings verbatim.
5. **Confirm** button when the row is pending: 13px/500, black, radius 7, padding
   `8px 14px`. It disappears once confirmed.

Badge strings and colours:

| Status | Badge | Colour | Card |
|---|---|---|---|
| inferred, unconfirmed | `Inferred — check this` | `#8A6A28` | amber 3px left rule |
| inferred, confirmed | `Inferred — confirmed by you` | `#157553` | green 3px left rule |
| not found | `Not found — fill by hand` | `#86868B` | `#F7F7F6`, dashed border |
| extracted (in the disclosure only) | `Extracted from the note` | `#157553` | — |

Demo rows: `ICD-10 code` = `J03.90` (inferred, help "Inferred from the diagnosis
wording — the note does not state a code."), `7. When did the patient first
consult you` = `31/07/2026` (inferred, help "The date the patient FIRST consulted
this doctor for this condition, not the latest visit."), `Ward class` = empty
select (missing). Extracted, in the disclosure: `Principal diagnosis` = `Acute
tonsillitis`, `Treatment given` = `Oral amoxicillin 500mg TDS for 7 days`.

Footer CTA: **"Continue to fill"** when clear; **"Confirm the amber rows to
continue"** disabled while any row is pending.

### Step 6 — "Write it onto the page"

- Title; subtitle **"PasteFill has no access to any page until you grant it here,
  one site at a time. It fills; it never submits."**
- Buttons in a wrapping row, gap 8:
  - **Fill this page** — the only accent-blue element: `#0071E3` fill and border,
    white text, radius 10, padding `12px 18px`, hover `#0062C4`, active
    `scale(.98)`. Busy: **"Filling…"** + white spinner, `opacity: .7`. After a
    fill it reads **"Fill again"** and stays enabled (idempotent; a wizard needs
    one press per step).
  - **Check this page** — secondary: `#FCFCFB`, `1px solid #D5D5D1`, 13.5px/500,
    radius 9, padding `10px 17px`, hover `#F0F0EE` / `#C6C6C1`. Read-only survey,
    writes nothing.
- Check status banner: `#F7F7F6`, `1px solid #E7E7E4`, radius 9, padding
  `10px 12px`, 12.5px, `role="status"`, `pf-rise`. Copy:
  `Matched {n} of 11 fields on claimez.aia.com.sg.`

**Post-fill report** (three blocks, gap 10, each a different treatment because
each demands a different response):

1. Success banner: `#F1F7F3`, `1px solid #CFE3D6`, radius 11, padding 12, a 15px
   green disc `✓` (`pf-tick`), heading 13.5px/500 `#12603F`
   `Filled {n} fields on claimez.aia.com.sg.`, and 12.5px `#2C6B4E` **"Check each
   one on the form, then submit it yourself."** — the most important sentence in
   the product.
2. **Written to this page**: `#FCFCFB` card, mono uppercase caption, then
   label / mono-value rows for every field that landed.
3. **Deferred**: `#FCFCFB` card with `border-left: 3px solid #8A6A28`, heading
   12.5px/500 `#8A6A28` `2 fields belong to a later step`, body **"Move to that
   step of the form and press Fill again. Requested fees, Admission date."**
   This is a normal outcome on multi-step portals and must not read as failure.
4. **Fill these yourself**: `#F7F7F6`, `1px dashed #DEDEDB`, heading 12.5px/500,
   body 12.5px `#6E6E73` listing labels, `(unlabelled select)` where a control
   had no readable label.

Additionally, every review row that was written gains a green 3px left rule and
the `✓ Written` chip, so step 5 answers "which of these did it actually write?"
without the doctor reconciling two lists.

---

## Interactions & behaviour

- **Advance only on an explicit click.** No auto-advance on typing, no
  auto-fill on page mutation. When the insurer's page changes shape (a wizard
  step renders), show `This page changed — press Fill again to write the fields
  on this step.` in step 6's status and **never** fill on its own.
- **No `scrollIntoView`, no programmatic `.focus()` except the step-1 autofocus.**
  If a newly-active step lands below the fold, set the scroll container's
  `scrollTop` directly.
- **Editing a value counts as confirming it** — both in the verify gate and the
  review list. Nothing else counts; scrolling past never counts.
- **Re-mapping resets downstream state.** Reopening step 4 and pressing "Map
  again" must clear `values`, `confirmed`, the fill report and the deferred
  block; leaving a previous run's report on screen makes the panel lie.
- **Reopening a completed step** via "Change this" keeps everything already
  entered; the steps after it stay reachable via their collapsed rows.
- Disabled CTAs always explain themselves in the hint line beneath. Never a
  disabled button with no reason.
- Every status line is `role="status"`; every section is labelled with
  `aria-labelledby`; `:focus-visible` gets a 2px outline; the panel supports
  keyboard-only operation (all controls are real `button` / `input` / `select`
  elements).

## State management

```
step        : "name" | "note" | "verify" | "map" | "review" | "fill"
name        : string                     // typed, never inferred
note        : string
finding     : boolean                    // local extraction in flight
fieldVals   : { [key]: string }          // doctor's overrides of found details
acked       : { [key]: boolean }         // "This is right" presses
mapping     : boolean
mapStep     : 0 | 1 | 2                  // which busy sentence shows
mapped      : boolean
values      : { [fieldId]: string }      // doctor's edits to clinical answers
confirmed   : { [fieldId]: boolean }
filling     : boolean
filled      : boolean
checkStatus : string
openDone    : { [stepKey]: boolean }     // expanded collapsed rows
quietOpen   : boolean                    // extracted-values disclosure
```

Derived, never stored: a field's state (`confident` / `check` / `empty` /
`optional`), a row's pending flag (`inferred && !confirmed && value !== ""`),
`ready` count, gate blockers, progress percentage.

Transitions: `name → note` on Continue; `note → verify` after local extraction;
`verify → map` when the gate clears; `map → review` when the model returns;
`review → fill` when no row is pending; `fill` stays terminal, with Fill
repeatable.

Data: `GET /forms` for the form bank, `POST /parse` is **not used** in this flow
(extraction is local), `POST /map-live` for the clinical mapping. Backend URL is
session-only, editable under an Advanced drawer, default
`https://pastefill.vercel.app`.

## Assets

- `logo-mark.svg` — the PasteFill mark, described above. Needs 16/32/48/128 PNG
  exports for `manifest.json` (none are declared today).
- Fonts: **Schibsted Grotesk** (400/500/600) and **Geist Mono** (400/500), both
  SIL OFL, bundled as local `.woff2` with `@font-face`. No CDN.
- No images, illustrations or icon libraries. The only other vector art in the
  panel is the check glyph `✓`, the caret `▶`, and the chevron `›` as text.

## Files

| File | What it is |
|---|---|
| `PasteFill Panel v2.dc.html` | **The implementation target.** The full progressive-disclosure panel with real interaction: name → note → find details → verify gate → map → review → fill, plus the typeface switcher (a design tool, not a product feature). |
| `PasteFill Panel.dc.html` | The earlier single-scroll version, kept for reference on the review list and the fill report. |
| `PasteFill Logo.dc.html` | Logo construction, size ladder, tile treatments, lockups, and the mark shown in the panel header. |
| `PasteFill Theme Directions.dc.html` | How the palette and typeface were chosen (turns 1–5). Turn 5, option 5b is the direction that shipped. |
| `breezefill-panel-ui-spec.md` | The original product spec: every user-visible string, all error copy, the state machine, and the nine product guarantees. Read this for anything the README does not cover. |

Open any of them in a browser; they need no build step. The typeface switcher in
the left rail of the panel file is scaffolding — the shipping panel is Schibsted
Grotesk only.
