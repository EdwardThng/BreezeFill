# Decisions and why

**The domain: linked early, announced late (2026-08-06).** `breezefill.com` was
bought and pointed at the Vercel project. The site was *not* announced, and the
two halves of that are separate decisions with separate reasons.

*Why link before there is anything to show.* Not for marketing — for the
version pin in Traps. `DEFAULT_API_BASE` was
`https://breezefill-livid.vercel.app`, where `livid` is a suffix **Vercel**
generated: it lives in Vercel's namespace, survives only as long as that
project does, and changes if the project is renamed or recreated. Every install
bakes that string in and **no installed extension can be edited afterwards**.
So the window to move the default onto a name we own closes the moment the
first doctor installs anything, which makes this a before-distribution task
rather than a launch task. It is now `https://api.breezefill.com`.

`api.` rather than the apex, though both point at one project today: it leaves
the API free to move — another host, another region, Bedrock for SG-region
inference — without touching extensions already in browsers. The site itself
needed no change at all, being same-origin throughout (`api.ts` resolves
`API_BASE` to `""` in production, `DOWNLOAD_URL` is relative).

*Why not announce.* Written 2026-08-06, when three of four blockers stood.
**Two have since cleared** and the count is now one: the plan is Pro
(2026-08-06), and the privacy policy is live at `/privacy` (2026-08-08).
Inference is still not SG-region, but that stopped being an announce blocker
when the owner put real notes in scope on 2026-08-06 — the policy discloses the
transfer instead of forbidding the data.

**The one that remains is the install**, and it is the whole argument: "download
a zip, enable Developer Mode" is not something a GP will complete, so an
announced site cannot do its one job. That is why next steps 2b — the Chrome
Web Store listing — is the thing standing between here and announcing, and why
the owner chose on 2026-08-08 to submit before the product is otherwise
finished.

*How it is kept out of search, and why not the obvious way.* An
`X-Robots-Tag: noindex, nofollow` header on `/(.*)` in `vercel.json`.
Deliberately **not** `Disallow: /` in `robots.txt`: `Disallow` blocks
*crawling*, not *indexing*, so a blocked URL that anything links to can still
surface as a bare link — and blocking is precisely what stops a crawler from
fetching the page and reading the noindex. The two fight and `Disallow` wins by
making the stronger instruction unreachable. `frontend/public/robots.txt`
therefore allows crawling on purpose and says why.

**To announce: delete the `headers` block from `vercel.json` and redeploy.**
Nothing else changes. `robots.txt` stays as it is.

*State as of 2026-08-08 — **DNS is live**.* Both `breezefill.com` and
`api.breezefill.com` resolve to Vercel (`216.150.1.193` / `216.150.16.193`) and
both answer: `/health`, `/forms`, `/privacy`, the extension download and
`POST /map` were all exercised over plain `curl`. The extension's default
backend now points at a host that exists, which is what unblocked the
"Demoable?" row.

Note for anyone re-checking the records: the address above is **not**
`76.76.21.21`, which is what the older Vercel docs and the previous version of
this paragraph name. Vercel's anycast range moved. Take the target from
`vercel domains inspect breezefill.com --scope breeze-fill` rather than from
memory or from this file.

*A correction to the reasoning above, worth keeping because it was nearly
recorded wrong.* `breezefill-livid.vercel.app` did **not** rot when the project
moved onto the team — `vercel alias ls` shows it and
`breezefill-breeze-fill.vercel.app` resolving to the *same* deployment. One
project simply carries several generated aliases. That weakens the "the URL
changes under you" story and leaves the real argument standing on its own: the
name is in **Vercel's** namespace, so it is theirs to change, and an installed
extension cannot be edited when they do. Do not restate the domain rationale as
"the old URL broke". It did not.

**A privacy policy exists as of 2026-08-06**: `frontend/public/privacy.html`,
served at `/privacy` (`cleanUrls` in `vercel.json` drops the extension, and
the old `/privacy.html` redirects rather than breaking), linked from the
landing footer. Static HTML rather
than a `#/` route on purpose — it is the document a Chrome Web Store reviewer
and a regulator have to be able to read, so it must not depend on the React
bundle rendering. **Live and serving 200 as of 2026-08-08**, once DNS landed.

One thing in it is a claim about the world rather than about this repo, and it
was untrue for a while: the contact address `privacy@breezefill.com`. **The
mailbox is live as of 2026-08-11** — the owner tested it in both directions,
sending and receiving. It had none when the policy went up on 2026-08-06, which
made the policy's own contact line unreachable and blocked the store listing;
this paragraph said so until today.

Keep it monitored rather than merely existing. **Google emails a Chrome Web
Store review decision to the developer account**, so a rejection nobody reads
stalls the submission indefinitely while it looks like it is still queued.

An earlier version of this paragraph said the policy carried a "synthetic notes
only" restriction. **It does not, and must not** — it was rewritten after the
owner's 2026-08-06 override, and now carries a *Real consultation notes*
section saying plainly that there is no test mode and no expectation that the
doctor anonymises anything first. What the policy does instead of forbidding the
data is **disclose the transfer**: a section stating that de-identified clinical
text leaves Singapore, that the PDPA expects a comparable-protection agreement
for an overseas transfer, and that **no such agreement is currently in place**.
Do not soften that paragraph. It is the one that makes the rest of the document
credible, and it is also the one a store reviewer will weigh against the data
disclosures.

`vercel.json` carries no `comment` key next to that block, though it wants one:
an unknown property risks `Invalid vercel.json`, and a config that fails to
parse is a deploy failure this repo has already paid for once (see the BOM
trap).


**The website's claim flow was restructured around the upload (2026-08-18, the
owner's call, same day as the upload path itself).** Three changes and one
consequence:

- **The form picker is gone.** Section 1 is the blank form itself. A doctor
  holding a claim form does not know or care whether this repo has a schema for
  it, and asking them to find their insurer in a list of six is a question the
  file answers. **`CURATED_BY_PDF` in `main.py` is what makes that safe**: an
  upload is hashed against the hand-authored forms' own PDFs first, so sending
  in `aia_ghs_claim.pdf` returns the 24-field curated schema rather than 98
  boxes derived from scratch, and the three overlay forms keep their measured
  geometry instead of having it guessed. It costs no model call and is not
  re-banked. Consequence: **every test about DERIVING a schema must use a PDF
  that is not byte-identical to the repo's** — `not_curated()` in
  `tests/test_upload_route.py` appends a comment after `%%EOF`, which is also
  the realistic case, since a form re-saved by a mail client differs.
- **The notes are asked for by kind**, paste or documents, rather than a paste
  box with a file input tucked underneath. Two normal situations, not a main
  path and a fallback.
- **Several documents, not one.** A discharge summary, an operation record and
  a referral are one consultation's worth of evidence. One unreadable scan
  names itself and the rest still go through.

**The step counter is gone from the panel (2026-08-18, the owner's call).** It
read "Step 1 of 4" in the header's top right. The panel already shows where you
are — each finished step collapses into a one-line summary that reopens it, so
the position is on screen as structure rather than as a number — and the
counter was the one piece of chrome the fork could not be numbered into without
making the work that matters read "Step 2 of 5". `updateProgress()` went with
it: with nothing to write to, it was a function that did nothing, called twice.

Both choices are reversible, and **neither back button discards anything** —
the notes box is the same box in both modes. That is why they are styled quiet
rather than as warnings. The panel has one too, on step 1 only: past there a
name and a note have been entered, and a control that throws those away to
re-ask an answered question is a trap rather than a way out.

The consequence: **`ClaimApp` no longer fetches `/forms` at all**, so a
connectivity failure surfaces on the upload the doctor actually tried rather
than as a banner about a list they never saw. `GET /forms` still exists and
still filters `internal`, but nothing in the website calls it.

**Filenames are never inserted into the note text.** It is tempting to label
each attachment in the box, and a filename like `TanWeiMing_discharge.pdf`
carries exactly the thing pass 2 cannot catch. The names are listed in the UI
and kept out of what gets mapped.

**Doctors get PDFs as well as portals, so the website takes uploads now
(2026-08-18).** The owner's call, from his father and two other GPs: the work
is a *mix* — some claims are filled on the insurer's portal, some are PDFs that
get printed and filled by hand. The extension only ever addressed the first.

**Most of the second was already built and unadvertised.** `#/app` has done
pick-a-form → paste → *editable review* → download-filled-PDF since the claim
store was removed. So the ask — "a way for doctors to edit the outputted filled
PDF, because not all fields may be filled or some fields may be filled not
super accurately" — was already answered, and answered better than asked:
**the values are corrected BEFORE the PDF exists**, not after. That is a plain
HTML form instead of an in-browser PDF editor, and a wrong value never gets
rendered at all. Do not replace it with PDF editing.

What was genuinely missing was the two uploads, and they are now:

- `POST /forms/upload` — a blank insurer form the bank has never seen, read
  into a `FormSchema` by `form_intake.derive_schema`. This is the same move
  `_live_schema` makes for a web page, with a PDF as the source instead of the
  DOM, so nothing downstream can tell the difference.
- `POST /notes/extract` — a note that arrived as a PDF, as text.

**The split that decides everything here, measured rather than guessed.** Of
the seven real insurer PDFs in `forms/`:

| | AcroForm fields | Text layer |
|---|---|---|
| `aia_ghs_claim.pdf` | 98 | yes |
| `ge_ghs_claim.pdf` | 143 | yes |
| the five in `scans_unsupported/` | **0** | **0** |

Five of seven are pure images — nothing to enumerate and nothing to read. Those
are precisely the ones that get printed and filled by hand, because that is
*why* they get printed. They are **refused, with the reason and a next action**
("check the insurer's website for a fillable version, which usually exists"),
rather than half-mapped. `SCANNED_REFUSAL` in `form_intake.py`.

**A raw AcroForm field name is not a label, and often is not anything.** Great
Eastern's own form has `undefined_2`, `undefined_3`, and `Day`/`Month`/`Year`
repeated across four different questions — 143 raw boxes where the hand-written
schema has 15. What each box is for is printed *on the page beside it*, so
`read_widgets` pairs every widget with the nearest text runs (same line to the
left first, then the line above) and the model is given that plus the page's
full text. Expect a messier review screen than the authored schemas produce;
this reads a form nobody has curated.

**The bank keeps what it derives** — the owner's call, and the reason is that
the expensive step is per-FORM, not per-claim. Deriving costs a model call per
page and the answer is identical for every doctor who ever uploads that same
PDF. Keyed by a hash of the PDF's own bytes, so a renamed file is the same form
and a different insurer's form with the same filename is not. See the hard rule
for why this does not breach the statelessness invariant, and `intake_guard`
for the check that keeps it from doing so.

**The insurer is typed by the doctor, never inferred from the filename.** It
reaches the form as a demographic — copied deterministically, skipping both the
model and the review confirm — so a guess there is a wrong value nothing
downstream checks. Same reasoning as the rejected "scan the note for insurer
names" in next steps item 9.

**An attached note is APPENDED to whatever was pasted, never substituted.** A
doctor who pasted a consultation and then attached an operation record meant to
send both, and losing the first is unrecoverable from that screen.

**The extracted note text is shown in the box rather than sent onward.** A
PDF's text layer is not always what the page looks like: columns interleave,
footers repeat, a letter carries the clinic's address. What sits in that box is
what redaction searches through — the same reasoning that keeps the parsed
demographics on screen and editable.

**And the panel now asks which kind of form this is, before anything else**
(the owner's first framing of this whole thread). A fork, not a step: the
portal answer reveals step 1, the PDF answer opens `breezefill.com/#/app` in a
new tab and leaves the panel where it is. `chrome.tabs.create` needs no
permission — `tabs` gates READING a tab's url and title, which this panel
deliberately cannot do. The answer is **not remembered**; `chrome.storage` is
the licence key and nothing else, and a doctor who does portals on Monday and
PDFs on Tuesday is the ordinary case.

**The vision path — built 2026-08-18, and it is what covers the majority of
real forms.** A scanned blank form is rendered page by page, the model is asked
to locate every box on the page, and what comes back becomes a `FieldBox`.
`overlay_fill` needed no change at all: its coordinates were already measured
from the page's **top-left**, which its own docstring explains is because
bottom-left "is miserable to calibrate against a rendered image". Top-left is
how an image is addressed, so the conversion is a multiply with **no flip** —
verified by eye on `henner_prior_agreement.pdf`, with boxes at y = 0.03, 0.25,
0.75 and 0.95 landing at the top, a quarter down, three quarters down and the
bottom.

`backend/vision_intake.py`. Renders at a long edge of 1500px, because Anthropic
resizes anything above ~1568px and larger is tokens spent on discarded pixels.
**JPEG, not PNG** — these pages are photographs of paper and the lossless copy
is 6.5x bigger (1087 KB against 168 KB) for no legibility a model can use.
`MAX_VISION_PAGES = 12` is a cost guard, since every page is a separate call
carrying an image.

**The risk this path has and the AcroForm one does not, and what is done about
it.** A fillable PDF states where its boxes are. Here a model says, and a model
reads a form well and localises only approximately. A box 15pt high stamps the
answer onto the ruled line above, and **the review screen renders that exactly
like a correct answer** — which is the whole problem, because review is where
every other error on this product gets caught.

Two layers, and the second is the one that matters:

- `_to_box` refuses what is obviously impossible: off-page, inside-out, NaN or
  infinity, a box over `MAX_BOX_AREA` of the page (a section, not a field), a
  box too small to write in. A box running a hair past the edge is **clamped**,
  not refused — a field at the page margin is ordinary.
- **`POST /forms/{id}/proof` is the review step for geometry**, and it exists
  because the refusals above cannot catch a box that is merely slightly wrong.
  It returns the doctor's own form with every box stamped with its own field
  id — the same trick `scripts/calibrate_overlay.py --proof` uses on the three
  hand-calibrated forms, and it needed no new fill mode because **the ids are
  the values**. A doctor cannot audit a JSON schema; they can see that
  `date_of_admission` is sitting on the wrong line. The website offers it for
  `fill_mode: "overlay"` only, and opens it in a tab rather than downloading it
  — a proof sheet in Downloads beside the real filled forms is a way to print
  and sign the wrong file.

**A 504 on the first real upload (2026-08-18), and it was a wall-clock bug
rather than a broken one.** A doctor uploaded a blank Great Eastern form that
was not in the bank and got a gateway timeout after the read had finished.

Two things compounded, and neither was visible from any test:

- `vercel.json` capped the function at **`maxDuration: 120`** — not the 300s
  the platform allows.
- **Both derive paths ran one model call per page, in series.** GE's GHS claim
  is three pages of 61, 58 and 24 boxes, each call emitting a line per box, so
  page 2 alone is ~4,000 output tokens. Three of those back to back is minutes.

The pages are independent — that is *why* it is one call per page — so the
series was wall clock spent for nothing. `read_pages_in_parallel` in
`form_intake.py` now runs them together, capped at `MAX_CONCURRENT_PAGES = 4`
so a twelve-page form meets a rate limit instead of a timeout. Measured 3x on a
three-page form. `maxDuration` is 300 for headroom.

Two properties the tests now pin, because both are invisible until they bite:
**a page that raises is skipped rather than fatal** (the docstring claimed this
and only delivered it for model-level refusals — an exception lost the whole
form), and **field order does not depend on which page finishes first**. The
second one matters more than it looks: ids are slugged with a collision
counter, so a form read in a different order each run would attach `date_2` to
a different box every time, and a banked schema would then disagree with the
form it came from.

`test_every_page_is_in_flight_before_any_of_them_finishes` uses a
`threading.Barrier` sized to the page count, so a serial implementation blocks
and fails. Verified by forcing `MAX_CONCURRENT_PAGES = 1` and watching it go
red — a concurrency test that has never been seen to fail is not evidence.

**The lever not pulled: `FORMFILL_DERIVE_MODEL` and `FORMFILL_VISION_MODEL`.**
Both default to `claude-opus-5`, and a cheaper model would roughly halve this
again. Left on Opus deliberately — naming a box wrongly puts a value in the
wrong box on a form a doctor signs, which is the same class of error the whole
product is arranged against. Change it if cost bites, not for speed.

**`unknown form_id: upload_9868ee…` — the bank had been made load-bearing for
CORRECTNESS (2026-08-18).** A doctor uploaded a form, watched it scan, pasted
the notes, filled in the patient, and got a 404 from `/map`. The server had
derived that schema, handed back an id for it, and thrown it away.

The unprovisioned store below is what triggered it, and it was **not the bug**.
The bug is that the bank is a SPEED CACHE and had been wired as the only place
an uploaded schema lived, so a Blob outage, an eviction, or a store nobody
created all produce the same 404 in the middle of a claim — after the doctor
has typed everything in.

**The client carries what the server did not keep.** `/forms/upload` returns
the whole schema alongside the summary; `/map` and `/forms/{id}/pdf` accept it
back, plus the blank PDF itself for the fill. This is the same shape
`/map-redacted` has always used, where the browser sends the page's fields and
the server builds a schema for one request. The bank is now purely an
optimisation, which is what it should have been.

Four rules that keep it safe, all asserted:

- **A carried schema is honoured for an `upload_*` id only.** What
  `aia_ghs_claim` means is decided in this repository, not by a caller.
- **A carried PDF must hash to the key in the form_id.** The key IS the content
  hash, so this is checkable — and without it a caller could pair one form's
  boxes with another form's pages, which on an overlay form stamps answers at
  coordinates measured on a different document.
- **A curated form carries nothing back.** Every deployment has it; shipping a
  schema and a multi-megabyte PDF for it is bytes for nothing.
- **The 404 that remains says what to do** ("send it again"), because the
  caller can fix it and the old message could not be acted on.

Verified end to end over HTTP against a `NullBank` server: the old request
404s, the carried one returns a real filled PDF, and a mismatched PDF is
refused 422.

**The bank was doing nothing in production, and its failure mode is silent by
design (found 2026-08-18).** `vercel blob list-stores` returned *No blob
stores found* and `BLOB_READ_WRITE_TOKEN` was not set, so `build_bank()`
returned `NullBank`: every upload re-derived from scratch, at a model call per
page, and nothing was ever kept. The first real scan a doctor sent in was not
banked.

That is the bank working as specified — it fails open so a storage outage
cannot stop a doctor working — which is exactly why an unprovisioned store is
indistinguishable from a working one from outside. **`GET /health` now reports
`form_bank` as the class name in use.** A name is not a credential, and
`"NullBank"` is the whole diagnosis.

**To turn it on** (owner's terminal — it creates a billable store):
`vercel blob create-store breezefill-form-bank`, then confirm
`BLOB_READ_WRITE_TOKEN` appears in `vercel env ls production`, then redeploy.
Until that is done, everything below about caching is inert.

**A second upload of a known form no longer sends the PDF at all
(2026-08-18).** Caching the schema made the second read cheap; it did not make
it *fast*, because the doctor was still uploading two or three megabytes and
waiting on a round trip proportional to it, to be told something a
32-character string settles.

`POST /forms/known` takes a SHA-256 and returns the schema or a 404. The
browser hashes the file with `crypto.subtle` and asks first; the bytes travel
only on a miss. Measured **2-3ms server-side, and flat across file size** —
0.4 MB and 3.0 MB answer identically, because neither is sent.

Three things to keep true:

- **The hashes must agree across the two languages.** `form_bank.key_for` is
  `sha256(bytes).hexdigest()[:32]`; the browser computes the full digest and
  the server truncates. Verified by computing both on `ge_ghs_claim.pdf` and
  comparing. Change one without the other and every hit silently becomes a
  miss — no error, just the slow path forever.
- **The ask is an optimisation and must never fail the request.** A 404, a
  network fault, anything: `uploadForm` falls through to the real upload. An
  optimisation that can break the thing it optimises is a liability.
- **`/forms/known` and `/forms/upload` must not drift.** A doctor who took the
  fast path has to get the same schema, or the fill disagrees with the review.
  `test_the_answer_matches_what_uploading_would_have_returned` compares them
  field for field.

The full upload route short-circuits on the hash too, before `probe_pdf` runs
— parsing a PDF the server can already describe is work with no answer in it.

**PyMuPDF is a runtime dependency now**, in both requirements files. It was
calibration-only and deliberately excluded until today. `vision_available()`
checks for it rather than assuming, and `refusal_for(probe, can_render=False)`
**defaults to refusing** — a wrong refusal costs a doctor a form, a wrong
acceptance costs them a stamped-on page they cannot see is wrong.

**What is NOT verified, and cannot be from here: whether the model actually
locates boxes well on a real insurer form.** Every test on this path feeds a
stubbed vision client, so what is proven is the plumbing, the refusals and the
coordinate conversion — not the accuracy. The first real run wants a person
looking at a proof sheet for one of the five forms in `scans_unsupported/`, and
that is the thing to do before this is offered to anyone.

Two other things to keep in view. The filled overlay PDF is returned through
the function, and `prudential_accident_hosp.pdf` is 2.82 MB before filling
against **Vercel's 4.5 MB response cap** — the limit with the least headroom in
the whole product. And a scanned form has no AcroForm fields, so
`probe_pdf().already_filled` proves less here than on a fillable PDF: a scan of
a form somebody already completed by hand cannot be detected, and would be
banked. The residual risk is stated in `derive_overlay_schema`.

**The draft schema is gone, and Advanced is the developer's (2026-08-17).** Two
removals from the panel, both the owner's call, and they share a reason: the
panel had two blocks whose audience was not the doctor sitting in front of it.

*The draft schema.* A successful fill on a page nothing described used to hand
back a proposed schema as JSON, for a human to read and commit into
`backend/schemas/`. The human was a GP. Asking a doctor to review JSON is asking
for something they have no reason to be able to do, and the argument that made
the draft safe to offer is the same one that makes it costless to delete: a
schema only ever makes answers *sharper*, never decides whether a question is
attempted, so a form with no schema fills exactly as it did before. `draftSchema`,
`showDraft`, `onCopyDraft`, `HOST_SUFFIXES` and `mappingLive` are all gone, along
with the `step-draft` section. **Schemas are authored from a learn-mode dump
instead**, which is the better input anyway: it reads the page rather than
inferring the form from one claim against it, it covers controls a sparse note
left blank, and it can be taken per wizard step.

What survives the removal is the rule underneath it — see the guardrail. No route
may write a schema to disk from a running claim, and the full-host trap
(`claimez.aia.com.sg` → not `com.sg`) now has to be applied by whoever writes
`hosts` by hand.

*Advanced.* The Backend URL override is a developer affordance that was visible
to every install. It is now `hidden` in the markup and revealed by `panel.js`
only when `update_url` is **absent** from `chrome.runtime.getManifest()`, which
is how Chrome distinguishes an unpacked install from a Web Store one. Three
things about that mechanism worth keeping:

- **It needs no permission.** The manifest answers it directly; `chrome.management`
  would have meant a new permission in the story a store reviewer reads, which is
  a bad trade for hiding a text box.
- **Hidden is the default, both in markup and on failure.** The `<details>` ships
  hidden and the check reveals it, so a panel whose script never ran does not
  flash it, and a `getManifest` that throws leaves it hidden.
- **It is a heuristic, not a security boundary.** Getting it wrong shows a doctor
  a text box — the behaviour that shipped until today. Anything that genuinely
  must not reach a doctor needs a real check.

`api-base` stays in the DOM either way, so only visibility moves and nothing
about which backend is called depends on the drawer being open. **Consequence to
accept:** on a Web Store install there is no way to point the panel at a local
backend, which matters for the RoboForm route (`FORMFILL_SHOW_INTERNAL`) and for
`wizard_test_v1` — both need a local server. Test those on the unpacked copy,
which is what a developer is running anyway.

**Pricing, and the gate that does not exist yet (2026-08-12).** The owner's
call: **SGD 200/month per clinic**, billed through Stripe on the website, with
the extension distributed free through the store during the pilot.

The decision that matters is not the price, it is **how a subscription gates
anything**. Today the extension calls `api.breezefill.com` with no
authentication at all: anyone who installs it uses it free, forever. A
subscribe button in front of an ungated product sells nothing.

Chosen shape: **a licence key the doctor pastes into the panel once, verified
by asking Stripe whether that subscription is active.** Stripe holds the
subscriber list, so the backend gains no database of its own — which matters
because `README.md` says publicly that there is none, and that sentence is
load-bearing for a product asking clinicians to trust it. What it costs: the
extension needs a new version and a second store review.

The alternatives, so they are not re-opened. *Full accounts* — sessions,
password reset, real user records sitting beside a product whose pitch is that
it stores nothing. *Ship the button and gate later* — fastest, but Chrome's
own terms say you **may not collect future charges from users for copies they
were allowed to download for free**, so every pilot install would be
permanently free. That clause is also why the paid tier must be built as an
upsell on top of a free baseline rather than a switch that turns the existing
product off.

Nothing is wired yet. `subscribeUrl()` reads `VITE_STRIPE_PAYMENT_LINK` at
build time, and while it is unset the pricing card says subscriptions are not
open rather than rendering a dead button — a control that looks live and does
nothing is worst on the one that takes money.

**The website redesign (2026-08-12).** The owner supplied a design export and
asked for it to be implemented. It was a **template for a different product** —
the assets in the zip are screenshots of "Bubble Lab", a community-ops tool,
and the BreezeFill copy was that template with nouns swapped. Three of its
claims were false here and were not implemented:

- *"Nothing leaves your browser."* The paste goes to the backend, which is
  where identifiers are found and the note is scrubbed. What is true, and is
  the stronger claim, is that the **model** never sees them.
- *"Free and open source."* Neither, and the same page quotes a price.
- *A save/remember prompt, "saved responses live in browser storage", iframes
  and open shadow DOM.* No `chrome.storage` permission exists, and iframes and
  shadow roots are open unknowns rather than shipped behaviour.

The visual language was taken and the claims rewritten; `Landing.test.tsx`
gained guards for each of the three, because a future redesign pass will
reintroduce them otherwise. What the design dropped and was kept anyway:
`#privacy` and `#faq`. On a page asking a doctor to send clinical text to a
server, deleting the honest disclosure is the worst available trade — and the
store listing points a reviewer straight at it.

Two things about the light theme worth knowing before touching it. **The
accent had to split**: `#3aa0dc` is the logo's blue and it works on a dark
ground, but on the light one it measures 2.76:1 as text and 2.90:1 under white
on a button, both failing AA. So the brand blue is a **fill** (logo, tints,
the hero glow, the pill on the dark band) and a darker `#1a6fb8` carries
anything that has to be read. And **`.landing` and `.demo` no longer share a
token block** — the demo was not redesigned and its stylesheet assumes a dark
ground, so re-merging them breaks `#/demo`.

**Hosting is being revisited (2026-08-04), and the statelessness above is what
unblocks it.** The original single-origin decision assumed the website *was*
the product; it is not any more, so the website (static: landing, demo,
pricing) and the API (Python, needs the key, needs a region) no longer have to
share a host. Two options are open, both now viable:

- **Website on Vercel, API on Fly.** *(Not taken; Fly is gone.)* Lowest risk at
  the time, and the wiring already
  exists — `VITE_API_URL` and `FORMFILL_ALLOWED_ORIGINS` were deliberately
  left in place. Buys: no cold start on the marketing site, and the download
  page stays up when the API is down (it went down with it for ten minutes on
  2026-08-03).
- **Everything on Vercel.** Possible only because the API is stateless now —
  serverless gives no sticky instance, so the old claim store would have 404'd
  every approve.

**Chosen 2026-08-04: everything on Vercel.** (Fly was kept as a fallback for a
day and destroyed on 2026-08-05 — a backend nobody redeploys is a stale build
with a health check, not a safety net.) Prepared
and committed, not yet deployed — it needs `vercel link`, `vercel env add
ANTHROPIC_API_KEY` and a preview deploy, all of which the owner must run.

The limits were checked against the live docs on the owner's **Hobby** plan,
and both earlier worries were out of date:

| | Hobby | Needed |
|---|---|---|
| Function max duration | **300s** default and max | 10–30s Opus call |
| Region | one, **and you choose it** | `sin1` |
| Python bundle | 500 MB | ~50 MB |
| Response body | **4.5 MB** | largest filled PDF 2.82 MB |

Two things to carry forward:

- **The 4.5 MB response cap is the one with the least headroom.** The PDF fill
  returns the file through the function. `prudential_accident_hosp.pdf` is
  2.82 MB before filling. A future insurer form that is a longer scan would
  413 on Vercel. There is no second host to fall back to any more, so check
  the size when adding an overlay form.
- ~~**Hobby forbids commercial use**~~ — **settled 2026-08-06: the plan is
  Pro.** Hobby counted "advertising the sale of a product or service" as
  commercial, donations included, so the planned pricing page put the project
  over the line on any hosting shape — the marketing site is what carries it.
  Pro ($20/month) removes the question rather than answering it, which is the
  point: the alternative was re-litigating "is this commercial yet" at every
  copy change. The 4.5 MB response cap above is unchanged by the upgrade and
  is still the limit with the least headroom.

Favourable detail worth knowing: Vercel bills *active CPU*, and "waiting for
I/O (e.g. calling AI models) does not count". This app spends nearly all its
wall-clock time blocked on Anthropic, so it consumes very little billable CPU.

A FastAPI app on Vercel becomes **one function receiving every path**, so there
are no rewrites in `vercel.json` and the routes work unchanged. Static comes
from `public/`, filled by the build command; hash routing is what makes that
enough, since only `/` has to resolve statically.

Below is the original reasoning, kept because it explains what single-origin
was protecting:

**One app on Fly, not Vercel + Fly.** The frontend is built into the image and
served by FastAPI, so there is one URL and one deploy. This removed the CORS
allowlist and `VITE_API_URL` from the critical path — two fewer things to
misconfigure during a pilot. `FORMFILL_ALLOWED_ORIGINS` still works and is
still wired up, in case the frontend is ever split out again.

**The claim store is gone; the server is stateless (2026-08-04).** It existed
because the website reviewed on one screen and downloaded from another, so
something had to hold the rows in between — with a one-hour TTL, a purge timer,
and the constraint that made `--ha=false` load-bearing (a claim created on
machine A 404s when approve lands on machine B).

`POST /forms/{id}/pdf` takes the final values and returns the PDF in one
request. The schema, not a stored claim, says how each field is addressed, so
nothing needs remembering. The review screen already held every row, so the
client change was one function.

What this deleted, all at once: the retention window (now genuinely zero), the
two-machine trap, the purge timer, and the reason this app could not run on a
serverless host. The remaining reason to pin one machine in `sin` is cost and
data residency, not correctness.

**Singapore region.** Clinical text should not leave SG-adjacent
infrastructure unnecessarily, so `primary_region = "sin"` stays. The app
scales to zero; a cold start measured 5.7s on 2026-08-03, which is fine for
the extension's API calls and poor for a public landing page.

**Field labels live in the schema JSON, not the UI.** Each field carries a
`label` ("ICD-10 code") alongside its `description` (the instruction the model
follows). The review screen renders `label`; raw ids like `icd_code` must
never reach the doctor. `FormField.display_label` falls back to a prettified
id so a half-written schema still renders.

**The dev fixture is hidden, not removed.** `dev_sample.json` has
`"internal": true`; `GET /forms` filters it out so a doctor is never offered a
fake form, but claims can still be created against `dev_sample_v1` by id,
which is what the API tests do.

**Precision over coverage — this is the product's core bet.** The owner's rule
(2026-07-30): *"it's much more important to get the fields that are being
filled right rather than filling all the fields up. Doctors don't mind filling
additional fields themselves."* A blank costs the doctor seconds of
handwriting; a wrong value gets signed and submitted to an insurer as their
own clinical statement. So never tune for fill rate. If a change would fill
more fields at any cost to correctness, it is the wrong change. `SYSTEM_PROMPT`
states this asymmetry explicitly and holds `inferred` to what a clinician
would conclude without hesitation. `docs/testing/test_notes.md` case 5 is the
regression check: a one-line note should come back almost entirely `missing`.

**A field's stated date format beats the global one (2026-08-05).** Found by
running a real claim through production: the AIA form came back with
`14/03/26` in two boxes and `14/03/2026` in two others. Every date description
in `aia_ghs_claim` asks for `DD/MM/YY` — its boxes are small — while
`SYSTEM_PROMPT` mandated `DD/MM/YYYY` absolutely. AIA GHS is the only schema
wanting a short year, so the rule was right for four forms and wrong for one,
and the model resolved the contradiction differently field by field.

The prompt now defers to the field, and `_apply_date_format` **enforces** it
rather than trusting the model to comply. It only ever drops the century, and
only where the field asked for a short year, which is lossless. It never
expands: choosing between 2026 and 1926 for "26" is a guess, and a claim form
carries dates of birth as readily as dates of admission. A field wanting a full
year that receives a short one keeps what the model returned and reaches the
doctor in review.

**An ambiguous date is confirmed by the doctor, whatever its status
(2026-08-05).** The owner's call. `needs_review = status != "extracted"` asks
"did the notes say this", and for a date that is the wrong question: a note can
state `03/07` perfectly clearly and still not say whether it meant 3 July or
7 March. Nothing downstream can separate the two — the note is the only
evidence and the note is exactly what is ambiguous — so this is not a check the
pipeline can do on the doctor's behalf.

**Ambiguity is the trigger, and it has a hard boundary (narrowed same day).**
A day over 12 cannot be read as a month, so `25/07` says one thing to
everybody and is not held. Asking the doctor to confirm it would be asking them
to check something with one answer, and a confirm click that is never the
interesting one is how the ones that are get skimmed past — `aia_medical_report`
has 22 date fields. Two cases still held on purpose: a day under 13 with a
month over 12 (`03/25`) is not ambiguous but *is* written the wrong way round
already, and the row's own sentence is the correct thing to say about it; while
a value that is not a `d/m/y` string gets no recheck at all, because the
sentence would be describing nothing.

It is also the one place the usual asymmetry inverts. Everywhere else a wrong
answer is a *blank* the doctor notices; a swapped date is a **plausible wrong
answer that looks right**, signed and sent as their own statement of when the
patient was admitted.

Four things that are deliberate and easy to undo by "simplifying":

- **Rows carry a `recheck` reason, not just the flag.** A held date whose badge
  reads "Extracted from the note" above a bare Confirm button tells the doctor
  there is nothing to check. Both review surfaces render `recheck` *instead of*
  the status note.
- **Only dates that carry a value are held.** A blank is written by hand
  anyway, so holding it asks the doctor to confirm nothing.
- **Demographic dates are held too** when ambiguous, and they have the least
  excuse for being trusted: `parse_demographics` resolves DD/MM by *rule*
  (Singapore writes day first), with no model and no `source` snippet, so a note
  written the other way round is misread silently and identically every time.
  This is the one exception to "demographic = pre-approved green".
- **The website's "Confirm all" cannot reach a date.** A bulk button confirms a
  swapped date exactly as fast as a correct one, which is the failure the row
  was added to prevent. Its count says how many it will actually clear, and it
  disappears when that is none.

Both surfaces spell the value out under the box — "3 July 2026 — or 7 March
2026 if the notes wrote the month first" — and keep it in step as the doctor
edits, because a correction they cannot see take is not a correction. The rival
reading is offered only when the day is ≤ 12; 25/07 has one reading, and a
second one that cannot exist is noise that makes the real warnings skimmable.
Neither expands a two-digit year, for the same reason `_apply_date_format`
refuses to. An unambiguous date is still spelled out — a doctor scanning the
list should not have to parse digits — it is simply not held.

The demo's consultation is dated **3 July** rather than the 14 March it was
first written with, and that is load-bearing: 14/03 is unambiguous, so the
walkthrough's one illustration of this rule would no longer trigger it.
`Demo.test.tsx` asserts the day is ≤ 12 rather than asserting the literal date,
so the note can be rewritten without silently losing the demonstration.

**Still open:** the owner's spec says "date always follows dd/mm/yyyy". That
most likely means *day-first when reading a note* (so `08/02/2001` is 8
February), which is about input and does not conflict with the above. If it
means output must always carry four digits, `aia_ghs_claim` needs rewriting and
its boxes may overflow. Confirm before changing anything here.

**Doctors confirm, they don't just read.** Anything not directly `extracted`
requires an explicit confirm click before the PDF can be generated. Editing a
value counts as confirming it. Do not "helpfully" pre-confirm inferred fields.

**The parser must not require a house style (2026-08-08).** The owner's call,
and it corrects an assumption the code had quietly made: *"Doctors take notes
in many different ways so the parser should be able to take the relevant
details out of the notes regardless of the format."*

Found by running the panel's own sample note through `parse_demographics` and
getting back **one field**. `LABELLED_LINE` needs `Label: value` anchored to
the start of a line; a real note writes `NRIC S8012345D  DOB 14/03/1978` — two
fields on one line, no colon on either — and matched neither. The date of birth
was unrecoverable, because a date is never taken from unlabelled prose (a
clinical note is nothing but dates) and there was no label the rule could see.

A label is now read **anywhere in a line**, kept safe by two constraints:

- **The shape confirms the value.** Only fields with a shape take part — NRIC,
  phone, policy number, date. The label says *which field*; the shape says
  whether what follows is really one, so `Policy discussed with patient`
  contributes nothing. Name and address are excluded from this pass entirely:
  they have no shape, so there would be nothing to check a guess against.
- **A label must open a field**, meaning it starts the line or follows a
  separator. Without this, `Clinic tel 62551234` reads as the patient's phone
  — the clinic's own number, under the doctor's signature, written onto a
  claim as theirs. `test_two_phone_numbers_means_neither` caught exactly that
  on the first attempt, which is the reason the rule exists. The same shape
  covers `Next of kin phone`.

Two candidates behind one label still yields neither, exactly as unlabelled
prose does. The refusals are unchanged; only the reach is wider.

**A shape has to be a whole token, not the tail of one (2026-08-08).** The
collision this fixes: `Policy GHS-88213004` came back with the policy number
*and* a phone number of `88213004`. Eight digits opening with an 8 is a valid
Singapore mobile, so the unlabelled-prose pass claimed the policy number's
tail — a wrong value in a shaped field, and the worst kind, because
demographics are copied onto the form deterministically and so bypass both the
model and the review confirm. It fires on any note with one such policy number
and no phone, which is an ordinary note.

The rule is `PHONE_IN_TEXT`: a phone must be delimited by something that is not
identifier material — no letter, no digit, none of the connectors (`-` `/` `#`)
that bind a reference together. Read the whole token first; if the digits are
only part of it, they are not a phone number.

Two things about it that look like inconsistencies and are not:

- **`SG_PHONE_PATTERN` in `redaction.py` is deliberately left blunt.** It
  guards only against a longer *digit* run, which is all redaction needs:
  redaction blanks what it matches, so over-matching there costs nothing and
  under-matching is a leak. Only the module that *assigns a value to a field*
  needs the stricter question. Do not "unify" the two patterns.
- **It is not applied to `NRIC_PATTERN`.** A phone number is never embedded in
  a reference, but an NRIC in one (`REF-S8012345D`) is still the patient's, and
  refusing it would lose a correct value to avoid a collision that does not
  happen. `test_an_nric_inside_a_reference_is_still_the_nric` pins it.

Why three suites never saw it: the fixtures use `GHS-4471902` (seven digits)
and `GE-88213` (five), and the panel's own sample note happens to carry two
policy variants, so the sole-match saw three candidates and refused. It was
masked everywhere it was exercised. A useful generalisation — **a refusal is
not evidence of a working rule.** Both of these look identical from a test that
only asserts `is None`.

**One paste box, and the split is done by patterns — never by a model.** The
owner's call (2026-08-03): seven inputs and a note box collapse into a single
textarea; the doctor pastes the consultation as it sits in the CMS.

The question that actually mattered was who does the splitting, and the answer
is not a style preference. **`redaction.py` pass 1 uses the demographics AS THE
DICTIONARY** it scrubs the note with, because a name has no shape for a regex
to find. A model asked to split the block would have read the patient's name
and NRIC *before any dictionary existed* — and the note could no longer be
scrubbed of the name either, because nothing would know what it was. The
ordering is the privacy model, not a preference. `backend/demographics.py`
does it with the patterns `redaction.py` already defines.

What it refuses to do is most of the design, and it is the same bet the rest
of the product makes:

- A labelled line is believed. A shape in unlabelled prose is believed **only
  when it occurs exactly once in the whole paste** — every note in
  `docs/testing/test_notes.md` carries the clinic's own phone number under the
  doctor's signature, so two candidates means neither is returned.
- **A date of birth is never taken from unlabelled text.** A clinical note is
  nothing but dates: consultation, admission, discharge, MC.
- **A name is never guessed at all**, from anything.
- Compound patient lines are split by segment, because that is how the pilot
  writes them: name, NRIC, DOB, phone, address, policy on one middot-separated
  line — which also *wraps*, so continuation lines are rejoined when the
  previous line ends in a separator.

The parsed fields stay on screen and stay editable, in a drawer that opens
itself when something required is missing. They are not a summary: they are
what redaction searches for, so a name that arrived wrong there is a name left
in the text that goes to the model.

It lives on the server rather than in the panel for the same reason redaction
does — a JavaScript copy of those patterns that drifted from the Python one is
a leak.

**Auto-filling demographics from the clinic CMS was investigated and
deferred.** Recommendation stands: paste-and-parse (extract NRIC/DOB/phone
from one pasted block using the regexes already in `redaction.py`) before any
CMS integration. If integration happens, it must run *inside* the clinic — a
local agent or browser extension — never a hosted server holding standing
credentials to a patient database. See conversation history for the full
comparison (ClinicAssist / Assurance Technology, NEHR via Synapxe GPConnect).

**Insurers increasingly send a link, not a PDF — so a third fill target is a
browser extension.** AIA's ClaimEZ mails the doctor a tokenised link
(`https://claimez.aia.com.sg/doc/?pid=<uuid>`) to a JS-rendered form filled and
submitted in the browser. A filled PDF is the wrong artefact for that channel.

Routes considered and closed (2026-08-01), so they are not re-opened:

- *Print, hand-fill, scan back in* — more friction than the product removes.
- *Download the PDF from ClaimEZ and use the existing pipeline* — the download
  only appears **after** submission. It is a receipt, not an input.
- *Any other submission route (email the PDF, upload elsewhere)* — the owner's
  call, and the stronger argument: the link is what the insurer handed the
  doctor, and moving them off it adds friction rather than removing it. **The
  submission channel is fixed. Fill the channel the doctor was given.**
- *Iframe the portal inside BreezeFill, or have the server open the link* — CSP
  blocks the first; the second makes the server hold a bearer credential to a
  patient's claim.

So: `extension/`, a third `fill_mode` alongside `acroform` and `overlay`. Fill
in place, never submit — the doctor still clicks submit and signs.

**The `?pid=` in a ClaimEZ link is a bearer credential.** Anyone holding the
URL gets a page pre-populated with the patient's name, NRIC and policy number.
It is not an id, it is a password. Never log it, never paste it into a
transcript, never let it into an authoring artefact. `extension/learn/dump.js`
records the **host** only, for this reason.

**Learn mode has no demographics dictionary, so it cannot scrub names.** This
is the trap that shaped `extension/learn/dump.js` and it will catch anyone
extending it. The scrubber finds identifiers *by shape* — NRIC, phone, email,
digit runs. A name has no shape: `Tan Wei Ming` is indistinguishable from
`Tan Tock Seng` by regex. `redaction.py` only handles names because pass 1 has
the demographics the doctor typed in; on an insurer's page nobody has typed
anything. Consequences, both of which look like over-caution until you see the
page:

- Section and step text come from `<legend>` only, never `<h1>`/`<h2>`/prose.
  A claim page heading reads "Claim for &lt;patient&gt; (&lt;NRIC&gt;)".
- If scrubbing changes *any* option in a list, the whole list is withheld. A
  policy picker reading `80123456 — Tan Wei Ming — GHS` has a shaped number
  next to an unshaped name, so partial scrubbing emits the name.

A dump gets pasted into a model to draft a schema, which makes it an LLM input
and subject to the same rules as clinical text. See `extension/README.md` for
the residual risks that remain.

**The product is the extension; the website is not the surface.** The owner's
call (2026-08-03). The doctor pastes into a side panel next to the insurer's
form rather than into a separate site.

The justification worth keeping is not "the forms arrive on insurer websites" —
that argues only for an extension existing, which was already settled. It is
what the pivot *deletes*. With a separate website the note lives on origin A
and the form on origin B, so the design needed `externally_connectable`, a
handoff protocol, a claim id to correlate the two, and a **server-side session
to hold the claim between "typed the note" and "filled the form"**. Put the
paste area beside the form and none of that has a reason to exist.

Hence `POST /map`: same review rows, no claim id, nothing stored, nothing to
purge. Retention is zero — and as of 2026-08-04 the PDF path works the same
way, so this is no longer a property one path has and the other lacks. `redact →
map → assemble` lives in `_review_rows` so both endpoints share one path — a
second caller that reimplemented it is how a route that skips redaction gets
introduced.

**The website's job is now to hand out the extension** (2026-08-03). The owner's
call, and the completion of the pivot above: `#/` is a landing page, `#/demo` is
a walkthrough, and the download button serves `extension/` zipped from the
source tree.

Three things decided while building it that are easy to undo:

- **The claim UI was moved, not deleted.** Deleting it would have taken the
  five PDF forms with it — they are real forms doctors still receive and this
  is their only interface. It lives at `#/app`, unadvertised.
- **The demo talks to nothing.** No fetch, no model, every value written into
  `Demo.tsx`. It therefore works while the machine sleeps and cannot be spoiled
  by a bad generation. Do not "improve" it by wiring it to the live API.
- **The demo will not let you skip the confirm step**, and the field the note
  cannot answer stays blank in the filled form. Both are asserted. A demo that
  glossed over either would teach a doctor the wrong thing about what they are
  signing, which is worse than having no demo.

The landing copy is held to the same standard: `Landing.test.tsx` fails if the
page ever claims to be fully automatic or to need no review. The product's
pitch is a set of refusals, and marketing copy is where those get softened.

What did **not** change, and must not:

- **"Fully an extension" does not mean serverless.** The API key cannot ship
  in an extension; a packed `.crx` is a zip. The backend stays.
- **The review step moves, it does not disappear.** Anything not directly
  `extracted` still needs an explicit confirm before it is written into the
  portal. The pivot must not quietly become fill-then-eyeball.
- **The five PDF forms stay.** Not every insurer sends a link, and they work.
  What stops is *investment in the website*, not the acroform/overlay paths.

~~Redaction stays server-side for now.~~ **Done — redaction moved into the
browser, and this paragraph described the world until 2026-08-17.** What it
called "strictly better" is what now happens: the demographics never leave the
tab, `/map-redacted` receives no `PatientRecord`, and a log or a crash dump on
the server cannot contain a patient's name because one was never sent.

The objection it raised was the right one and was answered rather than
accepted. Two implementations of one rule do drift, so:

1. **The shapes are not written twice.** `extension/privacy/patterns.json` is
   read by `redact.js` and by `redaction.py`. Editing one file changes both.
2. **`tests/fixtures/redaction_corpus.json` runs against both** — 12
   adversarial cases, same notes, same assertion that no identifier survives
   and that the clinical content the mapping call needs does.
3. **The server redacts again** on text the browser already redacted, and
   discards its own map. A miss in the browser is then a bug rather than a
   disclosure — *except for a name*, which pass 2 cannot catch. See the hard
   rule about pass 3.

What is genuinely duplicated is pass 1's regex construction (`nameRegexes`,
`dobRegexes`), which is hand-ported. `redact.js` exports both for the tests
that check the two languages agree; keep that export.

The one thing browser redaction cannot fix is that an extension updates on
Chrome's schedule. `MIN_EXTENSION_VERSION` in `main.py` is the answer — raise
it and every older panel refuses to map *before* it redacts. Raise it only for
a fault that makes the old build unsafe.

**The extension holds no standing access to anything.** `manifest.json`
declares no `content_scripts`, no default `host_permissions`, and — this is
the easy one to undo by accident — **no `tabs` permission**, which would expose
every tab's address. `panel.js` therefore never learns what site it is on; it
finds out from the injected script's own `location.host`, after the doctor
granted `activeTab` by clicking the toolbar icon on that tab. Consequence to
accept rather than route around: opening the panel on one tab and switching to
another means clicking the icon again. `optional_host_permissions` is declared
but not yet requested — it is there for the `MutationObserver` work, which
needs access that survives a wizard step.

`chrome.storage` holds the licence key and nothing else (2026-08-17): patient
notes must not reach disk. This is also why `background.js` is nearly empty —
a service worker acting as a message broker is evicted after ~30s idle, so it
would have to persist the note to survive. State lives in the panel.

**Superseded 2026-08-05 — the bank is no longer a gate.** The owner's call,
after seeing the real ClaimEZ form: *"there's no need to check if the current
form being filled is already in the bank, because the doctors will have to
submit a filled form online regardless."* That reframes what identification was
ever for. The doctor must submit the form on their screen whatever this
repository knows about it, so the answer to "is this in the bank" can only
change **how well each question is answered**, never whether they are
attempted.

So there is now **one path**: every fillable control on the page becomes a
question to map. A schema that fits lends its `description` to the controls it
describes; a schema that does not fit costs sharpness and nothing else. No
picker to get past, no fallback to opt into, and no state in which the panel
looks at a form it declines to fill. `mappingLive()` survived as a *report* —
"did the bank describe any of this" — gating only the draft-schema offer, and
**went with it on 2026-08-17**: with nothing left to gate, a helper answering a
question nobody asks is a thing to delete rather than keep.

**The privacy property was kept, not traded.** A described control travels
under the *schema's* wording rather than the page's, so a page the bank fully
describes sends exactly what the old schema route sent. Only questions nothing
describes carry their own labels out, which is the irreducible cost of
answering them at all. The join runs in the page (`locate.enrich`), so schema
instructions reach controls without page structure being sent anywhere to
arrange it.

**What one path quietly broke, found 2026-08-09: demographics were never
filled.** `_live_schema` stamped every control `source="llm"`, and the
consequence was not a weaker answer to "Patient's Full Name" but **no answer at
all** — demographics are exactly what redaction strips first, so the model read
`[PATIENT]` and correctly returned `missing`, while the value sat in the
`PatientRecord` the whole time. Every claim on the extension's only path left
the name, NRIC, date of birth, phone, address and policy number blank.

The name is the sharpest case and the reason this is not a coverage
nicety: **it is required at step 1 of the panel, so it is always known**, and
it was the one field guaranteed to come back empty. The others are conditional
on being known — which is the right condition, and now the one that applies.

`_live_sources` resolves a control's label through
`demographic_field_for_label`, which is exact against the alias table
`demographics.py` already owns, so the note parser and the form reader cannot
drift apart. Three refusals guard it, and they matter more than the fills
because a value assigned this way skips the model and reaches the doctor
already green:

- **An unrecognised label stays `llm`.** The qualifier list is an allowlist, so
  `Hospital name`, `Doctor's name`, `Employer name` and `Name of attending
  physician` resolve to nothing while `Patient Name`, `Name of Patient` and
  `Full name` all resolve.
- **A control inside a repeating entry is never demographic.** `instance` means
  the question is asked once per entry — several dependants, several admissions
  — and one patient record cannot answer the second one.
- **Two controls wanting the same demographic yields neither.** A form with
  "Name" in the patient block and "Name" again in the physician block cannot be
  told apart from the label, and filling both writes the patient's name into
  the doctor's box. The same refusal `locate.js` makes over three identical
  "Date Of Birth" labels.

**It moves data away from the model, not toward it.** This reads backwards
until you check `map_fields`, which sends `schema.llm_fields`: recognising a
control as demographic *removes* its question from the grammar and the prompt.
`test_a_demographic_control_is_not_sent_to_the_model` asserts it.

`schemaFieldsOf` in the panel still filters demographics out of enrichment, and
that stays correct on its own terms — a demographic field has no `description`
to lend. It is simply no longer the whole story.

**The limit, found by a test that expected to pass.** Enrichment matches by the
same label scorer filling uses, and it compares words rather than meaning:
"7. When did the patient first consult you" and "Date of first consultation"
are the same question, share one content token, score 0.22, and do not match.
It fails safely — the control is still filled from its own label, just without
the sharper instruction — but it means **a web schema wants labels authored
from the page's own wording**, which is what the draft-schema flow produces,
rather than from the labels of the equivalent PDF form. Do not assume
`aia_ghs_claim`'s labels will enrich the ClaimEZ page; they were written for a
PDF.

Below is the superseded three-step design, kept because steps 2 and 3 are still
exactly what happens — what changed is that step 1 stopped being able to stop
anything:

**The bank, then the page. And filling an unknown form produces the schema
that replaces it.** The owner's design (2026-08-03). Three steps:

1. **Is this form in the bank?** Answered by *fingerprint*, not by reading an
   id out of the markup. Every schema is scored against the live controls and
   the best fit wins — which asks "does this page carry the fields this schema
   describes", the thing that actually matters, instead of a version string
   that rots at the insurer's next deploy. Host matching still runs first and
   narrows the shortlist; it cannot settle it, because an insurer serves
   several forms from one domain. A tie is not a winner.

   Identification runs at *looser* thresholds than filling (`IDENTIFY_MIN_RATE
   = 0.4` vs `MIN_MATCH_RATE = 0.7`) and that is safe rather than sloppy: a
   wizard shows one step at a time, so the right schema may only find a third
   of its fields on the page in front of us. Whatever is picked still has to
   clear the fill guards before a value is written. Identifying is choosing
   what to *try*.

2. **If nothing fits, map against the page itself** — `POST /map-live`. The
   field list comes off the live controls; same redaction, same review rows,
   same confirm-before-write. Offered only when nothing in the bank fits, and
   never the default, because it is **strictly weaker**: a schema's
   `description` is the instruction you would give a colleague ("the date the
   patient FIRST consulted this doctor for this condition, not the latest
   visit") and a page can only supply the question as it is worded.

   The cost was accepted deliberately and is the one thing the schema path was
   built to avoid: **page structure becomes an LLM input on every claim mapped
   this way.** Labels are scrubbed twice — once by `dump.js` in the browser,
   once by `scrub_patterns` on the way in — and it still cannot catch a name,
   because a name has no shape. `test_a_name_in_a_label_is_the_known_hole`
   asserts the failure so nobody rediscovers it by accident.

3. ~~**A successful schema-free fill hands back a draft schema**~~ — **removed
   2026-08-17. See "The draft schema is gone" below.** It was a proposal for a
   human to read and commit, never installed or auto-PR'd, and it appeared while
   the page that produced it was still on screen. What ended it was the audience:
   the human reading it was a GP, and the reason it was safe to offer at all —
   that a schema only ever makes answers sharper — is also the reason nothing was
   lost by deleting it.

Two traps found while building it, both in the draft:

- **`hosts` gets the full host, never a guessed registrable domain.** "The
  last two labels" of `claimez.aia.com.sg` is `com.sg`, and `hostMatches`
  matches subdomains — that schema would have claimed every commercial site in
  Singapore. Widening it by hand is a one-word edit; a schema that silently
  claims a TLD looks correct in review.
- **The draft includes fields this note left blank.** A schema describes the
  form, not one claim against it. Dropping the blanks would stop a later,
  fuller note from ever filling them.

**Screenshots and a VLM were considered for step 2 and rejected (2026-08-03).**
The argument that settled it is not the privacy one, though that holds too — an
insurer's claim page arrives pre-populated, so a screenshot of it is a picture
of the patient's NRIC, and every pass in `redaction.py` operates on text. The
stronger argument is that **a screenshot redacted enough to be safe contains
less than the dump already does**: you would have to black out every control
(they hold patient values) and every heading and paragraph (names have no
shape), leaving labels and layout — and labels are already extracted, scrubbed,
with the layout question answered by rule 6. The increment a screenshot buys
over the dump is essentially the prose, which is exactly the part that carries
the name. A VLM would also return *coordinates*, and mapping those back through
`elementFromPoint` trades a reliable locator for an unreliable one when the DOM
is already in hand. Use a model for meaning, the DOM for location.

**The filler is hybrid: live structure locates, the schema means.** The owner's
design (2026-08-01). The extension reads the form structure *at fill time*
rather than trusting a selector map authored months earlier, which is what
stops the map rotting when an insurer redesigns. But the live page cannot
supply *meaning*: with structure alone, the model's whole instruction for a
field is whatever text the page renders — sometimes `4a`, sometimes a truncated
string — and it would be inferring what an unfamiliar field wants before a
doctor signs the result. So the schema still supplies each field's
`description`, and the two are joined by label text (`extension/fill/locate.js`).

Two consequences worth keeping:

- **Page structure never leaves the browser.** The server sees the schema (no
  patient data) and the redacted note, and returns values keyed by field id,
  exactly as today. Locating happens client-side where the structure already
  is. A pure live-read design would have made page structure an unreviewed LLM
  input on *every* claim; this way that path does not exist.
- **A live field with no schema match is left blank**, and reported as a
  schema-authoring candidate. Precision over coverage, applied to matching.

`MIN_MATCH_RATE` is the important knob: below it the filler writes *nothing*
rather than filling the part that still matches, because a partial fill is
indistinguishable from a complete one to someone reviewing quickly. Confirmed
in a real browser on 2026-08-03 — an AIA GHS plan against RoboForm's 39-field
test page filled nothing.

**`MIN_MATCHED` guards the other end, and is not optional.** A ratio clears
trivially on a small plan: one ready field scoring against one label anywhere
is a match rate of 1.0. A sparse clinical note produces exactly that plan —
mostly `missing` rows and two or three values — so it is the common case, not
a corner. Both guards apply, never either: the rate says the page has the
schema's shape, the count says there is enough evidence for the rate to mean
anything. Consequence to accept: a note that yielded one or two values gets no
autofill at all.

## Design decisions not yet resolved

*Open on purpose. Each was left rather than guessed, and each names what would
settle it. Do not close one by picking the convenient side in passing.*

**`locate` and `enrich` disagree about a collision, and only one of them can be
right (2026-08-11).** Both join labels with the same scorer, the same
`MIN_SCORE` and the same `TIE_MARGIN`, and since the enrichment fix both assign
strongest-first. They part company on what to do when the thing being claimed
is already taken:

- `locate` **refuses**. A field whose best control is claimed is reported
  `ambiguous` and nothing is written.
- `enrich` **falls through** to the control's next-best unclaimed field, which
  still has to clear `MIN_SCORE` and the tie check on its own.

The case for leaving them different is that the stakes are not symmetric. A
refusal in `locate` is a blank the doctor writes by hand; a refusal in `enrich`
only means a control is answered from the page's own wording instead of the
schema's, which is the documented weaker-but-safe direction. On that reading
`enrich` should stay permissive, because the fall-through is independently
evidenced — the second field cleared the same bar the first one did.

The case for making them the same is that a wrong `description` is the one
error nothing downstream can catch. A mislocated *value* is visible in review
next to the question it landed under; a wrong instruction produces a
plausible-looking answer to a question the doctor is not being shown, and the
review screen renders it exactly like a right one. That argues `enrich` should
refuse too.

**What would settle it: the ClaimEZ dump.** The disagreement only bites on a
page carrying two controls that ask a similar question, and nobody knows yet
whether the real form does. If it does not, this is theory. If it does — a
"Ward class" in the admission block and another in the requested-fees block,
say — the dump shows the actual labels and the answer stops being a preference.

Related and still open elsewhere: whether a step hidden behind `display:none`
should be fillable (`isFillable` checks `disabled` and `readOnly`, not
visibility) — see "All three are still gated on the same thing". Same shape of
question, same thing unblocks it.

**How to tell a grid-layout question row from a repeating-entry opener
(2026-08-15).** Both open with a bare element holding text, so `hasDelimiter`
calls both an entry — see the trap of that name for what it costs, which on a
wholly grid-laid-out form is every demographic control refusing to fill. This
is listed here rather than fixed because every candidate discriminator trades
one false-positive class for another, and choosing between them from a verbal
description of ClaimEZ is how the wrong one gets locked in. **Three open
questions now wait on the same dump**; this is the third.
